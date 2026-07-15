const { Client, LocalAuth } = require('whatsapp-web.js');
const env = require('../src/config/env');
const whatsappService = require('../src/services/whatsapp.service');
const { isGroupAllowed, resolveWhatsappGroupPolicy } = require('../src/services/whatsappRuntimeSupport.service');

const parseArgs = (argv = []) => argv.reduce((result, token) => {
  const match = String(token || '').match(/^--([^=]+)=(.*)$/);
  if (match) result[match[1]] = match[2];
  return result;
}, {});

const args = parseArgs(process.argv.slice(2));
const targetDate = String(args.date || new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())).trim();
const fetchLimit = Math.max(100, Math.min(2000, Number(args.limit || 1000) || 1000));

const isTargetDate = (timestamp) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Number(timestamp || 0) * 1000)) === targetDate;

const messageText = (message) => String(
  message.body || message.caption || message._data?.caption || message._data?.body || '',
).trim();

const buildClient = () => new Client({
  authStrategy: new LocalAuth({
    clientId: env.whatsappClientId,
    dataPath: env.whatsappSessionDir,
  }),
  puppeteer: Object.assign({
    headless: env.whatsappHeadless,
    args: env.whatsappBrowserArgs.length ? env.whatsappBrowserArgs : ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: env.whatsappProtocolTimeoutMs,
  }, env.whatsappBrowserExecutablePath ? { executablePath: env.whatsappBrowserExecutablePath } : {}),
});

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('Use --date=YYYY-MM-DD.');

  const client = buildClient();
  const summary = {
    date: targetDate,
    groups: 0,
    messages: 0,
    photos: 0,
    processed: 0,
    delivered: 0,
    ignored: 0,
    review: 0,
    failed: 0,
  };

  await new Promise((resolve, reject) => {
    client.on('qr', () => reject(new Error('A sessao do WhatsApp da VPS precisa ser reconectada.')));
    client.on('auth_failure', (message) => reject(new Error(`Falha de autenticacao: ${message}`)));
    client.on('ready', async () => {
      try {
        const chats = await client.getChats();
        const groups = chats.filter((chat) => {
          if (!chat.isGroup) return false;
          const groupId = chat.id?._serialized || String(chat.id || '');
          const policy = resolveWhatsappGroupPolicy({ groupId, groupName: chat.name, groupPolicies: env.whatsappGroupPolicies });
          return Boolean(policy.companyCode) && isGroupAllowed({
            groupId,
            groupName: chat.name,
            allowedGroupIds: env.whatsappAllowedGroupIds,
            allowedGroupNames: env.whatsappAllowedGroupNames,
          });
        });

        summary.groups = groups.length;
        for (const chat of groups) {
          // eslint-disable-next-line no-await-in-loop
          const messages = await chat.fetchMessages({ limit: fetchLimit });
          const todayMessages = messages.filter((message) => isTargetDate(message.timestamp) && !message.fromMe);
          summary.messages += todayMessages.length;

          for (const message of todayMessages) {
            if (!message.hasMedia) continue;
            summary.photos += 1;
            const groupId = chat.id?._serialized || String(chat.id || '');
            const result = await whatsappService.handleIncomingTextMessage({
              message: {
                id: message.id?._serialized || String(message.id || ''),
                groupId,
                groupName: chat.name || null,
                chatId: groupId,
                mediaId: message._data?.id?.id || null,
                timestamp: Number(message.timestamp || 0) * 1000,
                messageText: messageText(message),
                caption: messageText(message),
                body: messageText(message),
              },
            });

            if (result?.ignored) {
              summary.ignored += 1;
              continue;
            }
            summary.processed += 1;
            if (result?.backendSync?.action === 'mark_invoice_delivered') summary.delivered += 1;
            else if (result?.backendSync?.action === 'create_receipt_alert') summary.review += 1;
          }
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    client.initialize().catch(reject);
  });

  await client.destroy().catch(() => undefined);
  console.log(`RECOVERY_SUMMARY:${JSON.stringify(summary)}`);
}

main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
