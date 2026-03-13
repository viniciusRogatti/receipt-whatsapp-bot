const path = require('path');

const normalizeText = (value) => String(value || '').trim();

const normalizeInvoiceNumber = (invoiceNumber) => {
  const digitsOnly = normalizeText(invoiceNumber).replace(/\D+/g, '');
  return digitsOnly || normalizeText(invoiceNumber);
};

const normalizeClassification = (analysis = {}) => normalizeText(
  analysis.classification && analysis.classification.classification,
).toLowerCase() || 'invalid';

const resolveSourceLabel = (metadata = {}) => {
  const sourceName = normalizeText(metadata.sourceName || metadata.source || 'whatsapp');
  const groupName = normalizeText(metadata.groupName);

  return groupName ? `${sourceName}:${groupName}` : sourceName;
};

const buildAlertPayload = ({ analysis = {}, lookup = null, metadata = {} }) => {
  const invoiceNumber = normalizeInvoiceNumber(analysis.nfExtraction && analysis.nfExtraction.nf);
  const classification = normalizeClassification(analysis);
  const reasons = Array.isArray(analysis.classification && analysis.classification.reasons)
    ? analysis.classification.reasons.filter(Boolean)
    : [];
  const sourceLabel = resolveSourceLabel(metadata);

  if (!invoiceNumber) {
    return {
      code: 'RECEIPT_UNREADABLE_IMAGE',
      title: 'Canhoto do WhatsApp sem NF identificada',
      message: `O bot recebeu uma imagem em ${sourceLabel}, mas nao conseguiu identificar a NF.`,
      severity: 'WARNING',
      metadata: {
        source: metadata.source || 'whatsapp',
        groupId: metadata.groupId || null,
        groupName: metadata.groupName || null,
        messageId: metadata.messageId || null,
        sender: metadata.sender || null,
        reasons,
        classification,
      },
    };
  }

  if (lookup && lookup.found === false) {
    return {
      code: 'NF_NOT_FOUND_UPLOAD_ATTEMPT',
      title: 'NF lida no WhatsApp nao foi encontrada no sistema',
      message: `A NF ${invoiceNumber} foi lida em ${sourceLabel}, mas nao existe na base operacional da empresa.`,
      severity: 'CRITICAL',
      metadata: {
        source: metadata.source || 'whatsapp',
        groupId: metadata.groupId || null,
        groupName: metadata.groupName || null,
        messageId: metadata.messageId || null,
        sender: metadata.sender || null,
        reasons,
        classification,
      },
    };
  }

  if (classification === 'review') {
    return {
      code: 'RECEIPT_MANUAL_REVIEW_REQUIRED',
      title: `Canhoto da NF ${invoiceNumber} exige revisao manual`,
      message: `O bot leu a NF ${invoiceNumber} em ${sourceLabel}, mas a imagem ainda exige revisao manual.`,
      severity: 'WARNING',
      metadata: {
        source: metadata.source || 'whatsapp',
        groupId: metadata.groupId || null,
        groupName: metadata.groupName || null,
        messageId: metadata.messageId || null,
        sender: metadata.sender || null,
        reasons,
        classification,
      },
    };
  }

  return {
    code: 'RECEIPT_UNREADABLE_IMAGE',
    title: `Canhoto invalido para a NF ${invoiceNumber || 'desconhecida'}`,
    message: `O bot recebeu uma imagem em ${sourceLabel}, mas nao conseguiu validar o canhoto com seguranca.`,
    severity: 'WARNING',
    metadata: {
      source: metadata.source || 'whatsapp',
      groupId: metadata.groupId || null,
      groupName: metadata.groupName || null,
      messageId: metadata.messageId || null,
      sender: metadata.sender || null,
      reasons,
      classification,
    },
  };
};

const resolveSyncAction = ({ analysis = {}, lookup = null, syncMode = 'mock' }) => {
  const invoiceNumber = normalizeInvoiceNumber(analysis.nfExtraction && analysis.nfExtraction.nf);
  const classification = normalizeClassification(analysis);
  const normalizedMode = normalizeText(syncMode).toLowerCase() || 'mock';

  if (normalizedMode === 'disabled') {
    return {
      type: 'none',
      reason: 'sync_disabled',
      invoiceNumber,
      classification,
    };
  }

  if (!invoiceNumber) {
    return {
      type: 'alert',
      reason: 'missing_nf',
      invoiceNumber: null,
      classification,
    };
  }

  if (lookup && lookup.found === false) {
    return {
      type: 'alert',
      reason: 'invoice_not_found',
      invoiceNumber,
      classification,
    };
  }

  if (classification !== 'valid') {
    return {
      type: 'alert',
      reason: classification === 'review' ? 'manual_review_required' : 'invalid_receipt',
      invoiceNumber,
      classification,
    };
  }

  if (normalizedMode === 'alerts_only') {
    return {
      type: 'none',
      reason: 'valid_without_backend_update',
      invoiceNumber,
      classification,
    };
  }

  return {
    type: 'mark_delivered',
    reason: normalizedMode === 'full' ? 'upload_and_mark_delivered' : 'mark_delivered_only',
    invoiceNumber,
    classification,
    uploadReceipt: normalizedMode === 'full',
  };
};

const guessMimeTypeFromPath = (filePath) => {
  const extension = path.extname(filePath || '').toLowerCase();

  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.heic') return 'image/heic';
  if (extension === '.heif') return 'image/heif';
  return 'image/jpeg';
};

module.exports = {
  buildAlertPayload,
  guessMimeTypeFromPath,
  normalizeClassification,
  normalizeInvoiceNumber,
  resolveSourceLabel,
  resolveSyncAction,
};
