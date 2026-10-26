const { serializedId } = require('./whatsappMessageIdentity.service');

// Follow the current wwebjs media resolver: WhatsApp owns the download and
// decryption, then exposes the original blob. The old DownloadManager call in
// SDK 1.34.7 is incompatible with recent WhatsApp Web builds.
async function downloadPhoto(message) {
  if (!message.client?.pupPage) return message.downloadMedia();
  const id = serializedId(message.id);
  if (!id) throw new Error('Identificador serializado da foto indisponível.');
  const result = await message.client.pupPage.evaluate(async (messageId) => {
    let stage = 'lookup';
    try {
      const { Msg } = window.require('WAWebCollections');
      const msg = Msg.get(messageId) || (await Msg.getMessagesById([messageId]))?.messages?.[0];
      if (!msg?.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
      stage = 'download';
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
      if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return null;
      stage = 'blob';
      const cached = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.get(msg.mediaObject?.filehash);
      const blob = cached || msg.mediaObject?.mediaBlob?.forceToBlob();
      if (!blob) return null;
      stage = 'encode';
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(await blob.arrayBuffer()),
        mimetype: msg.mimetype, filename: msg.filename, filesize: msg.size,
      };
    } catch (error) {
      // Serialize inside the page: Puppeteer otherwise hides this as "r"/"t".
      return { downloadError: { stage, name: error?.name, message: error?.message || String(error) } };
    }
  }, id);
  if (result?.downloadError) {
    const { stage, name, message: detail } = result.downloadError;
    throw new Error(`${stage}: ${name || 'Error'}: ${detail}`);
  }
  return result;
}

module.exports = { downloadPhoto };
