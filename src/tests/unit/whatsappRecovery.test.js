const assert = require('assert');
const fs = require('fs/promises');
const { Message } = require('whatsapp-web.js');
const { installMessageIdentityCompatibility } = require('../../services/whatsappMessageIdentity.service');
const { resolveWhatsappMessageId } = require('../../services/whatsappRuntimeSupport.service');
const { recoverPhoto } = require('../../services/whatsappRecovery.service');
const { downloadPhoto } = require('../../services/whatsappPhotoDownload.service');

const id = 'false_120363111@g.us_PHOTO_5511000000000@c.us';
const group = { id: '120363111@g.us', name: 'Grupo de teste' };
const policy = { companyCode: 'pronto', companyId: 2 };
function photo() {
  return {
    id: { _serialized: id, id: 'PHOTO' }, from: group.id, author: '5511000000000@c.us',
    timestamp: 1793012400, body: '1234567',
    downloadMedia: async () => ({ mimetype: 'image/jpeg', data: Buffer.from('synthetic photo').toString('base64') }),
  };
}
module.exports = () => [
  { name: 'Download usa blob original e refaz download mesmo com cache RESOLVED vazio', run: async () => {
    const previousWindow = global.window;
    let downloads = 0;
    const bytes = Buffer.from('original image');
    const blob = new Blob([bytes]);
    const msg = { mediaData: { mediaStage: 'RESOLVED' }, mimetype: 'image/jpeg', mediaObject: { filehash: 'hash', mediaBlob: { forceToBlob: () => blob } }, downloadMedia: async options => { downloads++; assert.strictEqual(options.isUserInitiated, true); } };
    global.window = {
      require: name => name === 'WAWebCollections' ? { Msg: { get: value => { assert.strictEqual(value, id); return msg; } } } : { InMemoryMediaBlobCache: { get: () => null } },
      WWebJS: { arrayBufferToBase64Async: data => Buffer.from(data).toString('base64') },
    };
    try {
      const message = { id: { $1: id }, client: { pupPage: { evaluate: (fn, arg) => fn(arg) } } };
      const result = await downloadPhoto(message);
      assert.strictEqual(result.data, bytes.toString('base64'));
      assert.strictEqual(downloads, 1);
      msg.downloadMedia = async () => { throw new Error('download rejected'); };
      await assert.rejects(() => downloadPhoto(message), /download: Error: download rejected/);
    } finally { global.window = previousWindow; }
  } },
  { name: 'WhatsApp usa o ID $1 completo no SDK e no comprovante, preservando participante', run: async () => {
    installMessageIdentityCompatibility(Message);
    installMessageIdentityCompatibility(Message);
    let requestedId;
    const client = { pupPage: { evaluate: async (_, value) => { requestedId = value; return { data: 'dGVzdA==', mimetype: 'image/jpeg' }; } } };
    const message = new Message(client, { id: { $1: id }, from: group.id, directPath: '/photo', type: 'image' });
    await message.downloadMedia();
    assert.strictEqual(requestedId, id);
    assert.strictEqual(resolveWhatsappMessageId(message), id);
    assert.strictEqual(resolveWhatsappMessageId({ id: { $1: id } }), id);
    const legacy = new Message(client, { id: { _serialized: id, $1: 'different' }, from: group.id });
    assert.strictEqual(legacy.id._serialized, id);
  } },
  { name: 'Recuperação entrega foto real, horário original, empresa e ID ao fluxo normal', run: async () => {
    let savedPath;
    const result = await recoverPhoto({ message: photo(), group, policy, processReceipt: async ({ message }) => {
      savedPath = message.imagePath;
      assert.strictEqual(await fs.readFile(savedPath, 'utf8'), 'synthetic photo');
      assert.strictEqual(message.timestamp, 1793012400000);
      assert.strictEqual(message.expectedCompanyCode, 'pronto');
      assert.strictEqual(message.expectedCompanyId, 2);
      assert.strictEqual(message.id, id);
      assert.strictEqual(message.senderId, photo().author);
      return { backendSync: { action: 'mark_invoice_delivered' } };
    } });
    assert.strictEqual(result.backendSync.action, 'mark_invoice_delivered');
    await assert.rejects(() => fs.access(savedPath));
  } },
  { name: 'Recuperação seca baixa foto sem chamar API nem responder ao grupo', run: async () => {
    const result = await recoverPhoto({ message: photo(), group, policy, dryRun: true, processReceipt: () => assert.fail('API chamada') });
    assert.deepStrictEqual(result, { downloaded: true });
  } },
  { name: 'Recuperação rejeita grupo divergente e falha de mídia antes da baixa', run: async () => {
    const processReceipt = () => assert.fail('API chamada');
    await assert.rejects(() => recoverPhoto({ message: photo(), group: { id: 'other@g.us' }, policy, processReceipt }), /grupo/);
    await assert.rejects(() => recoverPhoto({ message: { ...photo(), downloadMedia: async () => { throw new Error('r'); } }, group, policy, processReceipt }), error => error.code === 'WHATSAPP_MEDIA_DOWNLOAD_FAILED');
  } },
  { name: 'Recuperação ignora legenda extra sem baixar mídia', run: async () => {
    const result = await recoverPhoto({ message: { ...photo(), body: 'obrigado 1234567', downloadMedia: () => assert.fail('Download chamado') }, group, policy, processReceipt: () => assert.fail('API chamada') });
    assert.strictEqual(result.ignored, true);
  } },
];
