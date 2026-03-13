const path = require('path');

const normalizeText = (value) => String(value || '').trim();

const normalizeCollection = (values = [], { lowerCase = false } = {}) => {
  return values
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .map((value) => (lowerCase ? value.toLowerCase() : value));
};

const isGroupMessage = (chatId) => normalizeText(chatId).endsWith('@g.us');

const isGroupAllowed = ({
  groupId,
  groupName,
  allowedGroupIds = [],
  allowedGroupNames = [],
}) => {
  const normalizedId = normalizeText(groupId);
  const normalizedName = normalizeText(groupName).toLowerCase();
  const idAllowList = normalizeCollection(allowedGroupIds);
  const nameAllowList = normalizeCollection(allowedGroupNames, { lowerCase: true });

  if (!idAllowList.length && !nameAllowList.length) {
    return true;
  }

  if (normalizedId && idAllowList.includes(normalizedId)) {
    return true;
  }

  if (normalizedName && nameAllowList.includes(normalizedName)) {
    return true;
  }

  return false;
};

const isImageMimeType = (mimeType) => normalizeText(mimeType).toLowerCase().startsWith('image/');

const guessExtensionFromMimeType = (mimeType, fallback = '.jpg') => {
  const normalized = normalizeText(mimeType).toLowerCase();

  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/heic') return '.heic';
  if (normalized === 'image/heif') return '.heif';
  return fallback;
};

const resolveMediaFileName = ({ mimeType, originalFileName = '', messageId = '' }) => {
  const fileName = normalizeText(path.basename(originalFileName));
  if (fileName) return fileName;

  const extension = guessExtensionFromMimeType(mimeType);
  const stem = normalizeText(messageId).replace(/[^a-zA-Z0-9_-]+/g, '_') || `${Date.now()}`;
  return `${stem}${extension}`;
};

const parseTextCommand = ({ body = '', prefix = '!recibo' }) => {
  const normalizedPrefix = normalizeText(prefix);
  const normalizedBody = normalizeText(body);

  if (!normalizedPrefix || !normalizedBody) return null;
  if (!normalizedBody.toLowerCase().startsWith(normalizedPrefix.toLowerCase())) return null;

  const tail = normalizedBody.slice(normalizedPrefix.length).trim();
  const [command = '', ...args] = tail.split(/\s+/).filter(Boolean);

  return {
    command: command.toLowerCase() || 'help',
    args,
  };
};

module.exports = {
  guessExtensionFromMimeType,
  isGroupAllowed,
  isGroupMessage,
  isImageMimeType,
  parseTextCommand,
  resolveMediaFileName,
};
