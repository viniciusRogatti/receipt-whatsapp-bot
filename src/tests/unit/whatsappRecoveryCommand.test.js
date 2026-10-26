const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../../../scripts/recoverPendingWhatsappMessages.js');
const actualRequire = createRequire(filename);
const { Message } = require('whatsapp-web.js');
const group = { id: '120363111@g.us', name: 'Pronto sintético' };
const policy = { companyCode: 'pronto', companyId: 3, processingMode: 'caption_only' };
const timestamp = Date.parse('2026-10-26T14:00:00-03:00') / 1000;
const photo = { id: 'false_120363111@g.us_PHOTO_5511000000000@c.us', mediaId: 'PHOTO', timestamp, hasMedia: true, type: 'image', body: '1234567', author: '5511000000000@c.us' };

async function execute({ dryRun = false, brokenMedia = false, messages = [photo], limit = 1000 } = {}) {
  const captured = { writes: [], downloads: 0, readyRecovery: 0, destroyed: 0, logs: [], errors: [] };
  const fakeProcess = { argv: ['node', filename, '--date=2026-10-26', `--limit=${limit}`, `--dry-run=${dryRun}`], exitCode: 0 };
  class Client extends EventEmitter {
    constructor() {
      super();
      this.pupPage = {
        isClosed: () => false, waitForFunction: async () => {},
        evaluate: async (_fn, argument) => {
          if (typeof argument === 'string') {
            assert.equal(argument, photo.id);
            captured.downloads++;
            if (brokenMedia) throw new Error('Falha sintética ao baixar foto');
            return { mimetype: 'image/jpeg', data: Buffer.from('synthetic receipt bytes').toString('base64') };
          }
          return argument?.chatId ? messages : [group];
        },
      };
    }
    async initialize() { assert.equal(captured.readyRecovery, 1, 'ready recovery precisa estar instalado antes de inicializar'); this.emit('ready'); this.emit('ready'); }
    async destroy() { captured.destroyed++; }
  }
  const mocks = {
    'whatsapp-web.js': { Client, LocalAuth: class {}, Message },
    '../src/services/whatsappReadyRecovery.service': { installReadyRecovery: () => { captured.readyRecovery++; } },
    '../src/config/env': { whatsappBrowserArgs: [], whatsappAllowedGroupIds: [group.id], whatsappAllowedGroupNames: [], whatsappGroupPolicies: {} },
    '../src/utils/logger': { info() {}, warn() {}, error() {} },
    '../src/services/api.service': { getWhatsappGroupPolicies: async () => ({ policies: { [group.id]: policy } }) },
    '../src/services/whatsapp.service': { handleIncomingTextMessage: async payload => {
      const message = payload.message;
      assert.equal(fs.readFileSync(message.imagePath, 'utf8'), 'synthetic receipt bytes');
      assert.equal(message.expectedCompanyId, '3');
      assert.equal(message.timestamp, timestamp * 1000);
      captured.writes.push(message);
      return { backendSync: { action: 'mark_invoice_delivered', lookup: { invoice: { status: 'assigned' } } } };
    } },
  };
  await vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: request => Object.hasOwn(mocks, request) ? mocks[request] : actualRequire(request),
    process: fakeProcess, setTimeout, console: {
      log: value => captured.logs.push(value), warn() {}, error: value => captured.errors.push(value),
    },
  }, { filename });
  captured.exitCode = fakeProcess.exitCode;
  const line = captured.logs.find(value => value.startsWith('RECOVERY_SUMMARY:'));
  captured.summary = line ? JSON.parse(line.slice('RECOVERY_SUMMARY:'.length)) : null;
  return captured;
}
module.exports = () => [
  { name: 'Comando do botão baixa bytes, usa políticas da API e processa apenas o dia uma vez', run: async () => {
    const result = await execute({ messages: [photo, { ...photo, timestamp: timestamp - 86400 }, { ...photo, fromMe: true }, { ...photo, isNotification: true }] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.downloads, 1);
    assert.equal(result.writes.length, 1, result.errors.join(' '));
    assert.equal(result.summary.delivered, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.destroyed, 1);
    assert.equal(fs.existsSync(result.writes[0].imagePath), false);
  } },
  { name: 'Comando do botão não registra entrega se o download falha e informa a falha', run: async () => {
    const result = await execute({ brokenMedia: true });
    assert.equal(result.writes.length, 0);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.delivered, 0);
  } },
  { name: 'Diagnóstico seco do comando baixa foto mas não registra entrega', run: async () => {
    const result = await execute({ dryRun: true });
    assert.equal(result.downloads, 1);
    assert.equal(result.writes.length, 0);
    assert.equal(result.summary.downloaded, 1);
  } },
  { name: 'Comando interrompe histórico incompleto em vez de informar recuperação total', run: async () => {
    const result = await execute({ messages: Array(100).fill(photo), limit: 100 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary, null);
    assert.equal(result.writes.length, 0);
    assert.equal(result.destroyed, 1);
    assert.match(result.errors.join(' '), /histórico atingiu o limite/);
  } },
];
