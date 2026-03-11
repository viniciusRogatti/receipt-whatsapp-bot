const env = require('./env');
const {
  DEFAULT_RECEIPT_PROFILE_ID,
  getReceiptProfileById,
} = require('./receiptProfiles');

const receiptProfile = getReceiptProfileById(env.receiptProfileId) || getReceiptProfileById(DEFAULT_RECEIPT_PROFILE_ID);

if (!receiptProfile) {
  throw new Error('Nenhum perfil de canhoto foi configurado para o receipt-whatsapp-bot.');
}

module.exports = receiptProfile;
