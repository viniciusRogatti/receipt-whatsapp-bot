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
const MIN_TRUSTED_NF_ANCHOR_SCORE = 0.6;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const persistImage = async (image, filePath) => {
  await ensureDir(path.dirname(filePath));
  await image.getBufferAsync(Jimp.MIME_PNG).then((buffer) => fs.promises.writeFile(filePath, buffer));
  return filePath;
};

const expandPixelBox = (sourceImage, box, paddingXRatio = 0.1, paddingYRatio = 0.08) => {
  const paddingX = Math.max(4, Math.floor(box.width * paddingXRatio));
  const paddingY = Math.max(4, Math.floor(box.height * paddingYRatio));
  const x = clamp(box.x - paddingX, 0, Math.max(0, sourceImage.bitmap.width - 2));
  const y = clamp(box.y - paddingY, 0, Math.max(0, sourceImage.bitmap.height - 2));
  const width = clamp(box.width + (paddingX * 2), 2, sourceImage.bitmap.width - x);
  const height = clamp(box.height + (paddingY * 2), 2, sourceImage.bitmap.height - y);

  return { x, y, width, height };
};

const buildTemplateFixedPixelBox = ({ sourceImage, requestedDefinition }) => {
  const baseBox = receiptTemplateService.buildPixelBox(sourceImage, requestedDefinition.box);
  const expansionByRoi = {
    nf_block: { paddingXRatio: 0.14, paddingYRatio: 0.08 },
    nf_number_line: { paddingXRatio: 0.4, paddingYRatio: 0.28 },
    nf_number_tight: { paddingXRatio: 0.48, paddingYRatio: 0.24 },
    nf_header: { paddingXRatio: 0.3, paddingYRatio: 0.24 },
    nf_series_line: { paddingXRatio: 0.26, paddingYRatio: 0.22 },
    nf_block_wide: { paddingXRatio: 0.1, paddingYRatio: 0.08 },
  };
  const expansion = expansionByRoi[requestedDefinition.id] || { paddingXRatio: 0.1, paddingYRatio: 0.08 };

  return expandPixelBox(
    sourceImage,
    baseBox,
    expansion.paddingXRatio,
    expansion.paddingYRatio,
  );
};

const isBoxLargeEnough = (box, requestedDefinition) => (
  box.width >= Number(requestedDefinition.minWidth || 0)
  && box.height >= Number(requestedDefinition.minHeight || 0)
);

const resolvePixelBox = ({ sourceImage, requestedDefinition, sourceVariant }) => {
  const nfAnchor = sourceVariant
    && sourceVariant.alignment
    && sourceVariant.alignment.nfAnchor
    && sourceVariant.alignment.nfAnchor.detected
    && Number(sourceVariant.alignment.nfAnchor.score || 0) >= MIN_TRUSTED_NF_ANCHOR_SCORE
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
    box: buildTemplateFixedPixelBox({ sourceImage, requestedDefinition }),
    layoutStrategy: 'template_fixed_safe',
    anchorScore: null,
  };
};

const resolveCropDefinition = ({ sourceImage, requestedDefinition, sourceVariant, visited = [] }) => {
  const anchoredOrFixedPixelBox = resolvePixelBox({
    sourceImage,
    requestedDefinition,
    sourceVariant,
  });
  let resolvedPixelBox = anchoredOrFixedPixelBox;

  if (
    anchoredOrFixedPixelBox.layoutStrategy === 'nf_anchor'
    && !isBoxLargeEnough(anchoredOrFixedPixelBox.box, requestedDefinition)
  ) {
    const templateFixedPixelBox = {
      box: buildTemplateFixedPixelBox({ sourceImage, requestedDefinition }),
      layoutStrategy: 'template_fixed_safe',
      anchorScore: null,
    };

    if (isBoxLargeEnough(templateFixedPixelBox.box, requestedDefinition)) {
      resolvedPixelBox = templateFixedPixelBox;
    }
  }

  const box = resolvedPixelBox.box;
  const tooSmall = !isBoxLargeEnough(box, requestedDefinition);

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
