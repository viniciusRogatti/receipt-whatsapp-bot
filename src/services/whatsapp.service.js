const env = require('../config/env');
const apiService = require('./api.service');
const {
  resolveWhatsappGroupPolicy,
} = require('./whatsappRuntimeSupport.service');

const normalizeMessageText = (value) => String(value || '').trim();

const hasPotentialInvoiceNumberInText = (value) => {
  const messageText = normalizeMessageText(value);
  if (!messageText) return false;

  const digitGroups = messageText.match(/\d+/g) || [];
  return digitGroups.some((digits) => {
    const length = String(digits || '').length;
    return length >= 3 && length <= 12;
  });
};

const buildMessageMetadata = (message = {}) => {
  const messageText = normalizeMessageText(
    message.messageText
    || message.caption
    || message.body,
  );
  const groupPolicy = resolveWhatsappGroupPolicy({
    groupId: message.groupId || message.chatId || null,
    groupName: message.groupName || null,
    groupPolicies: env.whatsappGroupPolicies,
  });

  return {
    source: 'whatsapp',
    sourceName: 'whatsapp',
    groupId: message.groupId || message.chatId || null,
    groupName: message.groupName || null,
    chatId: message.chatId || null,
    messageId: message.id || null,
    mediaId: message.mediaId || null,
    sender: message.sender || null,
    senderId: message.senderId || null,
    senderPhone: message.senderPhone || null,
    senderName: message.senderName || null,
    senderContactName: message.senderContactName || null,
    messageTimestamp: message.timestamp || null,
    messageText: messageText || null,
    caption: messageText || null,
    body: messageText || null,
    whatsappProcessingMode: groupPolicy.processingMode || 'caption_only',
    expectedCompanyCode: groupPolicy.companyCode || null,
    expectedCompanyId: groupPolicy.companyId || null,
    expectedCompanyName: groupPolicy.companyName || null,
  };
};

module.exports = {
  hasPotentialInvoiceNumberInText,

  async handleIncomingTextMessage({ message, reply }) {
    const messageMetadata = buildMessageMetadata(message);

    if (!hasPotentialInvoiceNumberInText(messageMetadata.messageText)) {
      return {
        ignored: true,
        reason: 'no_invoice_candidate_in_text',
      };
    }

    const backendSync = await apiService.syncWhatsappTextReceipt({
      imagePath: null,
      metadata: messageMetadata,
    });

    let replied = false;
    const replyMessage = backendSync && backendSync.replyMessage ? backendSync.replyMessage : null;
    if (replyMessage && typeof reply === 'function') {
      replied = !!(await reply(replyMessage, message));
    }

    return {
      backendSync,
      backendSyncError: null,
      replied,
      replyMessage,
      ignored: false,
    };
  },
};
