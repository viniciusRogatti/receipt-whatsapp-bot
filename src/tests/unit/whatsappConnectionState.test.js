const assert = require('assert');
const {
  buildConnectionState,
} = require('../../services/whatsappConnectionState.service');

module.exports = () => [
  {
    name: 'whatsappConnectionState expoe QR somente durante novo pareamento',
    run: () => {
      const qrRequired = buildConnectionState('qr_required', {
        qr: 'qr-efemero',
      });
      const ready = buildConnectionState('ready', {
        qr: 'nao-deve-vazar',
      });

      assert.strictEqual(qrRequired.qr, 'qr-efemero');
      assert.strictEqual(ready.qr, null);
      assert.strictEqual(ready.status, 'ready');
    },
  },
  {
    name: 'whatsappConnectionState inclui telemetria operacional sem expor QR',
    run: () => {
      const state = buildConnectionState('ready', {
        heartbeatAt: '2026-07-15T15:00:00.000Z',
        whatsappState: 'CONNECTED',
        lastMessageReceivedAt: '2026-07-15T14:59:00.000Z',
        lastIgnoredReason: 'group_not_allowed',
      });

      assert.strictEqual(state.heartbeatAt, '2026-07-15T15:00:00.000Z');
      assert.strictEqual(state.whatsappState, 'CONNECTED');
      assert.strictEqual(state.lastMessageReceivedAt, '2026-07-15T14:59:00.000Z');
      assert.strictEqual(state.lastIgnoredReason, 'group_not_allowed');
      assert.strictEqual(state.qr, null);
    },
  },
  {
    name: 'whatsappConnectionState rejeita status desconhecido',
    run: () => {
      assert.throws(
        () => buildConnectionState('unknown'),
        /Status de conexao do WhatsApp invalido/,
      );
    },
  },
];
