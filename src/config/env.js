const path = require('path');
const dotenv = require('dotenv');
const {
  DEFAULT_RECEIPT_PROFILE_ID,
  getReceiptProfileById,
} = require('./receiptProfiles');
const {
  DEFAULT_COMPANY_ID,
  DEFAULT_DOCUMENT_TYPE,
  DEFAULT_SOURCE_ID,
} = require('./profiles');

const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const resolvePath = (targetPath, fallback) => {
  const raw = String(targetPath || fallback || '').trim();
  return path.resolve(projectRoot, raw);
};

const parseExpectedLengths = (rawValue, fallback = [7]) => {
  const parsed = String(rawValue || '')
    .split(',')
    .map((item) => Number(String(item || '').trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  return parsed.length ? parsed : fallback.slice();
};

const parseBoolean = (rawValue, fallback = false) => {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseJsonObject = (rawValue, fallback = {}) => {
  if (!rawValue) return Object.assign({}, fallback);

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : Object.assign({}, fallback);
  } catch {
    return Object.assign({}, fallback);
  }
};

const configuredReceiptProfileId = String(
  process.env.RECEIPT_PROFILE_ID || DEFAULT_RECEIPT_PROFILE_ID,
).trim();
const resolvedReceiptProfile = getReceiptProfileById(configuredReceiptProfileId)
  || getReceiptProfileById(DEFAULT_RECEIPT_PROFILE_ID);

const env = {
  botEnv: process.env.BOT_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  projectRoot,
  backendRoot: resolvePath(process.env.BACKEND_ROOT, '../../backend'),
  testImagesDir: resolvePath(process.env.TEST_IMAGES_DIR, './test-images'),
  outputsDir: resolvePath(process.env.OUTPUTS_DIR, './outputs'),
  debugSessionsDir: resolvePath(process.env.DEBUG_SESSIONS_DIR, './outputs/debug-sessions'),
  receiptIngressTmpDir: resolvePath(process.env.RECEIPT_INGEST_TMP_DIR, './outputs/ingest-tmp'),
  receiptStorageDir: resolvePath(process.env.RECEIPT_STORAGE_DIR, './outputs/receipt-storage'),
  receiptQueueDir: resolvePath(process.env.RECEIPT_QUEUE_DIR, './outputs/receipt-queue'),
  debugServerPort: Number(process.env.DEBUG_SERVER_PORT || 3388),
  receiptApiPort: Number(process.env.RECEIPT_API_PORT || 3390),
  receiptWorkerPollMs: Math.max(250, Number(process.env.RECEIPT_WORKER_POLL_MS || 1500)),
  receiptAsyncWhatsappMode: parseBoolean(process.env.RECEIPT_ASYNC_WHATSAPP_MODE, false),
  receiptDefaultCompanyId: String(process.env.RECEIPT_DEFAULT_COMPANY_ID || DEFAULT_COMPANY_ID).trim(),
  receiptDefaultSourceId: String(process.env.RECEIPT_DEFAULT_SOURCE_ID || DEFAULT_SOURCE_ID).trim(),
  receiptDefaultDocumentType: String(
    process.env.RECEIPT_DEFAULT_DOCUMENT_TYPE || DEFAULT_DOCUMENT_TYPE,
  ).trim(),
  receiptCompanyIngestTokens: parseJsonObject(process.env.RECEIPT_COMPANY_INGEST_TOKENS, {}),
  receiptProviderGoogleVisionEnabled: parseBoolean(
    process.env.RECEIPT_PROVIDER_GOOGLE_VISION_ENABLED,
    true,
  ),
  receiptProviderGoogleVisionEndpoint: String(
    process.env.RECEIPT_PROVIDER_GOOGLE_VISION_ENDPOINT
    || 'https://vision.googleapis.com/v1/images:annotate',
  ).trim(),
  receiptProviderGoogleVisionApiKey: String(
    process.env.RECEIPT_PROVIDER_GOOGLE_VISION_API_KEY || '',
  ).trim(),
  receiptProviderGoogleVisionBearerToken: String(
    process.env.RECEIPT_PROVIDER_GOOGLE_VISION_BEARER_TOKEN || '',
  ).trim(),
  receiptProviderGoogleVisionTimeoutMs: Math.max(
    1000,
    Number(process.env.RECEIPT_PROVIDER_GOOGLE_VISION_TIMEOUT_MS || 20000),
  ),
  receiptProviderOpenAiEnabled: parseBoolean(
    process.env.RECEIPT_PROVIDER_OPENAI_ENABLED,
    true,
  ),
  receiptProviderOpenAiBaseUrl: String(
    process.env.RECEIPT_PROVIDER_OPENAI_BASE_URL || 'https://api.openai.com/v1',
  ).trim().replace(/\/+$/, ''),
  receiptProviderOpenAiApiKey: String(process.env.RECEIPT_PROVIDER_OPENAI_API_KEY || '').trim(),
  receiptProviderOpenAiModel: String(
    process.env.RECEIPT_PROVIDER_OPENAI_MODEL || 'gpt-4.1-mini',
  ).trim(),
  receiptProviderOpenAiTimeoutMs: Math.max(
    1000,
    Number(process.env.RECEIPT_PROVIDER_OPENAI_TIMEOUT_MS || 25000),
  ),
  ocrProbeEnabled: String(process.env.OCR_PROBE_ENABLED || 'true').toLowerCase() !== 'false',
  ocrProbeLang: process.env.OCR_PROBE_LANG || 'por',
  ocrProbeVariantLimit: Number(process.env.OCR_PROBE_VARIANT_LIMIT || 4),
  ocrFullLang: process.env.OCR_FULL_LANG || 'por',
  ocrRegionLang: process.env.OCR_REGION_LANG || 'por',
  ocrLangPath: resolvePath(process.env.OCR_LANG_PATH, '.'),
  ocrWorkerPoolSize: Math.max(1, Number(process.env.OCR_WORKER_POOL_SIZE || 2)),
  ocrFullVariantLimit: Number(process.env.OCR_FULL_VARIANT_LIMIT || 1),
  ocrFullMaxEdge: Number(process.env.OCR_FULL_MAX_EDGE || 1100),
  ocrRegionMaxEdge: Number(process.env.OCR_REGION_MAX_EDGE || 900),
  ocrRegionMinEdge: Number(process.env.OCR_REGION_MIN_EDGE || 1200),
  ocrExpectedNfLengths: parseExpectedLengths(process.env.OCR_NF_EXPECTED_LENGTHS, [7]),
  ocrSuppressConsoleNoise: parseBoolean(process.env.OCR_SUPPRESS_CONSOLE_NOISE, true),
  receiptProfileId: resolvedReceiptProfile ? resolvedReceiptProfile.id : DEFAULT_RECEIPT_PROFILE_ID,
  receiptInvoiceLookupMode: String(process.env.RECEIPT_INVOICE_LOOKUP_MODE || 'auto').trim().toLowerCase(),
  receiptInvoiceLookupCompanyCode: String(
    process.env.RECEIPT_INVOICE_LOOKUP_COMPANY_CODE
    || (resolvedReceiptProfile && resolvedReceiptProfile.invoiceLookup && resolvedReceiptProfile.invoiceLookup.companyCode)
    || 'mar_e_rio',
  ).trim(),
  receiptInvoiceLookupCompanyId: Number(process.env.RECEIPT_INVOICE_LOOKUP_COMPANY_ID || 0) || null,
  receiptInvoiceLookupBackendEnvPath: resolvePath(
    process.env.RECEIPT_INVOICE_LOOKUP_BACKEND_ENV_PATH,
    '../../backend/.env',
  ),
  receiptLocalFastMode: parseBoolean(process.env.RECEIPT_LOCAL_FAST_MODE, true),
  receiptLocalReportOnly: parseBoolean(process.env.RECEIPT_LOCAL_REPORT_ONLY, true),
  receiptLocalMaxImages: Math.max(0, Number(process.env.RECEIPT_LOCAL_MAX_IMAGES || 0)),
};

module.exports = env;
