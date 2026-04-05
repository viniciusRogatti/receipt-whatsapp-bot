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
    {
      name: 'apiService em backend_api envia atividade de sucesso do WhatsApp para o backend remoto',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/1719915')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1719915',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: 77,
                  tripNoteId: 88,
                  driverId: 99,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/whatsapp-success-activity')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                eventId: 456,
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.recordWhatsappSuccessActivity({
            invoiceNumber: '1719915',
            metadata: {
              messageId: 'wamid-456',
              groupName: 'Grupo de Canhotos',
              senderName: 'KP HORTOLANDIA',
            },
          });

          assert.strictEqual(result.mode, 'backend_api');
          assert.strictEqual(result.created, true);
          assert.strictEqual(requests.length, 2);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/1719915');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/whatsapp-success-activity');

          const body = JSON.parse(requests[1].options.body);
          assert.strictEqual(body.tripId, 77);
          assert.strictEqual(body.tripNoteId, 88);
          assert.strictEqual(body.driverId, 99);
          assert.strictEqual(body.metadata.senderName, 'KP HORTOLANDIA');
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
    {
      name: 'apiService em backend_api manda para revisao quando NF nao tem rota atribuida',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/1719915')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1719915',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: null,
                  tripNoteId: null,
                  driverId: null,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/alerts')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                alert: {
                  id: 789,
                },
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncAnalysisResult({
            nfExtraction: { nf: '1719915' },
            classification: { classification: 'valid', reasons: [] },
          }, {
            metadata: {
              source: 'whatsapp',
              groupName: 'Grupo de Canhotos',
              messageId: 'wamid-review-1',
            },
          });

          assert.strictEqual(result.action, 'create_receipt_alert');
          assert.strictEqual(result.reason, 'missing_route_assignment');
          assert.strictEqual(requests.length, 2);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/1719915');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/alerts');
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
    {
      name: 'apiService em backend_api ignora numero fora do padrao operacional de NF',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/12345')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: false,
                reason: 'invoice_not_found',
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncAnalysisResult({
            nfExtraction: { nf: '12345' },
            classification: { classification: 'review', reasons: ['Leitura parcial.'] },
          }, {
            metadata: {
              source: 'whatsapp',
              groupName: 'Grupo de Canhotos',
              messageId: 'wamid-sample-1',
            },
          });

          assert.strictEqual(result.action, 'none');
          assert.strictEqual(result.reason, 'ignored_non_operational_invoice');
          assert.strictEqual(result.ignored, true);
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/12345');
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
    {
      name: 'apiService em backend_api aprova NF valida quando a rota existe mesmo sem motorista',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/1721731')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1721731',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: 65,
                  tripNoteId: 731,
                  driverId: null,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/danfes/status')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                updated: true,
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/whatsapp-success-activity')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                eventId: 732,
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncAnalysisResult({
            nfExtraction: { nf: '1721731' },
            classification: { classification: 'valid', reasons: [] },
          }, {
            metadata: {
              source: 'whatsapp',
              groupName: 'Grupo de Canhotos',
              messageId: 'wamid-no-driver-1',
            },
          });

          assert.strictEqual(result.action, 'mark_invoice_delivered');
          assert.strictEqual(requests.length, 3);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/1721731');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/danfes/status');
          assert.strictEqual(requests[2].url, 'https://backend.example/api/receipt-bot/whatsapp-success-activity');

          const statusBody = JSON.parse(requests[1].options.body);
          assert.strictEqual(statusBody.invoiceNumber, '1721731');
          assert.strictEqual(statusBody.status, 'delivered');

          const activityBody = JSON.parse(requests[2].options.body);
          assert.strictEqual(activityBody.tripId, 65);
          assert.strictEqual(activityBody.tripNoteId, 731);
          assert.strictEqual(activityBody.driverId, null);
          assert.strictEqual(activityBody.metadata.operationalValidationStatus, 'matched_route_assignment');
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
    {
      name: 'apiService em backend_api promove review por data ausente quando a NF ja esta vinculada a rota e motorista',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/1721769')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1721769',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: 62,
                  tripNoteId: 694,
                  driverId: 8,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/danfes/status')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                updated: true,
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/whatsapp-success-activity')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                eventId: 901,
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncAnalysisResult({
            nfExtraction: { nf: '1721769' },
            classification: {
              classification: 'review',
              reasons: ['Campo obrigatorio ausente: Data de recebimento.'],
              metrics: {
                averageConfidence: 0.91,
                missingRequiredCount: 1,
              },
            },
          }, {
            metadata: {
              source: 'whatsapp',
              groupName: 'KP  - CANHOTOS',
              messageId: 'wamid-review-date-1',
              senderName: 'KP Braganca P.',
            },
          });

          assert.strictEqual(result.action, 'mark_invoice_delivered');
          assert.strictEqual(result.promotedFromReview, true);
          assert.strictEqual(requests.length, 3);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/1721769');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/danfes/status');
          assert.strictEqual(requests[2].url, 'https://backend.example/api/receipt-bot/whatsapp-success-activity');

          const statusBody = JSON.parse(requests[1].options.body);
          assert.strictEqual(statusBody.invoiceNumber, '1721769');
          assert.strictEqual(statusBody.status, 'delivered');

          const activityBody = JSON.parse(requests[2].options.body);
          assert.strictEqual(activityBody.invoiceNumber, '1721769');
          assert.strictEqual(activityBody.classification, 'valid');
          assert.strictEqual(activityBody.tripId, 62);
          assert.strictEqual(activityBody.tripNoteId, 694);
          assert.strictEqual(activityBody.driverId, 8);
          assert.strictEqual(activityBody.metadata.promotedFromReview, true);
          assert.strictEqual(activityBody.metadata.promotionReason, 'missing_receipt_date_only');
          assert.strictEqual(activityBody.metadata.originalClassification, 'review');
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
    {
      name: 'apiService em backend_api recupera a NF pela legenda da mensagem e promove para sucesso quando a NF ja esta vinculada a rota',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/2010316')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: false,
                reason: 'invoice_not_found',
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/danfes/nf/1721192')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1721192',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: 60,
                  tripNoteId: 850,
                  driverId: 5,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/danfes/status')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                updated: true,
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/whatsapp-success-activity')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                eventId: 990,
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncProcessingResult({
            extraction: {
              providerId: 'google_vision_document_text',
              parsedDocument: {
                fields: {
                  invoiceNumber: {
                    value: '2010316',
                    found: true,
                    confidence: 0.66,
                  },
                },
                summary: {
                  averageConfidence: 0.66,
                },
                fullText: '20/03/26',
              },
            },
            decision: {
              classification: 'review',
              reasons: ['Campo obrigatorio ausente: Data de recebimento.'],
              metrics: {
                averageConfidence: 0.66,
              },
            },
            request: {
              companyId: 1,
              source: 'whatsapp',
              documentType: 'delivery_receipt',
              metadata: {
                groupId: '5511947926056-1605791350@g.us',
                groupName: 'KP  - CANHOTOS',
                messageId: 'wamid-caption-rescue-1',
                senderName: 'KP Campinas 2',
                messageText: 'NF 1721192',
                caption: 'NF 1721192',
                body: 'NF 1721192',
              },
            },
          });

          assert.strictEqual(result.action, 'mark_invoice_delivered');
          assert.strictEqual(result.promotedFromReview, true);
          assert.strictEqual(requests.length, 4);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/2010316');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/danfes/nf/1721192');
          assert.strictEqual(requests[2].url, 'https://backend.example/api/receipt-bot/danfes/status');
          assert.strictEqual(requests[3].url, 'https://backend.example/api/receipt-bot/whatsapp-success-activity');

          const statusBody = JSON.parse(requests[2].options.body);
          assert.strictEqual(statusBody.invoiceNumber, '1721192');
          assert.strictEqual(statusBody.status, 'delivered');

          const activityBody = JSON.parse(requests[3].options.body);
          assert.strictEqual(activityBody.invoiceNumber, '1721192');
          assert.strictEqual(activityBody.classification, 'valid');
          assert.strictEqual(activityBody.tripId, 60);
          assert.strictEqual(activityBody.tripNoteId, 850);
          assert.strictEqual(activityBody.driverId, 5);
          assert.strictEqual(activityBody.metadata.promotedFromReview, true);
          assert.strictEqual(activityBody.metadata.promotionReason, 'matched_route_assignment');
          assert.strictEqual(activityBody.metadata.originalClassification, 'review');
          assert.strictEqual(activityBody.metadata.messageTextInvoiceRescued, true);
          assert.strictEqual(activityBody.metadata.messageTextInvoiceNumber, '1721192');
          assert.strictEqual(activityBody.metadata.originalInvoiceNumber, '2010316');
          assert.strictEqual(activityBody.metadata.messageText, 'NF 1721192');
          assert.strictEqual(activityBody.metadata.caption, 'NF 1721192');
          assert.strictEqual(activityBody.metadata.body, 'NF 1721192');

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
    {
      name: 'apiService em backend_api aprova pela legenda quando a imagem ja trouxe os demais campos obrigatorios',
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

          if (url.endsWith('/api/receipt-bot/danfes/nf/1721192')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                found: true,
                invoice: {
                  invoiceNumber: '1721192',
                },
                company: {
                  id: 1,
                  code: 'mar_e_rio',
                },
                deliveryContext: {
                  tripId: 60,
                  tripNoteId: 850,
                  driverId: 5,
                },
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/danfes/status')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                updated: true,
              }),
            };
          }

          if (url.endsWith('/api/receipt-bot/whatsapp-success-activity')) {
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({
                created: true,
                eventId: 991,
              }),
            };
          }

          throw new Error(`Unexpected request: ${url}`);
        };

        try {
          const result = await apiService.syncProcessingResult({
            extraction: {
              providerId: 'google_vision_document_text',
              parsedDocument: {
                fields: {
                  invoiceNumber: {
                    value: null,
                    found: false,
                    confidence: 0,
                  },
                  receiptDate: {
                    value: '20/03/2026',
                    found: true,
                    confidence: 0.94,
                  },
                  issuerHeader: {
                    value: 'MAR E RIO',
                    found: true,
                    confidence: 0.93,
                  },
                },
                summary: {
                  averageConfidence: 0.9,
                  foundFieldCount: 2,
                  missingFieldKeys: ['invoiceNumber'],
                },
                fullText: 'DATA DE RECEBIMENTO 20/03/2026',
              },
            },
            decision: {
              classification: 'review',
              reasons: ['Campo obrigatorio ausente: NF-e.'],
              metrics: {
                averageConfidence: 0.9,
              },
            },
            request: {
              companyId: 1,
              source: 'whatsapp',
              documentType: 'delivery_receipt',
              metadata: {
                groupId: '5511947926056-1605791350@g.us',
                groupName: 'KP  - CANHOTOS',
                messageId: 'wamid-caption-rescue-2',
                senderName: 'KP Campinas 2',
                messageText: 'NF 1721192',
                caption: 'NF 1721192',
                body: 'NF 1721192',
              },
            },
          });

          assert.strictEqual(result.action, 'mark_invoice_delivered');
          assert.strictEqual(result.promotedFromReview, false);
          assert.strictEqual(requests.length, 3);
          assert.strictEqual(requests[0].url, 'https://backend.example/api/receipt-bot/danfes/nf/1721192');
          assert.strictEqual(requests[1].url, 'https://backend.example/api/receipt-bot/danfes/status');
          assert.strictEqual(requests[2].url, 'https://backend.example/api/receipt-bot/whatsapp-success-activity');

          const statusBody = JSON.parse(requests[1].options.body);
          assert.strictEqual(statusBody.invoiceNumber, '1721192');
          assert.strictEqual(statusBody.status, 'delivered');

          const activityBody = JSON.parse(requests[2].options.body);
          assert.strictEqual(activityBody.invoiceNumber, '1721192');
          assert.strictEqual(activityBody.classification, 'valid');
          assert.strictEqual(activityBody.metadata.promotedFromReview, false);
          assert.strictEqual(activityBody.metadata.originalClassification, null);
          assert.strictEqual(activityBody.metadata.messageTextInvoiceRescued, true);
          assert.strictEqual(activityBody.metadata.messageTextInvoiceNumber, '1721192');
          assert.strictEqual(activityBody.metadata.messageText, 'NF 1721192');
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
