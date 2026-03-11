const env = require('../../config/env');
const {
  DEFAULT_COMPANY_ID,
  DEFAULT_DOCUMENT_TYPE,
  DEFAULT_SOURCE_ID,
  resolveProcessingContext,
} = require('../../config/profiles');

const normalizeRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.keys(value).reduce((accumulator, key) => {
    accumulator[key] = value[key];
    return accumulator;
  }, {});
};

const normalizeHeaders = (headers = {}) => Object.keys(normalizeRecord(headers)).reduce((accumulator, key) => {
  accumulator[String(key || '').toLowerCase()] = headers[key];
  return accumulator;
}, {});

const parseMetadataValue = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeSourceId = (value) => String(
  value
  || DEFAULT_SOURCE_ID
  || env.receiptDefaultSourceId,
).trim();

const normalizeCompanyId = (value) => String(
  value
  || DEFAULT_COMPANY_ID
  || env.receiptDefaultCompanyId,
).trim();

const normalizeDocumentType = (value) => String(
  value
  || DEFAULT_DOCUMENT_TYPE
  || env.receiptDefaultDocumentType,
).trim();

const extractCredentialCandidates = (headers = {}) => {
  const normalizedHeaders = normalizeHeaders(headers);
  const authorization = String(normalizedHeaders.authorization || '').trim();
  const bearerToken = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : null;

  return [
    bearerToken,
    normalizedHeaders['x-ingest-token'],
    normalizedHeaders['x-api-key'],
    normalizedHeaders['x-company-token'],
  ]
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean);
};

const resolveCompanyIdFromCredentials = ({ headers = {} }) => {
  const candidates = extractCredentialCandidates(headers);
  if (!candidates.length) return null;

  const tokenMap = normalizeRecord(env.receiptCompanyIngestTokens);
  const entries = Object.entries(tokenMap);

  for (const candidate of candidates) {
    const matchedEntry = entries.find(([, tokens]) => (
      Array.isArray(tokens) && tokens.some((token) => String(token || '').trim() === candidate)
    ));

    if (matchedEntry) return matchedEntry[0];
  }

  return null;
};

const buildCanonicalReceiptRequest = ({
  payload = {},
  headers = {},
  sourceHint = null,
  uploadedFile = null,
}) => {
  const metadata = parseMetadataValue(payload.metadata);
  const normalizedHeaders = normalizeHeaders(headers);
  const resolvedCompanyId = normalizeCompanyId(
    payload.companyId
    || normalizedHeaders['x-company-id']
    || normalizedHeaders['x-company']
    || metadata.companyId
    || resolveCompanyIdFromCredentials({ headers }),
  );
  const resolvedSource = normalizeSourceId(
    payload.source
    || sourceHint
    || normalizedHeaders['x-source-id']
    || normalizedHeaders['x-source']
    || metadata.source,
  );
  const resolvedDocumentType = normalizeDocumentType(
    payload.documentType
    || normalizedHeaders['x-document-type']
    || metadata.documentType,
  );

  return {
    companyId: resolvedCompanyId,
    source: resolvedSource,
    documentType: resolvedDocumentType,
    imageUrl: payload.imageUrl ? String(payload.imageUrl).trim() : null,
    metadata,
    trace: {
      requestId: String(
        payload.requestId
        || normalizedHeaders['x-request-id']
        || normalizedHeaders['x-correlation-id']
        || '',
      ).trim() || null,
      ingestedAt: new Date().toISOString(),
    },
    upload: uploadedFile
      ? {
        path: uploadedFile.path,
        originalName: uploadedFile.originalName || uploadedFile.originalname || null,
        mimeType: uploadedFile.mimeType || uploadedFile.mimetype || null,
      }
      : null,
  };
};

const resolveReceiptProcessingContext = (request) => {
  const resolution = resolveProcessingContext({
    companyId: request.companyId,
    sourceId: request.source,
    documentType: request.documentType,
  });

  return Object.assign({}, resolution, {
    request,
  });
};

module.exports = {
  __testables: {
    buildCanonicalReceiptRequest,
    extractCredentialCandidates,
    normalizeHeaders,
    parseMetadataValue,
    resolveCompanyIdFromCredentials,
  },
  buildCanonicalReceiptRequest,
  resolveReceiptProcessingContext,
};
