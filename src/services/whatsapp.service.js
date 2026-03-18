const path = require('path');
const env = require('../config/env');
const receiptProfile = require('../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
} = require('../config/receiptProfiles');
const receiptAnalysisService = require('./receiptAnalysis.service');
const apiService = require('./api.service');
const receiptIngestionService = require('./ingestion/receiptIngestion.service');

const issuerHeaderLabel = receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.issuerHeader].label;

const buildReplyMessage = (analysis) => {
  if (!analysis || !analysis.classification) return 'Nao foi possivel analisar a imagem enviada.';
  const reasons = analysis.classification.reasons || [];

  if (analysis.classification.classification === 'valid') {
    return null;
  }

  if (reasons.some((reason) => reason.includes('Fundo muito claro'))) {
    return 'Fundo muito claro. Por favor, coloque o canhoto sobre uma superficie escura e envie outra foto.';
  }

  if (analysis.classification.classification === 'review') {
    if (reasons.some((reason) => reason.includes('DATA DE RECEBIMENTO'))) {
      return 'Nao consegui confirmar a DATA DE RECEBIMENTO. Reenvie uma foto mais nitida dessa parte do canhoto.';
    }

    if (reasons.some((reason) => reason.includes('Campo NF-e'))) {
      return 'Nao consegui confirmar o bloco NF-e. Reenvie uma foto mais centralizada e sem cortes.';
    }

    return 'Nao consegui validar o canhoto com seguranca. Reenvie uma foto mais nitida e centralizada.';
  }

  return `A imagem nao trouxe os campos minimos do canhoto. Reenvie uma foto com DATA DE RECEBIMENTO, ${issuerHeaderLabel} e NF-e visiveis.`;
};

const buildOperationalFailureReplyMessage = () => (
  'Consegui ler a imagem, mas nao consegui registrar o resultado no sistema agora. Tente novamente em instantes.'
);

const buildMessageMetadata = (message = {}) => ({
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
});

module.exports = {
  buildReplyMessage,

  async downloadMedia(message, downloader) {
    if (typeof downloader !== 'function') {
      throw new Error('downloadMedia requer um downloader injetado para integracao real com WhatsApp.');
    }

    return downloader(message);
  },

  async handleIncomingImageMessage({ message, mediaPath, reply, outputDir }) {
    try {
      const messageMetadata = buildMessageMetadata(message);

      if (env.receiptAsyncWhatsappMode) {
        const ingestResult = await receiptIngestionService.ingestReceipt({
          payload: {
            companyId: message && message.companyId ? message.companyId : undefined,
            documentType: 'delivery_receipt',
            metadata: {
              groupId: message && message.groupId ? message.groupId : null,
              groupName: message && message.groupName ? message.groupName : null,
              chatId: message && message.chatId ? message.chatId : null,
              messageId: message && message.id ? message.id : null,
              mediaId: message && message.mediaId ? message.mediaId : null,
              sender: message && message.sender ? message.sender : null,
              senderId: message && message.senderId ? message.senderId : null,
              senderPhone: message && message.senderPhone ? message.senderPhone : null,
              senderName: message && message.senderName ? message.senderName : null,
              senderContactName: message && message.senderContactName ? message.senderContactName : null,
              messageTimestamp: message && message.timestamp ? message.timestamp : null,
              source: 'whatsapp',
              sourceName: 'whatsapp',
            },
          },
          headers: {},
          uploadedFile: {
            path: mediaPath,
            originalName: path.basename(mediaPath || 'receipt.jpg'),
          },
          sourceHint: 'whatsapp',
        });

        return {
          queued: true,
          replied: false,
          replyMessage: null,
          ingestion: ingestResult,
        };
      }

      const analysis = await receiptAnalysisService.analyzeImage({
        imagePath: mediaPath,
        outputDir: outputDir || path.join(process.cwd(), 'outputs', 'whatsapp'),
      });
      let backendSync = null;
      let backendSyncError = null;

      try {
        backendSync = await apiService.syncAnalysisResult(analysis, {
          imagePath: mediaPath,
          metadata: messageMetadata,
        });
      } catch (error) {
        backendSyncError = error;

        await apiService.createWhatsappOperationalAlert({
          code: 'RECEIPT_WHATSAPP_SYNC_FAILURE',
          title: 'Falha ao sincronizar canhoto vindo do WhatsApp',
          message: `O bot leu a imagem recebida em ${messageMetadata.groupName || messageMetadata.groupId || 'grupo desconhecido'}, mas nao conseguiu atualizar o backend.`,
          severity: 'CRITICAL',
          invoiceNumber: analysis && analysis.nfExtraction ? analysis.nfExtraction.nf : null,
          metadata: Object.assign({}, messageMetadata, {
            backendAction: 'mark_invoice_delivered',
            backendMode: env.receiptBackendSyncMode,
            classification: analysis && analysis.classification ? analysis.classification.classification : null,
            reasons: analysis && analysis.classification && Array.isArray(analysis.classification.reasons)
              ? analysis.classification.reasons
              : [],
            errorMessage: error.message,
          }),
        }).catch(() => undefined);
      }

      let replyMessage = buildReplyMessage(analysis);
      if (
        !replyMessage
        && backendSyncError
        && env.whatsappReplyOnOperationalFailure
      ) {
        replyMessage = buildOperationalFailureReplyMessage();
      }

      let replied = false;
      if (replyMessage && typeof reply === 'function') {
        replied = !!(await reply(replyMessage, message));
      }

      return {
        analysis,
        backendSync,
        backendSyncError: backendSyncError
          ? {
            message: backendSyncError.message,
          }
          : null,
        replied,
        replyMessage,
      };
    } catch (error) {
      const messageMetadata = buildMessageMetadata(message);

      await apiService.createWhatsappOperationalAlert({
        code: 'RECEIPT_WHATSAPP_PROCESSING_FAILURE',
        title: 'Falha ao processar imagem vinda do WhatsApp',
        message: `O bot nao conseguiu concluir o processamento da imagem recebida em ${messageMetadata.groupName || messageMetadata.groupId || 'grupo desconhecido'}.`,
        severity: 'WARNING',
        metadata: Object.assign({}, messageMetadata, {
          backendAction: 'process_receipt_image',
          backendMode: env.receiptBackendSyncMode,
          errorMessage: error.message,
        }),
      }).catch(() => undefined);

      throw error;
    }
  },
};
