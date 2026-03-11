const { SOURCE_IDS } = require('../shared');

module.exports = {
  id: SOURCE_IDS.webPanel,
  label: 'Painel web',
  metadataKeys: ['userId', 'sessionId', 'uploadedBy'],
  operational: {
    supportsAsyncReply: true,
    replyTransport: 'web_notification',
  },
};
