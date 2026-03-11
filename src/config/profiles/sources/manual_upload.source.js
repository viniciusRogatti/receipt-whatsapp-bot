const { SOURCE_IDS } = require('../shared');

module.exports = {
  id: SOURCE_IDS.manualUpload,
  label: 'Upload manual',
  metadataKeys: ['uploadedBy', 'ticketId', 'notes'],
  operational: {
    supportsAsyncReply: false,
    replyTransport: 'internal_review',
  },
};
