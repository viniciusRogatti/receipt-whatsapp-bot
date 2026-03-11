const { SOURCE_IDS } = require('../shared');

module.exports = {
  id: SOURCE_IDS.mobileApp,
  label: 'App mobile',
  metadataKeys: ['deviceId', 'userId', 'sessionId'],
  operational: {
    supportsAsyncReply: true,
    replyTransport: 'mobile_push',
  },
};
