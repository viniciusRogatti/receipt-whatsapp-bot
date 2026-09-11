const assert = require('assert');
const fs = require('fs/promises');
const { withDownloadedPhoto } = require('../../services/whatsappMedia.service');
module.exports = () => [
  { name: 'WhatsApp mantém a foto disponível durante o envio e limpa depois', run: async () => {
    let storedPath;
    const result = await withDownloadedPhoto({ downloadMedia: async () => ({ mimetype: 'image/jpeg', data: Buffer.from('test image bytes').toString('base64') }) }, async (imagePath) => {
      storedPath = imagePath;
      assert.strictEqual(await fs.readFile(imagePath, 'utf8'), 'test image bytes');
      return { uploaded: true };
    });
    assert.strictEqual(result.uploaded, true);
    await assert.rejects(() => fs.access(storedPath));
  } },
  { name: 'WhatsApp não confirma processamento quando o download falha', run: async () => {
    let consumed = false;
    await assert.rejects(() => withDownloadedPhoto({ downloadMedia: async () => null }, () => { consumed = true; }), /baixada/);
    assert.strictEqual(consumed, false);
  } },
  { name: 'WhatsApp propaga a falha do backend e remove arquivo temporário', run: async () => {
    let storedPath;
    await assert.rejects(() => withDownloadedPhoto({ downloadMedia: async () => ({ mimetype: 'image/png', data: Buffer.from('test').toString('base64') }) }, async (imagePath) => {
      storedPath = imagePath; throw new Error('backend indisponível');
    }), /backend indisponível/);
    await assert.rejects(() => fs.access(storedPath));
  } },
];
