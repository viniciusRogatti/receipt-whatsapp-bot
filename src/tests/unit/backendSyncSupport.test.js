const assert = require('assert');
const {
  buildAlertPayload,
  resolveSyncAction,
} = require('../../services/backendSyncSupport.service');

module.exports = () => {
  return [
    {
      name: 'backendSyncSupport marca entregue quando a analise e valida e a NF existe',
      run: () => {
        const action = resolveSyncAction({
          analysis: {
            classification: {
              classification: 'valid',
            },
            nfExtraction: {
              nf: '1710486',
            },
          },
          lookup: {
            found: true,
          },
          syncMode: 'full',
        });

        assert.strictEqual(action.type, 'mark_delivered');
        assert.strictEqual(action.invoiceNumber, '1710486');
        assert.strictEqual(action.uploadReceipt, true);
      },
    },
    {
      name: 'backendSyncSupport gera alerta de revisao manual quando a classificacao e review',
      run: () => {
        const action = resolveSyncAction({
          analysis: {
            classification: {
              classification: 'review',
            },
            nfExtraction: {
              nf: '1710486',
            },
          },
          lookup: {
            found: true,
          },
          syncMode: 'status_only',
        });

        assert.strictEqual(action.type, 'alert');
        assert.strictEqual(action.reason, 'manual_review_required');
      },
    },
    {
      name: 'backendSyncSupport cria alerta de NF nao encontrada',
      run: () => {
        const alert = buildAlertPayload({
          analysis: {
            classification: {
              classification: 'review',
              reasons: ['NF nao encontrada na base.'],
            },
            nfExtraction: {
              nf: '1710486',
            },
          },
          lookup: {
            found: false,
          },
          metadata: {
            source: 'whatsapp',
            groupName: 'Comprovantes',
          },
        });

        assert.strictEqual(alert.code, 'NF_NOT_FOUND_UPLOAD_ATTEMPT');
        assert.ok(alert.message.includes('1710486'));
      },
    },
    {
      name: 'backendSyncSupport cria alerta sem NF quando a imagem nao permite extracao',
      run: () => {
        const action = resolveSyncAction({
          analysis: {
            classification: {
              classification: 'invalid',
            },
            nfExtraction: {
              nf: null,
            },
          },
          lookup: null,
          syncMode: 'full',
        });

        assert.strictEqual(action.type, 'alert');
        assert.strictEqual(action.reason, 'missing_nf');
      },
    },
  ];
};
