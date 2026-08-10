const path = require('path');

const normalizeText = (value) => String(value || '').trim();
const normalizeGroupPolicyKey = (value) => normalizeText(value)
  .toLowerCase()
  .replace(/\s+/g, ' ');

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

const normalizeMessageIdCandidate = (value) => {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = normalizeText(value);
    if (!normalized || ['[object Object]', 'undefined', 'null'].includes(normalized)) return '';
    return normalized;
  }

  return '';
};

const resolveWhatsappMessageId = (message = {}) => {
  const serializedId = [
    message.id?._serialized,
    message._data?.id?._serialized,
  ]
    .map(normalizeMessageIdCandidate)
    .find(Boolean);

  if (serializedId) return serializedId;

  const rawId = [
    message.id?.id,
    message._data?.id?.id,
    message.mediaId,
  ]
    .map(normalizeMessageIdCandidate)
    .find(Boolean);

  if (!rawId) return '';

  const groupId = normalizeMessageIdCandidate(
    message.from || message.groupId || message.chatId,
  );
  return groupId ? `whatsapp:${groupId}:${rawId}` : `whatsapp:${rawId}`;
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

const resolveWhatsappGroupPolicy = ({
  groupId,
  groupName,
  groupPolicies = {},
} = {}) => {
  const normalizedId = normalizeText(groupId);
  const normalizedName = normalizeGroupPolicyKey(groupName);
  const entries = groupPolicies && typeof groupPolicies === 'object' && !Array.isArray(groupPolicies)
    ? Object.entries(groupPolicies)
    : [];

  const matchedEntry = entries.find(([key]) => {
    const normalizedKey = normalizeGroupPolicyKey(key);
    if (!normalizedKey) return false;
    return normalizedKey === normalizedName || normalizedKey === normalizedId;
  });

  if (!matchedEntry) {
    return {
      key: normalizedName || normalizedId || null,
      processingMode: 'caption_only',
      companyCode: null,
      companyId: null,
      companyName: null,
    };
  }

  const [, policy] = matchedEntry;
  const normalizedPolicy = policy && typeof policy === 'object' && !Array.isArray(policy)
    ? policy
    : {};

  return {
    key: normalizeGroupPolicyKey(matchedEntry[0]) || normalizedName || normalizedId || null,
    processingMode: normalizeText(normalizedPolicy.processingMode || normalizedPolicy.mode).toLowerCase() || 'caption_only',
    companyCode: normalizeText(normalizedPolicy.companyCode) || null,
    companyId: normalizeText(normalizedPolicy.companyId) || null,
    companyName: normalizeText(normalizedPolicy.companyName) || null,
  };
};

module.exports = {
  guessExtensionFromMimeType,
  isGroupAllowed,
  isGroupMessage,
  isImageMimeType,
  parseTextCommand,
  resolveWhatsappMessageId,
  resolveWhatsappGroupPolicy,
  resolveMediaFileName,
};
