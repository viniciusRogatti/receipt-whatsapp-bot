const googleVisionProvider = require('./providers/googleVisionExtraction.provider');
const legacyProvider = require('./providers/legacyReceiptExtraction.provider');
const openAiRescueProvider = require('./providers/openAiReceiptRescue.provider');

const PROVIDERS = {
  [googleVisionProvider.id]: googleVisionProvider,
  [openAiRescueProvider.id]: openAiRescueProvider,
  [legacyProvider.id]: legacyProvider,
};

module.exports = {
  getProvider(providerId) {
    return PROVIDERS[String(providerId || '').trim()] || null;
  },

  listProviders() {
    return Object.values(PROVIDERS);
  },
};
