const SOURCE_IDS = {
  whatsapp: 'whatsapp',
  mobileApp: 'mobile_app',
  webPanel: 'web_panel',
  api: 'api',
  manualUpload: 'manual_upload',
};

const DOCUMENT_TYPES = {
  deliveryReceipt: 'delivery_receipt',
};

const EXTRACTION_FIELD_KEYS = {
  invoiceNumber: 'invoiceNumber',
  receiptDate: 'receiptDate',
  issuerHeader: 'issuerHeader',
};

const PROCESSING_ENGINE_IDS = {
  googleVision: 'google_vision_document_text',
  openAiRescue: 'openai_receipt_rescue',
  legacyReceiptAnalysis: 'legacy_receipt_analysis',
};

const REQUIRED_EXTRACTION_FIELDS = [
  EXTRACTION_FIELD_KEYS.invoiceNumber,
  EXTRACTION_FIELD_KEYS.receiptDate,
  EXTRACTION_FIELD_KEYS.issuerHeader,
];

module.exports = {
  DOCUMENT_TYPES,
  EXTRACTION_FIELD_KEYS,
  PROCESSING_ENGINE_IDS,
  REQUIRED_EXTRACTION_FIELDS,
  SOURCE_IDS,
};
