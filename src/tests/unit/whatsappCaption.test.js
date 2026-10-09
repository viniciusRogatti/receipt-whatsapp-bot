const assert = require('assert');
const { parseWhatsappCaption } = require('../../utils/whatsappCaption');
const api = require('../../services/api.service');
module.exports = () => [{ name: 'caption_only ignora texto extra e alerta legenda com separadores sem consultar ou baixar NF', run: async () => {
 const originalAlert = api.createReceiptAlert;
 let alerts = 0;
 api.createReceiptAlert = async () => { alerts++; return {}; };
 try {
  for (const text of ['NF 1234567', 'entregue 1234567', '1234567 obrigado']) {
   const result = await api.syncWhatsappTextReceipt({ metadata: { hasPhoto: true, messageText: text } });
   assert.equal(result.action, 'none');
  }
  assert.equal(alerts, 0);
  for (const text of ['123 4567', '1.234.567', '1234567\n1234568']) {
   const result = await api.syncWhatsappTextReceipt({ metadata: { hasPhoto: true, messageText: text } });
   assert.equal(result.reason, 'invalid_invoice_caption');
  }
  assert.equal(alerts, 3);
  assert.deepEqual(parseWhatsappCaption(' 00006284 '), { valid: true, invoiceNumber: '6284' });
 } finally { api.createReceiptAlert = originalAlert; }
} }];
