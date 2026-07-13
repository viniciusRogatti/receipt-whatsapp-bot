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
    name: 'whatsappConnectionState rejeita status desconhecido',
    run: () => {
      assert.throws(
        () => buildConnectionState('unknown'),
        /Status de conexao do WhatsApp invalido/,
      );
    },
  },
];
