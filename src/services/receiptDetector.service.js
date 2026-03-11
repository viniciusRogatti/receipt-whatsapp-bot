const { findBestTargetMatch } = require('../utils/matching');
const { truncateText } = require('../utils/textNormalization');
const { FIELD_SPECS } = require('./receiptPipeline/receiptConstants');
const { buildEvidenceDocuments } = require('./receiptPipeline/receiptEvidence.service');

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const DATE_VALUE_REGEX = /\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/;
const FIELD_ROLE_HINTS = {
  dataRecebimento: ['data', 'recebimento', 'date', 'label'],
  issuerHeader: ['recebemos', 'header', 'cabecalho', 'issuer'],
  nfe: ['nfe', 'invoice', 'nf_block', 'nf'],
};

const buildFieldMatch = (fieldKey, fieldSpec, documents) => {
  let bestResult = {
    key: fieldKey,
    label: fieldSpec.label,
    found: false,
    confidence: 0,
    method: 'no_match',
    matchedTarget: null,
    matchedText: '',
    sourceId: null,
    sourceLabel: null,
    sourceType: null,
    regionId: null,
    targetRole: null,
    reasons: [],
  };

  for (const document of documents) {
    const match = findBestTargetMatch({
      rawText: document.textRaw || document.textNormalized,
      targets: fieldSpec.aliases,
      minConfidence: 0,
      fuzzyWeights: fieldKey === 'dataRecebimento'
        ? { tokenWeight: 0.58, stringWeight: 0.42 }
        : null,
    });

    if (!match.matchedText && !match.confidence) continue;

    const regionBoost = fieldSpec.expectedRegionIds.includes(document.regionId)
      ? 0.14
      : document.regionId
        ? -0.05
        : 0.02;
    const fieldFocusBoost = Array.isArray(document.fieldKeys) && document.fieldKeys.includes(fieldKey)
      ? 0.1
      : 0;
    const roleBoost = document.targetRole && FIELD_ROLE_HINTS[fieldKey].some(
      (hint) => document.targetRole.indexOf(hint) >= 0,
    )
      ? 0.05
      : 0;
    const exactBoost = match.method === 'exact_inclusion' ? 0.08 : 0;
    const fuzzyLabelBoost = fieldKey === 'dataRecebimento' && match.method !== 'exact_inclusion'
      ? 0.03
      : 0;
    const datePatternBoost = fieldKey === 'dataRecebimento' && DATE_VALUE_REGEX.test(document.textRaw || '')
      ? 0.08
      : 0;
    const ocrConfidenceBoost = Math.min(0.12, Number(document.confidence || 0) / 1000);
    const confidence = Number(clamp01(
      (match.confidence * 0.72)
      + regionBoost
      + fieldFocusBoost
      + roleBoost
      + exactBoost
      + fuzzyLabelBoost
      + datePatternBoost
      + ocrConfidenceBoost,
    ).toFixed(2));

    if (confidence > bestResult.confidence) {
      const reasons = [];
      if (fieldSpec.expectedRegionIds.includes(document.regionId)) reasons.push('regiao_esperada');
          if (fieldFocusBoost) reasons.push('recorte_especifico');
          if (exactBoost) reasons.push('texto_exato');
          if (fuzzyLabelBoost) reasons.push('fuzzy_label_data');
          if (datePatternBoost) reasons.push('data_manuscrita_detectada');
          if (Number(document.confidence || 0) >= 55) reasons.push('ocr_estavel');

      bestResult = {
        key: fieldKey,
        label: fieldSpec.label,
        found: confidence >= fieldSpec.acceptanceThreshold,
        confidence,
        method: match.method,
        matchedTarget: match.matchedTarget,
        matchedText: truncateText(match.matchedText, 180),
        sourceId: document.id,
        sourceLabel: document.label,
        sourceType: document.sourceType,
        regionId: document.regionId,
        targetRole: document.targetRole,
        reasons,
      };
    }
  }

  return bestResult;
};

module.exports = {
  buildDocuments(payload = {}) {
    return buildEvidenceDocuments(payload);
  },

  async detectRequiredFields(payload = {}) {
    const documents = buildEvidenceDocuments(payload);
    const requiredFields = {};
    let detectedCount = 0;

    Object.keys(FIELD_SPECS).forEach((fieldKey) => {
      const fieldResult = buildFieldMatch(fieldKey, FIELD_SPECS[fieldKey], documents);

      if (fieldResult.found) detectedCount += 1;
      requiredFields[fieldKey] = fieldResult;
    });

    return {
      requiredFields,
      summary: {
        documentsConsidered: documents.length,
        detectedCount,
        missingFields: Object.keys(requiredFields).filter((fieldKey) => !requiredFields[fieldKey].found),
      },
      documents,
    };
  },
};
