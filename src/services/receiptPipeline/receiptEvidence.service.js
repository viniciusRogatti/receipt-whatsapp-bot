const {
  normalizeOcrNoise,
  splitNormalizedLines,
  stripAccents,
  toSearchableText,
  truncateText,
} = require('../../utils/textNormalization');

const normalizeDocument = (document = {}, fallbackId) => {
  const textRaw = String(document.textRaw || document.textNormalized || '');
  const textNormalized = normalizeOcrNoise(document.textNormalized || textRaw || '');
  const textSearch = stripAccents(textNormalized);
  const meta = document.meta || {};

  return {
    id: document.id || document.targetId || fallbackId,
    label: document.label || document.sourceLabel || document.id || fallbackId,
    confidence: Number(document.confidence || 0),
    sourceType: document.sourceType || 'document',
    filePath: document.filePath || null,
    textRaw,
    textNormalized,
    textSearch,
    textSearchNormalized: toSearchableText(textNormalized),
    lines: splitNormalizedLines(textRaw),
    preview: truncateText(textNormalized, 220),
    meta,
    regionId: meta.regionId || document.regionId || null,
    targetRole: meta.targetRole || document.targetRole || null,
    fieldKeys: Array.isArray(meta.fieldKeys) ? meta.fieldKeys.slice() : [],
    sourceVariantId: meta.sourceVariantId || document.sourceVariantId || null,
    variantProfileId: meta.variantProfileId || document.variantProfileId || null,
    orientationId: meta.orientationId || document.orientationId || null,
  };
};

const appendUniqueDocuments = (target, items, prefix) => {
  const seen = target._seen;

  (items || []).forEach((item, index) => {
    const document = normalizeDocument(item, `${prefix}_${index}`);
    const uniqueKey = `${document.id}:${document.textRaw}`;

    if (seen[uniqueKey]) return;
    seen[uniqueKey] = true;
    target.documents.push(document);
  });
};

module.exports = {
  buildEvidenceDocuments(payload = {}) {
    const prepared = {
      documents: [],
      _seen: {},
    };

    appendUniqueDocuments(prepared, payload.documents, 'document');

    if (payload.fullOcr && Array.isArray(payload.fullOcr.results)) {
      appendUniqueDocuments(prepared, payload.fullOcr.results.map((result) => ({
        id: result.targetId,
        label: result.label,
        confidence: result.confidence,
        sourceType: result.sourceType,
        textRaw: result.textRaw,
        textNormalized: result.textNormalized,
        filePath: result.filePath,
        meta: result.meta,
      })), 'full');
    }

    if (payload.regionOcr && Array.isArray(payload.regionOcr.results)) {
      appendUniqueDocuments(prepared, payload.regionOcr.results.map((result) => ({
        id: result.targetId,
        label: result.label,
        confidence: result.confidence,
        sourceType: result.sourceType,
        textRaw: result.textRaw,
        textNormalized: result.textNormalized,
        filePath: result.filePath,
        meta: result.meta,
      })), 'region');
    }

    if (payload.roiOcr && Array.isArray(payload.roiOcr.results)) {
      appendUniqueDocuments(prepared, payload.roiOcr.results.map((result) => ({
        id: result.targetId,
        label: result.label,
        confidence: result.confidence,
        sourceType: result.sourceType || 'nf_roi',
        textRaw: result.textRaw || result.textPreview,
        textNormalized: result.textNormalized || result.textRaw || result.textPreview,
        filePath: result.filePath,
        meta: result.meta,
      })), 'roi');
    }

    delete prepared._seen;
    return prepared.documents;
  },

  groupDocumentsByOrientation(documents = []) {
    return documents.reduce((accumulator, document) => {
      const orientationId = document.orientationId || 'unknown';
      if (!accumulator[orientationId]) accumulator[orientationId] = [];
      accumulator[orientationId].push(document);
      return accumulator;
    }, {});
  },

  summarizeDocuments(documents = []) {
    return documents.map((document) => ({
      id: document.id,
      label: document.label,
      sourceType: document.sourceType,
      confidence: document.confidence,
      regionId: document.regionId,
      targetRole: document.targetRole,
      variantProfileId: document.variantProfileId,
      psm: document.meta && document.meta.psm ? document.meta.psm : null,
      roiWidth: document.meta && document.meta.roiWidth ? document.meta.roiWidth : null,
      roiHeight: document.meta && document.meta.roiHeight ? document.meta.roiHeight : null,
      preview: document.preview,
    }));
  },
};
