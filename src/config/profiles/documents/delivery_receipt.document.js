const {
  DOCUMENT_TYPES,
  EXTRACTION_FIELD_KEYS,
  PROCESSING_ENGINE_IDS,
} = require('../shared');

module.exports = {
  id: DOCUMENT_TYPES.deliveryReceipt,
  label: 'Canhoto de entrega',
  documentType: DOCUMENT_TYPES.deliveryReceipt,
  fieldDefinitions: {
    [EXTRACTION_FIELD_KEYS.invoiceNumber]: {
      key: EXTRACTION_FIELD_KEYS.invoiceNumber,
      label: 'NF-e',
      required: true,
      aliases: ['nf-e', 'nfe', 'nota fiscal', 'numero', 'nº', 'n.', 'num'],
      valuePatterns: [/\b\d{6,9}\b/g],
    },
    [EXTRACTION_FIELD_KEYS.receiptDate]: {
      key: EXTRACTION_FIELD_KEYS.receiptDate,
      label: 'Data de recebimento',
      required: true,
      aliases: ['data de recebimento', 'data recebimento', 'dt recebimento', 'recebimento'],
      valuePatterns: [/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g],
    },
    [EXTRACTION_FIELD_KEYS.issuerHeader]: {
      key: EXTRACTION_FIELD_KEYS.issuerHeader,
      label: 'Cabecalho do emissor',
      required: true,
      aliases: [],
      valuePatterns: [],
    },
  },
  extractionStrategy: {
    primaryProvider: PROCESSING_ENGINE_IDS.googleVision,
    fallbackProviders: [PROCESSING_ENGINE_IDS.openAiRescue],
    migrationProviders: [PROCESSING_ENGINE_IDS.legacyReceiptAnalysis],
    allowLegacyOnFailure: true,
  },
  fallbackPolicy: {
    enabled: true,
    minPrimaryConfidenceForAcceptance: 0.82,
    triggerBelowConfidence: 0.72,
    triggerWhenMissingFields: [
      EXTRACTION_FIELD_KEYS.invoiceNumber,
      EXTRACTION_FIELD_KEYS.receiptDate,
    ],
  },
  validation: {
    validConfidenceThreshold: 0.82,
    reviewConfidenceThreshold: 0.58,
    invalidMissingRequiredAbove: 2,
    allowApproveWithoutHeader: false,
  },
  operationalResponse: {
    valid: null,
    review: 'Nao foi possivel validar o canhoto com seguranca. Reenvie uma foto mais nitida e centralizada.',
    invalid: 'A imagem nao trouxe os campos minimos esperados do canhoto.',
  },
};
