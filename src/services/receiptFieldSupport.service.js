const path = require('path');
const env = require('../config/env');
const imagePreprocessService = require('./imagePreprocess.service');
const ocrService = require('./ocr.service');
const {
  expandVariantIdsForDocumentFocus,
} = require('../utils/variantRelation');

const FIELD_REGION_DEFINITIONS = [
  {
    id: 'receipt_header_primary',
    label: 'Cabecalho do canhoto',
    box: { x: 0.0, y: 0.44, width: 0.82, height: 0.24 },
  },
  {
    id: 'receipt_header_tight',
    label: 'Cabecalho do canhoto compacto',
    box: { x: 0.0, y: 0.5, width: 0.78, height: 0.18 },
  },
];

module.exports = {
  FIELD_REGION_DEFINITIONS,

  async buildFieldSupportDocuments({ preprocess, fullOcr }) {
    if (!preprocess || !fullOcr || !Array.isArray(fullOcr.results) || !fullOcr.results.length) {
      return [];
    }

    const rankedVariantIds = fullOcr.results
      .slice()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .map((result) => result.targetId);
    const availableVariantIds = (preprocess.variants || []).map((variant) => variant.id);
    const selectedVariantIds = expandVariantIdsForDocumentFocus({
      variantIds: rankedVariantIds.slice(0, 1),
      availableVariantIds,
    });
    const regionOutputDir = path.join(preprocess.outputDir, 'field-regions');
    const regionTargets = [];

    for (const variantId of selectedVariantIds) {
      const sourceVariant = preprocess.variants.find((variant) => variant.id === variantId);
      if (!sourceVariant) continue;

      const regions = await imagePreprocessService.generateRegionVariants({
        sourceVariant,
        outputDir: regionOutputDir,
        regionDefinitions: FIELD_REGION_DEFINITIONS,
      });

      regions.forEach((region) => {
        regionTargets.push({
          id: region.id,
          label: region.label,
          filePath: region.filePath,
          sourceType: 'field_region',
          meta: {
            sourceVariantId: sourceVariant.id,
            regionId: region.meta.regionId,
            regionLabel: region.meta.regionLabel,
          },
        });
      });
    }

    if (!regionTargets.length) return [];

    const recognition = await ocrService.recognizeTargets(regionTargets, {
      language: env.ocrRegionLang,
      maxEdge: Math.max(env.ocrRegionMaxEdge, 1100),
      minEdge: Math.max(env.ocrRegionMinEdge, 1400),
      parameters: {
        tessedit_pageseg_mode: '6',
      },
    });

    return recognition.results.map((result) => ({
      id: result.targetId,
      label: result.label,
      confidence: result.confidence,
      sourceType: result.sourceType,
      textRaw: result.textRaw,
      textNormalized: result.textNormalized,
      filePath: result.filePath,
      meta: result.meta,
    }));
  },
};
