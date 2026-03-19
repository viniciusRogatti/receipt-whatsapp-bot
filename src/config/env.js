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

const resolveOptionalPath = (targetPath) => {
  const raw = String(targetPath || '').trim();
  return raw ? path.resolve(projectRoot, raw) : '';
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

const parseInteger = (rawValue, fallback = 0) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
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

const parseCsvList = (rawValue, fallback = []) => {
  const parsed = String(rawValue || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  return parsed.length ? parsed : fallback.slice();
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
  receiptProcessingTmpDir: resolvePath(process.env.RECEIPT_PROCESSING_TMP_DIR, './outputs/processing-tmp'),
  receiptStorageDir: resolvePath(process.env.RECEIPT_STORAGE_DIR, './outputs/receipt-storage'),
  receiptQueueDir: resolvePath(process.env.RECEIPT_QUEUE_DIR, './outputs/receipt-queue'),
  receiptStateDir: resolvePath(process.env.RECEIPT_STATE_DIR, './outputs/processing-state'),
  debugServerPort: Number(process.env.DEBUG_SERVER_PORT || 3388),
  receiptApiPort: Number(process.env.RECEIPT_API_PORT || 3390),
  receiptWorkerPollMs: Math.max(250, Number(process.env.RECEIPT_WORKER_POLL_MS || 1500)),
  receiptQueueOnceIdleMs: Math.max(1000, Number(process.env.RECEIPT_QUEUE_ONCE_IDLE_MS || 3000)),
  receiptQueueConcurrency: Math.max(1, Number(process.env.RECEIPT_QUEUE_CONCURRENCY || 1)),
  receiptQueueName: String(process.env.RECEIPT_QUEUE_NAME || 'receipt_ingest').trim(),
  receiptJobQueueDriver: String(process.env.RECEIPT_JOB_QUEUE_DRIVER || 'file').trim().toLowerCase(),
  receiptQueueMaxAttempts: Math.max(1, Number(process.env.RECEIPT_QUEUE_MAX_ATTEMPTS || 3)),
  receiptQueueBackoffMs: Math.max(1000, Number(process.env.RECEIPT_QUEUE_BACKOFF_MS || 5000)),
  receiptQueueTerminalTtlHours: Math.max(1, Number(process.env.RECEIPT_QUEUE_TERMINAL_TTL_HOURS || 168)),
  receiptQueueRemoveOnCompleteAgeSeconds: Math.max(
    60,
    Number(process.env.RECEIPT_QUEUE_REMOVE_ON_COMPLETE_AGE_SECONDS || 86400),
  ),
  receiptQueueRemoveOnCompleteCount: Math.max(
    1,
    Number(process.env.RECEIPT_QUEUE_REMOVE_ON_COMPLETE_COUNT || 1000),
  ),
  receiptQueueRemoveOnFailAgeSeconds: Math.max(
    60,
    Number(process.env.RECEIPT_QUEUE_REMOVE_ON_FAIL_AGE_SECONDS || 604800),
  ),
  receiptQueueRemoveOnFailCount: Math.max(
    1,
    Number(process.env.RECEIPT_QUEUE_REMOVE_ON_FAIL_COUNT || 1000),
  ),
  receiptAssetStorageDriver: String(process.env.RECEIPT_ASSET_STORAGE_DRIVER || 'local').trim().toLowerCase(),
  receiptProcessingStateRepositoryDriver: String(
    process.env.RECEIPT_PROCESSING_STATE_REPOSITORY_DRIVER || 'file',
  ).trim().toLowerCase(),
  receiptStateTtlHours: Math.max(1, Number(process.env.RECEIPT_STATE_TTL_HOURS || 168)),
  receiptAssetRetentionHours: Math.max(1, Number(process.env.RECEIPT_ASSET_RETENTION_HOURS || 168)),
  receiptTempTtlHours: Math.max(1, Number(process.env.RECEIPT_TEMP_TTL_HOURS || 24)),
  receiptMaintenanceIntervalMs: Math.max(10_000, Number(process.env.RECEIPT_MAINTENANCE_INTERVAL_MS || 60_000)),
  receiptRedisUrl: String(process.env.RECEIPT_REDIS_URL || '').trim(),
  receiptRedisPrefix: String(process.env.RECEIPT_REDIS_PREFIX || 'receipt-whatsapp-bot').trim(),
  receiptS3Bucket: String(process.env.RECEIPT_S3_BUCKET || '').trim(),
  receiptS3Region: String(process.env.RECEIPT_S3_REGION || process.env.AWS_REGION || 'us-east-1').trim(),
  receiptS3Endpoint: String(process.env.RECEIPT_S3_ENDPOINT || '').trim(),
  receiptS3ForcePathStyle: parseBoolean(process.env.RECEIPT_S3_FORCE_PATH_STYLE, false),
  receiptS3PublicBaseUrl: String(process.env.RECEIPT_S3_PUBLIC_BASE_URL || '').trim(),
  receiptS3SignedUrlExpiresSeconds: Math.max(
    60,
    Number(process.env.RECEIPT_S3_SIGNED_URL_EXPIRES_SECONDS || 900),
  ),
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
  receiptLegacyFallbackEnabled: parseBoolean(
    process.env.RECEIPT_LEGACY_FALLBACK_ENABLED,
    true,
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
  receiptBackendApiBaseUrl: String(
    process.env.RECEIPT_BACKEND_API_BASE_URL || '',
  ).trim().replace(/\/+$/, ''),
  receiptBackendApiToken: String(process.env.RECEIPT_BACKEND_API_TOKEN || '').trim(),
  receiptBackendApiTimeoutMs: Math.max(
    1000,
    Number(process.env.RECEIPT_BACKEND_API_TIMEOUT_MS || 15000),
  ),
  receiptBackendSyncMode: String(process.env.RECEIPT_BACKEND_SYNC_MODE || 'mock').trim().toLowerCase(),
  receiptLocalFastMode: parseBoolean(process.env.RECEIPT_LOCAL_FAST_MODE, true),
  receiptLocalReportOnly: parseBoolean(process.env.RECEIPT_LOCAL_REPORT_ONLY, true),
  receiptLocalMaxImages: Math.max(0, Number(process.env.RECEIPT_LOCAL_MAX_IMAGES || 0)),
  whatsappSessionDir: resolvePath(process.env.WHATSAPP_SESSION_DIR, './outputs/whatsapp-session'),
  whatsappMediaDir: resolvePath(process.env.WHATSAPP_MEDIA_DIR, './outputs/whatsapp-media'),
  whatsappClientId: String(process.env.WHATSAPP_CLIENT_ID || 'receipt-whatsapp-bot').trim(),
  whatsappHeadless: parseBoolean(process.env.WHATSAPP_HEADLESS, true),
  whatsappBrowserExecutablePath: resolveOptionalPath(process.env.WHATSAPP_BROWSER_EXECUTABLE_PATH),
  whatsappBrowserArgs: parseCsvList(process.env.WHATSAPP_BROWSER_ARGS, []),
  whatsappAllowedGroupIds: parseCsvList(process.env.WHATSAPP_ALLOWED_GROUP_IDS, []),
  whatsappAllowedGroupNames: parseCsvList(process.env.WHATSAPP_ALLOWED_GROUP_NAMES, []),
  whatsappReplyEnabled: parseBoolean(process.env.WHATSAPP_REPLY_ENABLED, true),
  whatsappReplyOnOperationalFailure: parseBoolean(process.env.WHATSAPP_REPLY_ON_OPERATIONAL_FAILURE, true),
  whatsappCommandsEnabled: parseBoolean(process.env.WHATSAPP_COMMANDS_ENABLED, true),
  whatsappCommandPrefix: String(process.env.WHATSAPP_COMMAND_PREFIX || '!recibo').trim() || '!recibo',
  whatsappLogGroupsOnReady: parseBoolean(process.env.WHATSAPP_LOG_GROUPS_ON_READY, true),
};

module.exports = env;
