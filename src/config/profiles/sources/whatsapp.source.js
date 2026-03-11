const { SOURCE_IDS } = require('../shared');

module.exports = {
  id: SOURCE_IDS.whatsapp,
  label: 'WhatsApp',
  metadataKeys: ['groupId', 'messageId', 'sender', 'chatId', 'mediaId'],
  operational: {
    supportsAsyncReply: true,
    replyTransport: 'whatsapp',
  },
};
