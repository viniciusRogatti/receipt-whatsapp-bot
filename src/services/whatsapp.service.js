const path = require('path');
const env = require('../config/env');
const receiptProfile = require('../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
} = require('../config/receiptProfiles');
const receiptAnalysisService = require('./receiptAnalysis.service');
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

module.exports = {
  buildReplyMessage,

  async downloadMedia(message, downloader) {
    if (typeof downloader !== 'function') {
      throw new Error('downloadMedia requer um downloader injetado para integracao real com WhatsApp.');
    }

    return downloader(message);
  },

  async handleIncomingImageMessage({ message, mediaPath, reply, outputDir }) {
    if (env.receiptAsyncWhatsappMode) {
      const ingestResult = await receiptIngestionService.ingestReceipt({
        payload: {
          companyId: message && message.companyId ? message.companyId : undefined,
          documentType: 'delivery_receipt',
          metadata: {
            groupId: message && message.groupId ? message.groupId : null,
            messageId: message && message.id ? message.id : null,
            sender: message && message.sender ? message.sender : null,
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
    const replyMessage = buildReplyMessage(analysis);

    if (replyMessage && typeof reply === 'function') {
      await reply(replyMessage, message);
    }

    return {
      analysis,
      replied: !!replyMessage,
      replyMessage,
    };
  },
};
