const { SOURCE_IDS } = require('../shared');

module.exports = {
  id: SOURCE_IDS.api,
  label: 'API',
  metadataKeys: ['requestId', 'integrationId', 'sender'],
  operational: {
    supportsAsyncReply: false,
    replyTransport: 'webhook_callback',
  },
};
