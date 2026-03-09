const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const imagePreprocessService = require('../imagePreprocess.service');
const { ensureDir } = require('../../utils/file');
const receiptTemplateService = require('./receiptTemplate.service');

const SHARPEN_KERNEL = [
  [0, -1, 0],
  [-1, 5, -1],
  [0, -1, 0],
];

const ROI_PROFILE_DEFINITIONS = {
  label_gray_2x: {
    id: 'label_gray_2x',
    scale: 2,
    apply: (image) => imagePreprocessService
      .adaptiveContrastNormalize(image.greyscale().normalize())
      .contrast(0.26)
      .convolute(SHARPEN_KERNEL),
  },
  label_adaptive_3x: {
    id: 'label_adaptive_3x',
    scale: 3,
    apply: (image) => imagePreprocessService.morphologyClose(
      imagePreprocessService.adaptiveThresholdImage(
        imagePreprocessService.adaptiveContrastNormalize(image.greyscale().normalize()).contrast(0.32),
        8,
        6,
      ),
    ),
  },
  nf_context_gray_2x: {
    id: 'nf_context_gray_2x',
    scale: 2,
    apply: (image) => imagePreprocessService
      .adaptiveContrastNormalize(image.greyscale().normalize())
      .contrast(0.34)
      .convolute(SHARPEN_KERNEL),
  },
  nf_context_adaptive_3x: {
    id: 'nf_context_adaptive_3x',
    scale: 3,
    apply: (image) => imagePreprocessService.morphologyClose(
      imagePreprocessService.adaptiveThresholdImage(
        imagePreprocessService.adaptiveContrastNormalize(image.greyscale().normalize()).contrast(0.36),
        9,
        8,
      ),
    ),
  },
  nf_digits_line_3x: {
    id: 'nf_digits_line_3x',
    scale: 3,
    apply: (image) => imagePreprocessService.thresholdImage(
      imagePreprocessService
        .adaptiveContrastNormalize(image.greyscale().normalize())
        .contrast(0.5)
        .convolute(SHARPEN_KERNEL),
      172,
    ),
  },
  nf_digits_threshold_4x: {
    id: 'nf_digits_threshold_4x',
    scale: 4,
    apply: (image) => imagePreprocessService.morphologyClose(
      imagePreprocessService.thresholdImage(
        imagePreprocessService
          .adaptiveContrastNormalize(image.greyscale().normalize())
          .contrast(0.52)
          .convolute(SHARPEN_KERNEL),
        168,
      ),
    ),
  },
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const persistImage = async (image, filePath) => {
  await ensureDir(path.dirname(filePath));
  await image.getBufferAsync(Jimp.MIME_PNG).then((buffer) => fs.promises.writeFile(filePath, buffer));
  return filePath;
};

const buildRelativeCropBox = (sourceImage, cropBox) => {
  if (!cropBox) return null;

  const x = clamp(
    Math.floor(sourceImage.bitmap.width * Number(cropBox.x || 0)),
    0,
    Math.max(0, sourceImage.bitmap.width - 2),
  );
  const y = clamp(
    Math.floor(sourceImage.bitmap.height * Number(cropBox.y || 0)),
    0,
    Math.max(0, sourceImage.bitmap.height - 2),
  );
  const width = clamp(
    Math.floor(sourceImage.bitmap.width * Number(cropBox.width || 1)),
    2,
    sourceImage.bitmap.width - x,
  );
  const height = clamp(
    Math.floor(sourceImage.bitmap.height * Number(cropBox.height || 1)),
    2,
    sourceImage.bitmap.height - y,
  );

  return { x, y, width, height };
};

const buildPixelCropBox = (sourceImage, pixelBox) => ({
  x: clamp(Math.floor(pixelBox.x), 0, Math.max(0, sourceImage.bitmap.width - 2)),
  y: clamp(Math.floor(pixelBox.y), 0, Math.max(0, sourceImage.bitmap.height - 2)),
  width: clamp(Math.floor(pixelBox.width), 2, sourceImage.bitmap.width - Math.floor(pixelBox.x)),
  height: clamp(Math.floor(pixelBox.height), 2, sourceImage.bitmap.height - Math.floor(pixelBox.y)),
});

const preprocessRoi = (image, profileId, { fastMode = false } = {}) => {
  const profile = ROI_PROFILE_DEFINITIONS[profileId] || ROI_PROFILE_DEFINITIONS.label_gray_2x;
  const prepared = image.clone();
  const scale = fastMode ? Math.min(Number(profile.scale || 1), 2) : Number(profile.scale || 1);

  if (scale && scale !== 1) {
    prepared.scale(scale);
  }

  return profile.apply(prepared);
};

module.exports = {
  ROI_PROFILE_DEFINITIONS,
  preprocessRoi,

  async buildRegionOcrTargets({
    sourceVariants = [],
    plan = [],
    regionMap = {},
    outputDir,
    fastMode = false,
  }) {
    await ensureDir(outputDir);
    const targets = [];

    for (const step of plan) {
      const sourceVariant = sourceVariants.find((variant) => variant.profileId === step.sourceProfileId);
      const regionDefinition = regionMap[step.regionId];

      if (!sourceVariant || !regionDefinition) continue;

      const sourceImage = await Jimp.read(sourceVariant.filePath);
      const defaultPixelBox = receiptTemplateService.buildPixelBox(sourceImage, regionDefinition.box);
      const cropCandidates = [{
        suffix: '',
        pixelBox: defaultPixelBox,
        anchorStrategy: null,
      }];
      const nfAnchor = sourceVariant.alignment && sourceVariant.alignment.nfAnchor;

      if (nfAnchor && nfAnchor.detected && regionDefinition.id !== 'roi_signature') {
        const anchoredPixelBox = receiptTemplateService.buildAnchoredPixelBox(
          sourceImage,
          regionDefinition.box,
          nfAnchor,
        );
        const offsetMagnitude = Math.abs(anchoredPixelBox.x - defaultPixelBox.x)
          + Math.abs(anchoredPixelBox.y - defaultPixelBox.y)
          + Math.abs(anchoredPixelBox.width - defaultPixelBox.width)
          + Math.abs(anchoredPixelBox.height - defaultPixelBox.height);
        if (offsetMagnitude >= 6) {
          cropCandidates.push({
            suffix: '__nf_anchor',
            pixelBox: anchoredPixelBox,
            anchorStrategy: 'nf_anchor',
          });
        }
      }

      for (const cropCandidate of cropCandidates) {
        const pixelBox = buildPixelCropBox(sourceImage, cropCandidate.pixelBox);
        const roiImage = preprocessRoi(
          sourceImage.clone().crop(pixelBox.x, pixelBox.y, pixelBox.width, pixelBox.height),
          step.roiProfileId,
          { fastMode },
        );
        const targetId = `${sourceVariant.id}__${step.id}${cropCandidate.suffix}`;
        const filePath = await persistImage(roiImage, path.join(outputDir, `${targetId}.png`));

        targets.push({
          id: targetId,
          label: `${regionDefinition.label} [${sourceVariant.label}]${cropCandidate.anchorStrategy ? ' [ancora NF]' : ''}`,
          filePath,
          sourceType: step.sourceType,
          parameters: step.parameters,
          meta: {
            orientationId: sourceVariant.orientationId,
            regionId: regionDefinition.id,
            regionLabel: regionDefinition.label,
            fieldKeys: regionDefinition.fieldKeys || [],
            sourceVariantId: sourceVariant.id,
            variantProfileId: sourceVariant.profileId,
            targetRole: step.targetRole,
            roiProfileId: step.roiProfileId,
            roiWidth: roiImage.bitmap.width,
            roiHeight: roiImage.bitmap.height,
            roiBox: regionDefinition.box,
            roiPixelBox: pixelBox,
            anchorStrategy: cropCandidate.anchorStrategy,
            anchorScore: nfAnchor && nfAnchor.detected ? nfAnchor.score : null,
            psm: step.parameters && step.parameters.tessedit_pageseg_mode
              ? step.parameters.tessedit_pageseg_mode
              : null,
          },
        });
      }
    }

    return targets;
  },

  async buildRoiTargets({
    rois = [],
    plan = [],
    outputDir,
    fastMode = false,
  }) {
    await ensureDir(outputDir);
    const targets = [];

    for (const roi of rois) {
      const roiImage = await Jimp.read(roi.filePath);

      for (const step of plan) {
        if (!step.roiIds.includes(roi.roiId)) continue;

        let sourceCrop = roiImage.clone();
        const cropBox = buildRelativeCropBox(sourceCrop, step.cropBox);
        if (cropBox) {
          sourceCrop = sourceCrop.crop(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
        }
        const prepared = preprocessRoi(sourceCrop, step.roiProfileId, { fastMode });
        const targetId = `${roi.id}__${step.id}`;
        const filePath = await persistImage(prepared, path.join(outputDir, `${targetId}.png`));

        targets.push({
          id: targetId,
          label: `${roi.label} [${step.id}]`,
          filePath,
          sourceType: step.sourceType,
          parameters: step.parameters,
          meta: {
            orientationId: roi.orientationId,
            regionId: roi.roiId,
            regionLabel: roi.label,
            fieldKeys: ['nfe'],
            sourceVariantId: roi.sourceVariantId,
            variantProfileId: roi.variantProfileId,
            targetRole: step.targetRole,
            roiProfileId: step.roiProfileId,
            requestedRoiId: roi.requestedRoiId,
            roiId: roi.roiId,
            roiWidth: prepared.bitmap.width,
            roiHeight: prepared.bitmap.height,
            roiBox: roi.roiBox,
            layoutStrategy: roi.layoutStrategy || null,
            usedFallback: roi.usedFallback || false,
            fallbackChain: roi.fallbackChain || [],
            transformId: roi.transformId || null,
            phase: roi.phase || null,
            psm: step.parameters && step.parameters.tessedit_pageseg_mode
              ? step.parameters.tessedit_pageseg_mode
              : null,
          },
        });
      }
    }

    return targets;
  },
};
