const { EXTRACTION_FIELD_KEYS } = require('../config/profiles');
const { normalizeInvoiceNumber } = require('./backendSyncSupport.service');

const normalizeText = (value) => String(value || '').trim();

const toPlainObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
);

const cloneArray = (value) => Array.isArray(value) ? value.slice() : [];

const buildAnalysisFromProcessingResult = (processingResult = {}) => {
  const parsedDocument = processingResult.extraction && processingResult.extraction.parsedDocument
    ? processingResult.extraction.parsedDocument
    : {};
  const fields = toPlainObject(parsedDocument.fields);
  const invoiceField = toPlainObject(fields[EXTRACTION_FIELD_KEYS.invoiceNumber]);
  const decision = toPlainObject(processingResult.decision);
  const invoiceNumber = normalizeInvoiceNumber(invoiceField.value);
  const invoiceConfidence = Number(
    invoiceField.confidence
    || parsedDocument.summary && parsedDocument.summary.averageConfidence
    || 0,
  ) || 0;

  return {
    nfExtraction: {
      nf: invoiceNumber || null,
      confidence: invoiceConfidence,
      supportCount: invoiceField.found ? 1 : 0,
      origin: processingResult.extraction ? processingResult.extraction.providerId || null : null,
      method: 'structured_document',
      rawText: parsedDocument.fullText || null,
    },
    classification: {
      classification: normalizeText(decision.classification).toLowerCase() || 'invalid',
      reasons: cloneArray(decision.reasons).filter(Boolean),
      metrics: decision.metrics && typeof decision.metrics === 'object'
        ? decision.metrics
        : {},
    },
  };
};

const buildMetadataFromCanonicalRequest = (request = {}) => {
  const metadata = Object.assign({}, toPlainObject(request.metadata));
  const source = normalizeText(request.source || metadata.source || 'api');
  const sourceName = normalizeText(metadata.sourceName || source || 'api') || 'api';

  return Object.assign({}, metadata, {
    source,
    sourceName,
    companyId: request.companyId || metadata.companyId || null,
    documentType: request.documentType || metadata.documentType || null,
    groupId: metadata.groupId || metadata.chatId || null,
    groupName: metadata.groupName || null,
    chatId: metadata.chatId || metadata.groupId || null,
    messageId: metadata.messageId || null,
    mediaId: metadata.mediaId || null,
    sender: metadata.sender || null,
    senderId: metadata.senderId || null,
    senderPhone: metadata.senderPhone || null,
    senderName: metadata.senderName || null,
    senderContactName: metadata.senderContactName || null,
    messageTimestamp: metadata.messageTimestamp || null,
  });
};

module.exports = {
  buildAnalysisFromProcessingResult,
  buildMetadataFromCanonicalRequest,
};
