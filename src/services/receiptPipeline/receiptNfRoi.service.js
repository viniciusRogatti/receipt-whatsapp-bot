const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { ensureDir } = require('../../utils/file');
const {
  NF_ROI_DEFINITIONS,
} = require('./receiptConstants');
const receiptTemplateService = require('./receiptTemplate.service');
const receiptRoiOcrService = require('./receiptRoiOcr.service');

const ROI_MAP = NF_ROI_DEFINITIONS.reduce((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {});

const persistImage = async (image, filePath) => {
  await ensureDir(path.dirname(filePath));
  await image.getBufferAsync(Jimp.MIME_PNG).then((buffer) => fs.promises.writeFile(filePath, buffer));
  return filePath;
};

const resolvePixelBox = ({ sourceImage, requestedDefinition, sourceVariant }) => {
  const nfAnchor = sourceVariant
    && sourceVariant.alignment
    && sourceVariant.alignment.nfAnchor
    && sourceVariant.alignment.nfAnchor.detected
      ? sourceVariant.alignment.nfAnchor
      : null;
  if (nfAnchor) {
    return {
      box: receiptTemplateService.buildAnchoredPixelBox(sourceImage, requestedDefinition.box, nfAnchor),
      layoutStrategy: 'nf_anchor',
      anchorScore: nfAnchor.score,
    };
  }

  return {
    box: receiptTemplateService.buildPixelBox(sourceImage, requestedDefinition.box),
    layoutStrategy: 'template_fixed',
    anchorScore: null,
  };
};

const resolveCropDefinition = ({ sourceImage, requestedDefinition, sourceVariant, visited = [] }) => {
  const resolvedPixelBox = resolvePixelBox({
    sourceImage,
    requestedDefinition,
    sourceVariant,
  });
  const box = resolvedPixelBox.box;
  const tooSmall = (
    box.width < Number(requestedDefinition.minWidth || 0)
    || box.height < Number(requestedDefinition.minHeight || 0)
  );

  if (!tooSmall || !requestedDefinition.fallbackRoiId) {
    return {
      definition: requestedDefinition,
      box,
      layoutStrategy: resolvedPixelBox.layoutStrategy,
      anchorScore: resolvedPixelBox.anchorScore,
      usedFallback: visited.length > 0,
      requestedRoiId: visited[0] || requestedDefinition.id,
      fallbackChain: visited.concat(requestedDefinition.id),
    };
  }

  const fallbackDefinition = ROI_MAP[requestedDefinition.fallbackRoiId];
  if (!fallbackDefinition || visited.includes(fallbackDefinition.id)) {
    return {
      definition: requestedDefinition,
      box,
      usedFallback: visited.length > 0,
      requestedRoiId: visited[0] || requestedDefinition.id,
      fallbackChain: visited.concat(requestedDefinition.id),
    };
  }

  return resolveCropDefinition({
    sourceImage,
    requestedDefinition: fallbackDefinition,
    sourceVariant,
    visited: visited.concat(requestedDefinition.id),
  });
};

module.exports = {
  async generateNfRois({ sourceVariants = [], outputDir, phase = 'primary' }) {
    await ensureDir(outputDir);
    const requestedDefinitions = NF_ROI_DEFINITIONS.filter((definition) => (
      phase === 'fallback'
        ? definition.phase === 'fallback'
        : definition.phase === 'primary'
    ));
    const rois = [];

    for (const sourceVariant of sourceVariants) {
      const sourceImage = await Jimp.read(sourceVariant.filePath);

      for (const requestedDefinition of requestedDefinitions) {
        const resolved = resolveCropDefinition({
          sourceImage,
          requestedDefinition,
          sourceVariant,
        });
        const roiImage = sourceImage
          .clone()
          .crop(resolved.box.x, resolved.box.y, resolved.box.width, resolved.box.height);
        const roiId = `${sourceVariant.id}__${requestedDefinition.id}`;
        const filePath = await persistImage(roiImage, path.join(outputDir, `${roiId}.png`));

        rois.push({
          id: roiId,
          label: requestedDefinition.label,
          filePath,
          sourceVariantId: sourceVariant.id,
          variantProfileId: sourceVariant.profileId,
          orientationId: sourceVariant.orientationId,
          requestedRoiId: requestedDefinition.id,
          roiId: resolved.definition.id,
          usedFallback: resolved.usedFallback,
          fallbackChain: resolved.fallbackChain,
          layoutStrategy: resolved.layoutStrategy,
          anchorScore: resolved.anchorScore,
          width: roiImage.bitmap.width,
          height: roiImage.bitmap.height,
          roiBox: resolved.definition.box,
          phase,
        });
      }
    }

    return rois;
  },

  async buildNfRoiTargets({ rois = [], plan = [], outputDir, fastMode = false }) {
    return receiptRoiOcrService.buildRoiTargets({
      rois,
      plan,
      outputDir,
      fastMode,
    });
  },
};
