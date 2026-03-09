const path = require('path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const resolvePath = (targetPath, fallback) => {
  const raw = String(targetPath || fallback || '').trim();
  return path.resolve(projectRoot, raw);
};

const parseExpectedLengths = (rawValue, fallback = [7, 8]) => {
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

const env = {
  botEnv: process.env.BOT_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  projectRoot,
  backendRoot: resolvePath(process.env.BACKEND_ROOT, '../../backend'),
  testImagesDir: resolvePath(process.env.TEST_IMAGES_DIR, './test-images'),
  outputsDir: resolvePath(process.env.OUTPUTS_DIR, './outputs'),
  debugSessionsDir: resolvePath(process.env.DEBUG_SESSIONS_DIR, './outputs/debug-sessions'),
  debugServerPort: Number(process.env.DEBUG_SERVER_PORT || 3388),
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
  ocrExpectedNfLengths: parseExpectedLengths(process.env.OCR_NF_EXPECTED_LENGTHS, [7, 8]),
  ocrSuppressConsoleNoise: parseBoolean(process.env.OCR_SUPPRESS_CONSOLE_NOISE, true),
  receiptInvoiceLookupMode: String(process.env.RECEIPT_INVOICE_LOOKUP_MODE || 'auto').trim().toLowerCase(),
  receiptInvoiceLookupCompanyCode: String(process.env.RECEIPT_INVOICE_LOOKUP_COMPANY_CODE || 'mar_e_rio').trim(),
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
