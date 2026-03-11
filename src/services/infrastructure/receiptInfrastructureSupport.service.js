const DEFAULT_EVENT_LIMIT = 40;
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

const buildReceiptJobId = () => {
  const compactTimestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const entropy = Math.random().toString(36).slice(2, 10);
  return `receipt-job-${compactTimestamp}-${entropy}`;
};

const buildCorrelationId = (trace = {}, fallback = null) => {
  const requestId = String(trace.requestId || '').trim();
  if (requestId) return requestId;
  return fallback || buildReceiptJobId();
};

const computeRetryDelayMs = (attemptCount, baseDelayMs) => {
  const attempts = Math.max(1, Number(attemptCount || 1));
  const baseDelay = Math.max(1000, Number(baseDelayMs || 5000));
  return baseDelay * (2 ** Math.max(0, attempts - 1));
};

const normalizeErrorPayload = (error) => {
  if (!error) return null;

  if (typeof error === 'string') {
    return {
      message: error,
    };
  }

  return {
    message: error.message || 'Erro desconhecido.',
    name: error.name || 'Error',
    stack: error.stack || null,
  };
};

const appendEvent = (events = [], event, limit = DEFAULT_EVENT_LIMIT) => {
  if (!event) return Array.isArray(events) ? events.slice(-limit) : [];

  const normalizedEvents = Array.isArray(events) ? events.slice() : [];
  normalizedEvents.push(Object.assign({
    timestamp: new Date().toISOString(),
  }, event));
  return normalizedEvents.slice(-limit);
};

const summarizeProcessingResult = (result = {}) => {
  const extractionAttempts = Array.isArray(result.extraction && result.extraction.attempts)
    ? result.extraction.attempts
    : [];

  return {
    accepted: !!(result.decision && result.decision.accepted),
    classification: result.decision ? result.decision.classification : null,
    providerId: result.extraction ? result.extraction.providerId : null,
    fallbackUsed: extractionAttempts.length > 1,
    providerAttempts: extractionAttempts.length,
    reasons: result.decision && Array.isArray(result.decision.reasons)
      ? result.decision.reasons.slice(0, 8)
      : [],
    message: result.decision && result.decision.actions
      ? result.decision.actions.message || null
      : null,
  };
};

const buildAssetObjectKey = ({
  companyId,
  documentType,
  sourceId,
  assetId,
  extension,
  storedAt = new Date(),
}) => {
  const referenceDate = storedAt instanceof Date ? storedAt : new Date(storedAt);
  return [
    companyId,
    documentType,
    String(referenceDate.getUTCFullYear()),
    String(referenceDate.getUTCMonth() + 1).padStart(2, '0'),
    String(referenceDate.getUTCDate()).padStart(2, '0'),
    `${sourceId}-${assetId}${extension}`,
  ].join('/');
};

const isTerminalStatus = (status) => TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());

module.exports = {
  appendEvent,
  buildAssetObjectKey,
  buildCorrelationId,
  buildReceiptJobId,
  computeRetryDelayMs,
  isTerminalStatus,
  normalizeErrorPayload,
  summarizeProcessingResult,
  TERMINAL_STATUSES,
};
