const fs = require('fs/promises');
const path = require('path');
const env = require('../config/env');
const { downloadPhoto } = require('./whatsappPhotoDownload.service');

// Keep the downloaded evidence until the backend has finished receiving it.
// Message IDs and incoming filenames are never used as filesystem paths.
async function withDownloadedPhoto(message, consume) {
  let media;
  try {
    media = await downloadPhoto(message);
  } catch (cause) {
    const error = new Error(`Falha ao baixar a foto do WhatsApp: ${cause?.message || cause}`);
    error.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
    error.cause = cause;
    throw error;
  }
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[media?.mimetype];
  if (!extension || typeof media?.data !== 'string' || !media.data.length) {
    throw new Error('A foto do WhatsApp não pôde ser baixada em formato suportado.');
  }
  if (media.data.length > Math.ceil(env.receiptApiMaxFileBytes / 3) * 4 + 4) {
    throw new Error('A foto excede o tamanho máximo permitido.');
  }
  const bytes = Buffer.from(media.data, 'base64');
  if (!bytes.length || bytes.length > env.receiptApiMaxFileBytes) throw new Error('Tamanho da foto inválido.');
  await fs.mkdir(env.receiptIngressTmpDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(env.receiptIngressTmpDir, 'whatsapp-'));
  const imagePath = path.join(directory, `receipt${extension}`);
  try {
    await fs.writeFile(imagePath, bytes, { mode: 0o600 });
    return await consume(imagePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { withDownloadedPhoto };
