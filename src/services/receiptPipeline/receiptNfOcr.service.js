const path = require('path');
const env = require('../../config/env');
const ocrService = require('../ocr.service');
const {
  NF_ROI_CONFIRM_PLAN,
  NF_ROI_FALLBACK_PLAN,
  NF_ROI_PRIMARY_PLAN,
} = require('./receiptConstants');
const receiptNfRoiService = require('./receiptNfRoi.service');

const resolveOrientationId = (preprocess, orientationProbe) => (
  orientationProbe.bestOrientationId
  || (preprocess.orientationCandidates[0] && preprocess.orientationCandidates[0].id)
  || 'upright'
);

const listOrientationIdsForNf = ({ preprocess, orientationProbe, limit = 3 }) => {
  const ranked = Array.isArray(orientationProbe.results)
    ? orientationProbe.results.map((item) => item.orientationId)
    : [];
  const available = (preprocess.orientationCandidates || []).map((candidate) => candidate.id);
  const ordered = ranked.concat(available);
  const unique = [];

  ordered.forEach((orientationId) => {
    if (!orientationId || unique.includes(orientationId)) return;
    unique.push(orientationId);
  });

  return unique.slice(0, Math.max(1, limit));
};

const findVariant = (preprocess, orientationId, profileId) => (
  (preprocess.variants || []).find((variant) => (
    variant.orientationId === orientationId && variant.profileId === profileId
  ))
);

const selectSourceVariants = ({ preprocess, orientationProbe, phase, fastMode = false }) => {
  const variants = [];
  const seen = new Set();
  const orientationIds = listOrientationIdsForNf({
    preprocess,
    orientationProbe,
    limit: fastMode ? 1 : phase === 'primary' ? 3 : 2,
  });

  orientationIds.forEach((orientationId) => {
    const grayVariant = findVariant(preprocess, orientationId, 'document_gray');
    if (grayVariant && !seen.has(grayVariant.id)) {
      seen.add(grayVariant.id);
      variants.push(grayVariant);
    }

    if (phase === 'primary' && orientationId === resolveOrientationId(preprocess, orientationProbe)) {
      const binaryVariant = findVariant(preprocess, orientationId, 'document_binary');
      if (binaryVariant && !seen.has(binaryVariant.id)) {
        seen.add(binaryVariant.id);
        variants.push(binaryVariant);
      }
    }
  });

  if (phase === 'fallback') {
    const bestOrientationId = resolveOrientationId(preprocess, orientationProbe);
    const binaryVariant = findVariant(preprocess, bestOrientationId, 'document_binary');
    if (binaryVariant && !seen.has(binaryVariant.id)) {
      seen.add(binaryVariant.id);
      variants.push(binaryVariant);
    }
  }

  return variants;
};

const buildPhaseSummary = ({ phase, rois, recognition }) => ({
  phase,
  attempted: !!recognition.attempted,
  totalRois: rois.length,
  totalTargets: recognition.totalTargets || 0,
  rois: rois.map((roi) => ({
    id: roi.id,
    requestedRoiId: roi.requestedRoiId,
    roiId: roi.roiId,
    label: roi.label,
    width: roi.width,
    height: roi.height,
    usedFallback: roi.usedFallback,
    fallbackChain: roi.fallbackChain,
    sourceVariantId: roi.sourceVariantId,
    filePath: roi.filePath,
    phase: roi.phase,
  })),
  results: (recognition.results || []).map((result) => ({
    targetId: result.targetId,
    label: result.label,
    sourceType: result.sourceType,
    confidence: result.confidence,
    score: result.score,
    textRaw: result.textRaw,
    textNormalized: result.textNormalized,
    textPreview: result.textPreview,
    filePath: result.filePath,
    meta: result.meta,
  })),
});

