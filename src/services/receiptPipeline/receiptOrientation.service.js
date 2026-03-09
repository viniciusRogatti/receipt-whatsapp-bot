const path = require('path');
const env = require('../../config/env');
const ocrService = require('../ocr.service');
const receiptDetectorService = require('../receiptDetector.service');
const nfExtractorService = require('../nfExtractor.service');
const receiptRoiOcrService = require('./receiptRoiOcr.service');
const receiptTemplateService = require('./receiptTemplate.service');
const {
  BUSINESS_THRESHOLDS,
  ORIENTATION_PRIMARY_PROBE_PLAN,
  ORIENTATION_PROBE_REGION_DEFINITIONS,
  ORIENTATION_SECONDARY_PROBE_PLAN,
} = require('./receiptConstants');
const {
  buildEvidenceDocuments,
  summarizeDocuments,
} = require('./receiptEvidence.service');

const REGION_MAP = ORIENTATION_PROBE_REGION_DEFINITIONS.reduce((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {});
const FAST_PRIMARY_PROBE_PLAN = ORIENTATION_PRIMARY_PROBE_PLAN.filter((step) => step.id !== 'orientation_header');

const findOrientationCandidate = (preprocess, orientationId) => (
  (preprocess.orientationCandidates || []).find((candidate) => candidate.id === orientationId)
);

const buildProbeTargets = async ({
  preprocess,
  orientationIds = [],
  plan = [],
  outputDir,
  fastMode = false,
}) => {
  let targets = [];

  for (const orientationId of orientationIds) {
    const sourceVariants = (preprocess.variants || [])
      .filter((variant) => variant.orientationId === orientationId);
    if (!sourceVariants.length) continue;

    const regionTargets = await receiptRoiOcrService.buildRegionOcrTargets({
      sourceVariants,
      plan,
      regionMap: REGION_MAP,
      outputDir: path.join(outputDir, orientationId),
      fastMode,
    });
    targets = targets.concat(regionTargets);
  }

  return targets;
};

const buildOrientationEvaluation = async ({ preprocess, orientationId, documents }) => {
  const detection = await receiptDetectorService.detectRequiredFields({
    documents,
  });
  const nfExtraction = await nfExtractorService.extractInvoiceNumber({
    documents,
  });
  const orientationCandidate = findOrientationCandidate(preprocess, orientationId);
  const templateScore = receiptTemplateService.scoreTemplateMatch({
    contour: orientationCandidate && orientationCandidate.alignment
      ? {
        geometryScore: orientationCandidate.alignment.geometryScore,
      }
      : {},
    requiredFields: detection.requiredFields,
    nfBlockDetected: !!(detection.requiredFields.nfe && detection.requiredFields.nfe.found),
  });
  const tieBreaker = Number(nfExtraction.confidence || 0) * 6;
  const totalScore = Number((templateScore.score + tieBreaker).toFixed(2));
  const primaryVariant = (preprocess.variants || []).find((variant) => (
    variant.orientationId === orientationId && variant.profileId === 'document_gray'
  ));

  return {
    orientationId,
    primaryVariantId: primaryVariant ? primaryVariant.id : null,
    primaryVariantLabel: primaryVariant ? primaryVariant.label : orientationId,
    score: totalScore,
    templateMatched: templateScore.templateMatched,
    requiredFields: detection.requiredFields,
    nfExtraction: {
      nf: nfExtraction.nf,
      confidence: nfExtraction.confidence,
      method: nfExtraction.method,
    },
    templateBreakdown: templateScore.breakdown,
    alignment: orientationCandidate ? orientationCandidate.alignment : null,
    documents: summarizeDocuments(documents),
  };
};

const evaluateOrientationResults = async ({ preprocess, ocrResults }) => {
  const documents = buildEvidenceDocuments({
    documents: ocrResults,
  });
  const grouped = documents.reduce((accumulator, document) => {
    const orientationId = document.orientationId || 'unknown';
    if (!accumulator[orientationId]) accumulator[orientationId] = [];
    accumulator[orientationId].push(document);
    return accumulator;
  }, {});
  const evaluations = [];

  for (const orientationId of Object.keys(grouped)) {
    evaluations.push(await buildOrientationEvaluation({
      preprocess,
      orientationId,
      documents: grouped[orientationId],
    }));
  }

  return evaluations.sort((left, right) => {
    if (right.templateMatched !== left.templateMatched) return right.templateMatched ? 1 : -1;
    if (right.score !== left.score) return right.score - left.score;
    return Number(right.nfExtraction.confidence || 0) - Number(left.nfExtraction.confidence || 0);
  });
};

const shouldRunSecondaryProbe = (results = [], { fastMode = false } = {}) => {
  const best = results[0];
  const runnerUp = results[1];

  if (!best) return true;
  if (fastMode) {
    if (best.score < BUSINESS_THRESHOLDS.orientationRetryScore - 8) return true;
    if (!best.templateMatched && Number(best.nfExtraction && best.nfExtraction.confidence || 0) < 0.7) return true;
    return false;
  }
  if (best.score < BUSINESS_THRESHOLDS.orientationRetryScore) return true;
  if (!best.templateMatched) return true;
  if (runnerUp && (best.score - runnerUp.score) < BUSINESS_THRESHOLDS.orientationTieGap) return true;
  return false;
};

module.exports = {
  async selectBestOrientation({ preprocess, fastMode = false }) {
    const orientationIds = (preprocess.orientationCandidates || []).map((candidate) => candidate.id);
    const probeOutputDir = path.join(preprocess.outputDir, 'orientation-probe');
    const primaryTargets = await buildProbeTargets({
      preprocess,
      orientationIds,
      plan: fastMode ? FAST_PRIMARY_PROBE_PLAN : ORIENTATION_PRIMARY_PROBE_PLAN,
      outputDir: probeOutputDir,
      fastMode,
    });
    const primaryOcr = await ocrService.recognizeTargets(primaryTargets, {
      language: env.ocrRegionLang,
      maxEdge: fastMode
        ? Math.min(env.ocrRegionMaxEdge, 1100)
        : Math.min(env.ocrRegionMaxEdge, 1400),
      minEdge: fastMode
        ? Math.min(env.ocrRegionMinEdge, 900)
        : env.ocrRegionMinEdge,
    });

    let mergedResults = primaryOcr.results || [];
    let evaluations = await evaluateOrientationResults({
      preprocess,
      ocrResults: mergedResults,
    });

    if (!fastMode && shouldRunSecondaryProbe(evaluations, { fastMode })) {
      const topOrientationIds = evaluations.slice(0, 2).map((item) => item.orientationId);
      const secondaryTargets = await buildProbeTargets({
        preprocess,
        orientationIds: topOrientationIds.length ? topOrientationIds : orientationIds.slice(0, 2),
        plan: ORIENTATION_SECONDARY_PROBE_PLAN,
        outputDir: probeOutputDir,
        fastMode,
      });
      const secondaryOcr = await ocrService.recognizeTargets(secondaryTargets, {
        language: env.ocrRegionLang,
        maxEdge: fastMode
          ? Math.min(env.ocrRegionMaxEdge, 1200)
          : Math.min(env.ocrRegionMaxEdge, 1500),
        minEdge: fastMode
          ? Math.min(env.ocrRegionMinEdge, 900)
          : env.ocrRegionMinEdge,
      });

      mergedResults = mergedResults.concat(secondaryOcr.results || []);
      evaluations = await evaluateOrientationResults({
        preprocess,
        ocrResults: mergedResults,
      });
    }

    const best = evaluations[0] || null;

    return {
      attempted: true,
      bestOrientationId: best ? best.orientationId : null,
      bestVariantId: best ? best.primaryVariantId : null,
      bestConfidence: best ? best.nfExtraction.confidence : null,
      bestScore: best ? best.score : null,
      bestVariantLabel: best ? best.primaryVariantLabel : null,
      templateMatched: best ? best.templateMatched : false,
      results: evaluations,
      rawProbeDocuments: summarizeDocuments(buildEvidenceDocuments({
        documents: mergedResults,
      })),
    };
  },
};
