const assert = require('assert');
const env = require('../../config/env');
const apiService = require('../../services/api.service');

module.exports = () => {
  return [
    {
      name: 'apiService cria alerta via backend_api sem depender do backend local',
      run: async () => {
        const originalBackendApiBaseUrl = env.receiptBackendApiBaseUrl;
        const originalBackendApiToken = env.receiptBackendApiToken;
        const originalBackendSyncMode = env.receiptBackendSyncMode;
        const originalBackendRoot = env.backendRoot;
        const originalCompanyCode = env.receiptInvoiceLookupCompanyCode;
        const originalCompanyId = env.receiptInvoiceLookupCompanyId;
        const originalFetch = global.fetch;
        const requests = [];

        env.receiptBackendApiBaseUrl = 'https://backend.example';
        env.receiptBackendApiToken = 'token-de-teste';
        env.receiptBackendSyncMode = 'status_only';
        env.backendRoot = '/backend-inexistente-para-teste';
        env.receiptInvoiceLookupCompanyCode = 'mar_e_rio';
        env.receiptInvoiceLookupCompanyId = null;

        global.fetch = async (url, options = {}) => {
          requests.push({ url, options });
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              created: true,
              alert: {
                id: 123,
              },
            }),
          };
        };

        try {
          const result = await apiService.createReceiptAlert({
            invoiceNumber: '1710486',
            code: 'RECEIPT_REVIEW_REQUIRED',
            title: 'Canhoto precisa de revisao',
            message: 'A leitura automatica falhou.',
            severity: 'WARNING',
            lookup: {
              company: {
                id: 1,
                code: 'mar_e_rio',
              },
            },
            metadata: {
              source: 'whatsapp',
              messageId: 'wamid-123',
            },
          });

          assert.strictEqual(result.mode, 'backend_api');
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/alerts');
          assert.strictEqual(requests[0].options.method, 'POST');
          assert.strictEqual(requests[0].options.headers['x-company-code'], 'mar_e_rio');
        } finally {
          env.receiptBackendApiBaseUrl = originalBackendApiBaseUrl;
          env.receiptBackendApiToken = originalBackendApiToken;
          env.receiptBackendSyncMode = originalBackendSyncMode;
          env.backendRoot = originalBackendRoot;
          env.receiptInvoiceLookupCompanyCode = originalCompanyCode;
          env.receiptInvoiceLookupCompanyId = originalCompanyId;
          global.fetch = originalFetch;
          await apiService.shutdown().catch(() => undefined);
        }
      },
    },
  ];
};