const buildRecognitionResultList = async (targets = [], repeatCount = 1) => {
  const results = [];

  for (const target of targets) {
    for (let attempt = 0; attempt < Math.max(1, repeatCount); attempt += 1) {
      const recognition = await ocrService.recognizeTargets([target], {
        language: env.ocrRegionLang,
        maxEdge: 1600,
      });
      if (recognition.results && recognition.results[0]) {
        const result = recognition.results[0];
        if (repeatCount > 1) {
          results.push(Object.assign({}, result, {
            targetId: `${result.targetId}__confirm_${attempt + 1}`,
            meta: Object.assign({}, result.meta, {
              confirmAttempt: attempt + 1,
            }),
          }));
        } else {
          results.push(result);
        }
      }
    }
  }

  const ranked = results.slice().sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const best = ranked[0] || null;

  return {
    attempted: targets.length > 0,
    totalTargets: targets.length,
    results,
    bestTargetId: best ? best.targetId : null,
    bestConfidence: best ? best.confidence : null,
  };
};

module.exports = {
  async runNfRoiOcrPhase({
    preprocess,
    orientationProbe,
    phase = 'primary',
    planOverride = null,
    fastMode = false,
  }) {
    const sourceVariants = selectSourceVariants({
      preprocess,
      orientationProbe,
      phase,
      fastMode,
    });
    const phaseOutputDir = path.join(preprocess.outputDir, 'nf-rois');
    const rois = await receiptNfRoiService.generateNfRois({
      sourceVariants,
      outputDir: phaseOutputDir,
      phase,
    });
    const targets = await receiptNfRoiService.buildNfRoiTargets({
      rois,
      plan: planOverride || (phase === 'primary' ? NF_ROI_PRIMARY_PLAN : NF_ROI_FALLBACK_PLAN),
      outputDir: path.join(phaseOutputDir, phase),
      fastMode,
    });
    const recognition = await ocrService.recognizeTargets(targets, {
      language: env.ocrRegionLang,
      maxEdge: fastMode ? 1250 : 1600,
    });

    return buildPhaseSummary({
      phase,
      rois,
      recognition,
    });
  },

  async runNfPrecisionConfirmPhase({
    preprocess,
    orientationProbe,
    phase = 'primary',
    sourceVariantIds = [],
    fastMode = false,
  }) {
    const sourceVariants = selectSourceVariants({
      preprocess,
      orientationProbe,
      phase,
      fastMode,
    });
    const phaseOutputDir = path.join(preprocess.outputDir, 'nf-rois');
    const rois = await receiptNfRoiService.generateNfRois({
      sourceVariants,
      outputDir: phaseOutputDir,
      phase,
    });
    const filteredRois = rois.filter((roi) => {
      if (sourceVariantIds.length && !sourceVariantIds.includes(roi.sourceVariantId)) return false;
      return roi.requestedRoiId === 'nf_number_line' || roi.requestedRoiId === 'nf_number_tight';
    });
    const targets = await receiptNfRoiService.buildNfRoiTargets({
      rois: filteredRois,
      plan: NF_ROI_CONFIRM_PLAN,
      outputDir: path.join(phaseOutputDir, phase),
      fastMode,
    });
    const recognition = await buildRecognitionResultList(targets, fastMode ? 1 : 3);

    return buildPhaseSummary({
      phase: `${phase}_confirm`,
      rois: filteredRois,
      recognition,
    });
  },

  mergePhaseResults(...phaseItems) {
    const phases = phaseItems
      .flatMap((phase) => {
        if (!phase) return [];
        if (Array.isArray(phase.phases) && Array.isArray(phase.results) && Array.isArray(phase.rois)) {
          return phase.phases;
        }
        return [phase];
      })
      .filter(Boolean);
    const results = phases.reduce((accumulator, phase) => accumulator.concat(phase.results || []), []);
    const rois = phases.reduce((accumulator, phase) => accumulator.concat(phase.rois || []), []);
    const ranked = results.slice().sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    const best = ranked[0] || null;

    return {
      attempted: phases.some((phase) => phase.attempted),
      phases,
      totalRois: rois.length,
      totalTargets: results.length,
      rois,
      results,
      bestTargetId: best ? best.targetId : null,
      bestConfidence: best ? best.confidence : null,
    };
  },

  NF_ROI_CONFIRM_PLAN,
};
