const marERioCompany = require('./companies/mar-e-rio.company');
const deliveryReceiptDocument = require('./documents/delivery_receipt.document');
const apiSource = require('./sources/api.source');
const manualUploadSource = require('./sources/manual_upload.source');
const mobileAppSource = require('./sources/mobile_app.source');
const webPanelSource = require('./sources/web_panel.source');
const whatsappSource = require('./sources/whatsapp.source');
const {
  DOCUMENT_TYPES,
  EXTRACTION_FIELD_KEYS,
  PROCESSING_ENGINE_IDS,
  REQUIRED_EXTRACTION_FIELDS,
  SOURCE_IDS,
} = require('./shared');

const COMPANY_PROFILES = {
  [marERioCompany.id]: marERioCompany,
};

const DOCUMENT_PROFILES = {
  [deliveryReceiptDocument.id]: deliveryReceiptDocument,
};

const SOURCE_PROFILES = {
  [apiSource.id]: apiSource,
  [manualUploadSource.id]: manualUploadSource,
  [mobileAppSource.id]: mobileAppSource,
  [webPanelSource.id]: webPanelSource,
  [whatsappSource.id]: whatsappSource,
};

const DEFAULT_COMPANY_ID = marERioCompany.id;
const DEFAULT_DOCUMENT_TYPE = marERioCompany.defaultDocumentType;
const DEFAULT_SOURCE_ID = SOURCE_IDS.api;

const clone = (value) => {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => clone(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((accumulator, key) => {
      accumulator[key] = clone(value[key]);
      return accumulator;
    }, {});
  }

  return value;
};

const getCompanyProfileById = (companyId) => {
  const normalizedId = String(companyId || '').trim();
  return COMPANY_PROFILES[normalizedId] || null;
};

const getDocumentProfileById = (documentId) => {
  const normalizedId = String(documentId || '').trim();
  return DOCUMENT_PROFILES[normalizedId] || null;
};

const getSourceProfileById = (sourceId) => {
  const normalizedId = String(sourceId || '').trim();
  return SOURCE_PROFILES[normalizedId] || null;
};

const mergeFieldDefinitions = (fieldDefinitions = {}, fieldOverrides = {}) => {
  const merged = {};

  Object.keys(fieldDefinitions).forEach((fieldKey) => {
    merged[fieldKey] = Object.assign({}, clone(fieldDefinitions[fieldKey]), clone(fieldOverrides[fieldKey] || {}));
  });

  return merged;
};

const resolveProcessingContext = ({
  companyId,
  sourceId,
  documentType,
}) => {
  const companyProfile = getCompanyProfileById(companyId || DEFAULT_COMPANY_ID);
  if (!companyProfile) {
    throw new Error(`Empresa nao configurada: ${companyId || 'indefinida'}.`);
  }

  const sourceProfile = getSourceProfileById(sourceId || DEFAULT_SOURCE_ID);
  if (!sourceProfile) {
    throw new Error(`Origem nao configurada: ${sourceId || 'indefinida'}.`);
  }

  if (!companyProfile.enabledSources.includes(sourceProfile.id)) {
    throw new Error(`A origem ${sourceProfile.id} nao esta habilitada para ${companyProfile.id}.`);
  }

  const resolvedDocumentType = documentType || companyProfile.defaultDocumentType || DEFAULT_DOCUMENT_TYPE;
  const documentBinding = companyProfile.documentBindings[resolvedDocumentType];

  if (!documentBinding) {
    throw new Error(`Documento ${resolvedDocumentType} nao configurado para ${companyProfile.id}.`);
  }

  const documentProfile = getDocumentProfileById(documentBinding.documentProfileId);
  if (!documentProfile) {
    throw new Error(`Perfil de documento ausente: ${documentBinding.documentProfileId}.`);
  }

  const resolvedDocumentProfile = Object.assign({}, clone(documentProfile), {
    fieldDefinitions: mergeFieldDefinitions(
      documentProfile.fieldDefinitions,
      documentBinding.fieldOverrides || {},
    ),
    extractionStrategy: Object.assign(
      {},
      clone(documentProfile.extractionStrategy || {}),
      clone(documentBinding.extractionStrategy || {}),
    ),
    validation: Object.assign(
      {},
      clone(documentProfile.validation || {}),
      clone(documentBinding.validationOverrides || {}),
    ),
    fallbackPolicy: Object.assign(
      {},
      clone(documentProfile.fallbackPolicy || {}),
      clone(documentBinding.fallbackPolicyOverrides || {}),
    ),
    operationalResponse: Object.assign(
      {},
      clone(documentProfile.operationalResponse || {}),
      clone(documentBinding.operationalResponseOverrides || {}),
    ),
  });

  return {
    companyProfile,
    sourceProfile,
    documentProfile: resolvedDocumentProfile,
    documentBinding: clone(documentBinding),
  };
};

module.exports = {
  COMPANY_PROFILES,
  DEFAULT_COMPANY_ID,
  DEFAULT_DOCUMENT_TYPE,
  DEFAULT_SOURCE_ID,
  DOCUMENT_PROFILES,
  DOCUMENT_TYPES,
  EXTRACTION_FIELD_KEYS,
  PROCESSING_ENGINE_IDS,
  REQUIRED_EXTRACTION_FIELDS,
  SOURCE_IDS,
  SOURCE_PROFILES,
  getCompanyProfileById,
  getDocumentProfileById,
  getSourceProfileById,
  resolveProcessingContext,
};
