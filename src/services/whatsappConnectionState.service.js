const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { ensureDir } = require('../utils/file');

const ALLOWED_STATUSES = new Set([
  'starting',
  'qr_required',
  'authenticated',
  'ready',
  'auth_failure',
  'disconnected',
  'stopped',
  'error',
]);

const normalizeOptionalText = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const buildConnectionState = (status, details = {}) => {
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`Status de conexao do WhatsApp invalido: ${status}`);
  }

  return {
    status,
    qr: status === 'qr_required' ? normalizeOptionalText(details.qr) : null,
    reason: normalizeOptionalText(details.reason),
    message: normalizeOptionalText(details.message),
    clientId: env.whatsappClientId,
    processId: process.pid,
    updatedAt: new Date().toISOString(),
    heartbeatAt: normalizeOptionalText(details.heartbeatAt),
    whatsappState: normalizeOptionalText(details.whatsappState),
    lastMessageReceivedAt: normalizeOptionalText(details.lastMessageReceivedAt),
    lastMessageProcessedAt: normalizeOptionalText(details.lastMessageProcessedAt),
    lastIgnoredMessageAt: normalizeOptionalText(details.lastIgnoredMessageAt),
    lastIgnoredReason: normalizeOptionalText(details.lastIgnoredReason),
    lastMessageErrorAt: normalizeOptionalText(details.lastMessageErrorAt),
    lastMessageError: normalizeOptionalText(details.lastMessageError),
  };
};

const writeConnectionState = async (status, details = {}) => {
  const state = buildConnectionState(status, details);
  const targetPath = env.whatsappConnectionStatePath;
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;

  await ensureDir(path.dirname(targetPath));
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.promises.rename(temporaryPath, targetPath);
  return state;
};

module.exports = {
  ALLOWED_STATUSES,
  buildConnectionState,
  writeConnectionState,
};
