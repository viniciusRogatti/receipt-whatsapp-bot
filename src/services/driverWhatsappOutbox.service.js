const fs = require('node:fs/promises');
const path = require('node:path');
// All transports are injected: unit tests never connect to WhatsApp or the real API.
function createOutboxWorker({ api, client, MessageMedia, directory, processReceipt, logger }) {
  let busy = false;
  const fileFor = id => path.join(directory, `${Number(id)}.json`);
  async function read(id) { try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
  async function write(id, data) { const file = fileFor(id); await fs.writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); await fs.rename(file + '.tmp', file); }
  async function finish(item, record) {
    await api(`/${item.id}/complete`, { method: 'POST', body: { status: 'sent', messageId: record.messageId, groupId: item.groupId } });
    if (item.kind === 'receipt' && !record.synced) {
      await processReceipt({ item, record });
      record.synced = true; await write(item.id, record);
      await fs.rm(record.imagePath, { force: true });
    }
  }
  async function processItem(candidate) {
    let item;
    try { item = await api(`/${candidate.id}/claim`, { method: 'POST', body: {} }); }
    catch(e) { if(e.status === 409) return; throw e; }
    const previous = await read(item.id);
    if (previous?.messageId) { await finish(item, previous); return; }
    // A crash/network error after a send starts has an ambiguous result. Never resend blindly.
    if (item.recovery || previous?.attempted) {
      await api(`/${item.id}/complete`, { method: 'POST', body: { status: 'uncertain', reason: 'SEND_REQUIRES_GROUP_REVIEW' } }); return;
    }
    let imagePath;
    try {
      const chat = await client.getChatById(item.groupId);
      if (!chat?.isGroup || chat.id?._serialized !== item.groupId) throw new Error('INVALID_GROUP');
      if (item.kind === 'receipt' && (!/^\d+$/.test(item.message) || !item.evidence)) throw new Error('INVALID_RECEIPT');
      let media;
      if (item.evidence) {
        if (item.evidence.mimeType !== 'image/jpeg' || typeof item.evidence.base64 !== 'string') throw new Error('INVALID_PHOTO');
        const bytes = Buffer.from(item.evidence.base64, 'base64');
        if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('INVALID_PHOTO');
        imagePath = path.join(directory, `${Number(item.id)}.jpg`);
        await fs.writeFile(imagePath, bytes, { mode: 0o600 });
        media = new MessageMedia('image/jpeg', bytes.toString('base64'), 'foto.jpg');
      }
      const storedItem = { ...item }; delete storedItem.evidence;
      await write(item.id, { attempted: true, item: storedItem, imagePath });
      let sent;
      try { sent = await client.sendMessage(item.groupId, media || item.message, media ? { caption: item.message, sendSeen: false } : { sendSeen: false }); }
      catch(e) { await api(`/${item.id}/complete`, { method: 'POST', body: { status: 'uncertain', reason: 'WHATSAPP_SEND_UNCERTAIN' } }); return; }
      const messageId = sent?.id?._serialized;
      if (!messageId) { await api(`/${item.id}/complete`, { method: 'POST', body: { status: 'uncertain', reason: 'WHATSAPP_CONFIRMATION_MISSING' } }); return; }
      const record = { attempted: true, item: storedItem, imagePath, messageId, timestamp: Number(sent.timestamp) || Math.floor(Date.now()/1000), synced: false };
      await write(item.id, record);
      await finish(item, record);
      if (item.kind !== 'receipt' && imagePath) await fs.rm(imagePath, { force: true });
    } catch(e) {
      const stored = await read(item.id);
      if (!stored?.attempted) await api(`/${item.id}/complete`, { method: 'POST', body: { status: 'failed', reason: 'SEND_PREPARATION_FAILED' } });
      throw e;
    }
  }
  async function tick() {
    if(busy) return; busy = true;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Recover bot-confirmed receipts whose ingestion was interrupted, without resending the photo.
      for(const name of await fs.readdir(directory)) {
        if (!/^\d+\.json$/.test(name)) continue;
        const record = await read(Number(name.slice(0,-5)));
        if(record?.messageId && record.item.kind === 'receipt' && !record.synced) {
          try { await finish(record.item, record); } catch(e) { logger.warn('Canhoto enviado aguarda reconhecimento.', { outboundId: record.item.id }); }
        }
      }
      const result = await api('/outbox');
      for(const item of result.items || []) { try { await processItem(item); } catch(e) { logger.warn('Envio do ASTRO aguarda tratativa.', { outboundId: item.id, code: e.code || 'OUTBOX_FAILED' }); } }
    } finally { busy = false; }
  }
  return { tick };
}
module.exports = { createOutboxWorker };
