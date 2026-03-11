const path = require('path');
const env = require('../../config/env');
const {
  RECEIPT_FIELD_KEYS,
} = require('../../config/receiptProfiles');
const ocrService = require('../ocr.service');
const receiptRoiOcrService = require('./receiptRoiOcr.service');
const {
  ANALYSIS_REGION_DEFINITIONS,
  GLOBAL_OCR_PLAN,
  REGION_OCR_PLAN,
} = require('./receiptConstants');
const {
  buildEvidenceDocuments,
  summarizeDocuments,
} = require('./receiptEvidence.service');

const REGION_MAP = ANALYSIS_REGION_DEFINITIONS.reduce((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {});
const FAST_REGION_OCR_STEP_IDS = new Set([
  'header_gray',
  'date_adaptive',
  'nf_block_adaptive',
]);

const resolveOrientationId = (preprocess, orientationProbe) => (
  orientationProbe.bestOrientationId
  || (preprocess.orientationCandidates[0] && preprocess.orientationCandidates[0].id)
  || 'upright'
);

const listSelectedVariants = (preprocess, orientationId) => (preprocess.variants || [])
  .filter((variant) => variant.orientationId === orientationId)
  .map((variant) => ({
    id: variant.id,
    label: variant.label,
    profileId: variant.profileId,
    filePath: variant.filePath,
    alignment: variant.alignment || null,
  }));

const selectSourceVariants = (preprocess, orientationId) => (preprocess.variants || [])
  .filter((variant) => variant.orientationId === orientationId);

const buildGlobalTargets = ({ preprocess, orientationId }) => {
  const sourceVariants = selectSourceVariants(preprocess, orientationId);

  return GLOBAL_OCR_PLAN
    .map((step) => {
      const variant = sourceVariants.find((item) => item.profileId === step.sourceProfileId);
      if (!variant) return null;

      return {
        id: variant.id,
        label: variant.label,
        filePath: variant.filePath,
        sourceType: step.sourceType,
        parameters: step.parameters,
        meta: {
          orientationId,
          regionId: 'global_support',
          regionLabel: 'Documento alinhado mascarado',
          fieldKeys: [
            RECEIPT_FIELD_KEYS.dataRecebimento,
            RECEIPT_FIELD_KEYS.issuerHeader,
            RECEIPT_FIELD_KEYS.nfe,
          ],
          sourceVariantId: variant.id,
          variantProfileId: variant.profileId,
          targetRole: step.targetRole,
          psm: step.parameters && step.parameters.tessedit_pageseg_mode
            ? step.parameters.tessedit_pageseg_mode
            : null,
        },
      };
    })
    .filter(Boolean);
};

module.exports = {
  async runGlobalSupportOcr({ preprocess, orientationProbe, fastMode = false }) {
    const orientationId = resolveOrientationId(preprocess, orientationProbe);
    if (fastMode) {
      return {
        orientationId,
        fullOcr: {
          attempted: false,
          language: env.ocrFullLang,
          totalTargets: 0,
          results: [],
          bestTargetId: null,
          bestConfidence: 0,
          bestScore: 0,
          bestResult: null,
          bestTextRaw: '',
          bestTextNormalized: '',
        },
        selectedVariants: listSelectedVariants(preprocess, orientationId),
      };
    }

    const globalTargets = buildGlobalTargets({ preprocess, orientationId });
    const fullOcr = await ocrService.recognizeTargets(globalTargets, {
      language: env.ocrFullLang,
      maxEdge: Math.min(env.ocrFullMaxEdge, 1000),
    });

    return {
      orientationId,
      fullOcr,
      selectedVariants: listSelectedVariants(preprocess, orientationId),
    };
  },

  async runRegionOcr({ preprocess, orientationProbe, fastMode = false }) {
    const orientationId = resolveOrientationId(preprocess, orientationProbe);
    const regionOutputDir = path.join(preprocess.outputDir, 'structured-regions');
    const sourceVariants = selectSourceVariants(preprocess, orientationId);
    const activePlan = fastMode
      ? REGION_OCR_PLAN.filter((step) => FAST_REGION_OCR_STEP_IDS.has(step.id))
      : REGION_OCR_PLAN;
    const regionTargets = await receiptRoiOcrService.buildRegionOcrTargets({
      sourceVariants,
      plan: activePlan,
      regionMap: REGION_MAP,
      outputDir: regionOutputDir,
      fastMode,
    });
    const regionOcr = await ocrService.recognizeTargets(regionTargets, {
      language: env.ocrRegionLang,
      maxEdge: fastMode
        ? Math.min(env.ocrRegionMaxEdge, 1100)
        : Math.min(env.ocrRegionMaxEdge, 1400),
      minEdge: fastMode
        ? Math.min(env.ocrRegionMinEdge, 900)
        : env.ocrRegionMinEdge,
    });

    return {
      orientationId,
      analyzedRegions: regionTargets.map((target) => ({
        id: target.id,
        label: target.label,
        filePath: target.filePath,
        regionId: target.meta.regionId,
        regionLabel: target.meta.regionLabel,
        targetRole: target.meta.targetRole,
        sourceVariantId: target.meta.sourceVariantId,
        variantProfileId: target.meta.variantProfileId,
        roiProfileId: target.meta.roiProfileId,
        roiWidth: target.meta.roiWidth,
        roiHeight: target.meta.roiHeight,
      })),
      regionOcr,
      selectedVariants: listSelectedVariants(preprocess, orientationId),
    };
  },

  buildStructuredOcrResult({ preprocess, orientationProbe, fullOcr, regionOcr, analyzedRegions }) {
    const orientationId = resolveOrientationId(preprocess, orientationProbe);

    return {
      orientationId,
      bestVariantId: orientationProbe.bestVariantId || null,
      selectedVariants: listSelectedVariants(preprocess, orientationId),
      analyzedRegions: analyzedRegions || [],
      fullOcr,
      regionOcr,
      documents: buildEvidenceDocuments({
        fullOcr,
        regionOcr,
      }),
      debug: {
        globalTargets: summarizeDocuments(buildEvidenceDocuments({
          fullOcr,
        })),
        regionTargets: summarizeDocuments(buildEvidenceDocuments({
          regionOcr,
        })),
      },
    };
  },
};
