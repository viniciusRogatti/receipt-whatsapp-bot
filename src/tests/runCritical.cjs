require('./criticalNoNetwork.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-bot-critical-'));
process.env.RECEIPT_INGEST_TMP_DIR = tmp;
const suites = ['apiService', 'whatsappRuntimeSupport', 'whatsappService', 'whatsappCaption', 'whatsappReadyRecovery', 'whatsappMedia', 'whatsappRecovery', 'whatsappRecoveryCommand'];
(async () => {
  let passed = 0;
  for (const suite of suites) for (const test of require(`./unit/${suite}.test.js`)()) {
    await test.run();
    passed++;
    console.log('PASS ' + test.name);
  }
  console.log(`PASS ${passed} testes críticos do bot, sem WhatsApp/API reais.`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
