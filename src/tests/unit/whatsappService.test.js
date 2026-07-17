const assert = require('assert');
const {
  handleIncomingTextMessage,
  hasPotentialInvoiceNumberInText,
} = require('../../services/whatsapp.service');
const apiService = require('../../services/api.service');

module.exports = () => [
  {
    name: 'whatsappService aceita NF curta da empresa PRONTO',
    run: () => {
      assert.strictEqual(hasPotentialInvoiceNumberInText('NF 6678'), true);
      assert.strictEqual(hasPotentialInvoiceNumberInText('6678'), true);
    },
  },
  {
    name: 'whatsappService ignora texto sem candidato plausivel de NF',
    run: () => {
      assert.strictEqual(hasPotentialInvoiceNumberInText('foto do canhoto'), false);
      assert.strictEqual(hasPotentialInvoiceNumberInText('volume 2'), false);
    },
  },
  {
    name: 'whatsappService encaminha NF curta com escopo da PRONTO',
    run: async () => {
      const originalSync = apiService.syncWhatsappTextReceipt;
      let capturedMetadata = null;
      apiService.syncWhatsappTextReceipt = async ({ metadata }) => {
        capturedMetadata = metadata;
        return { action: 'mark_invoice_delivered' };
      };

      try {
        const result = await handleIncomingTextMessage({
          message: {
            id: 'message-pronto-6678',
            groupName: 'Canhotos Pronto',
            messageText: '6678',
            hasPhoto: true,
          },
        });

        assert.strictEqual(result.ignored, false);
        assert.strictEqual(capturedMetadata.expectedCompanyCode, 'pronto');
        assert.strictEqual(capturedMetadata.messageText, '6678');
      } finally {
        apiService.syncWhatsappTextReceipt = originalSync;
      }
    },
  },
  {
    name: 'whatsappService ignora NF enviada sem foto',
    run: async () => {
      const result = await handleIncomingTextMessage({
        message: {
          id: 'message-only-text-6678',
          groupName: 'Canhotos Pronto',
          messageText: '6678',
          hasPhoto: false,
        },
      });

      assert.deepStrictEqual(result, {
        ignored: true,
        reason: 'message_without_photo',
      });
    },
  },
];
