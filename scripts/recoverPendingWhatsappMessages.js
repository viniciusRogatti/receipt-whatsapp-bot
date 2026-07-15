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
let recoveryClient = null;

const isTargetDate = (timestamp) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Number(timestamp || 0) * 1000)) === targetDate;

const messageText = (message) => String(
  message.body || message.caption || '',
).trim();

const listRawGroups = (client) => client.pupPage.evaluate(() => window
  .require('WAWebCollections')
  .Chat
  .getModelsArray()
  .map((chat) => ({
    id: chat.id?._serialized || '',
    name: chat.formattedTitle || chat.name || chat.contact?.name || null,
  }))
  .filter((chat) => chat.id.endsWith('@g.us')));

const fetchRawMessages = (client, groupId, limit) => client.pupPage.evaluate(async ({ chatId, fetchCount }) => {
  const chatWid = window.require('WAWebWidFactory').createWid(chatId);
  const chats = window.require('WAWebCollections').Chat;
  const chat = chats.get(chatWid) || (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
  if (!chat) return [];

  let messages = chat.msgs.getModelsArray();
  let loadAttempts = 0;
  while (messages.length < fetchCount && loadAttempts < 100) {
    loadAttempts += 1;
    let loaded;
    try {
      loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
    } catch (_error) {
      break;
    }
    if (!loaded?.length) break;
    const knownIds = new Set(messages.map((message) => message.id?._serialized || String(message.id || '')));
    const newMessages = loaded.filter((message) => !knownIds.has(message.id?._serialized || String(message.id || '')));
    if (!newMessages.length) break;
    messages = [...newMessages, ...messages];
  }

  messages.sort((left, right) => Number(left.t || 0) - Number(right.t || 0));
  return messages.slice(-fetchCount).map((message) => ({
    id: message.id?._serialized || String(message.id || ''),
    mediaId: message.id?.id || null,
    fromMe: Boolean(message.id?.fromMe),
    isNotification: Boolean(message.isNotification),
    timestamp: Number(message.t || 0),
    hasMedia: Boolean(message.directPath),
    body: String(message.caption || message.body || ''),
  }));
}, { chatId: groupId, fetchCount: limit });

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
  recoveryClient = client;
  const summary = {
    date: targetDate,
    groups: 0,
    messages: 0,
    photos: 0,
    processed: 0,
    delivered: 0,
    alreadyDelivered: 0,
    ignored: 0,
    review: 0,
    failed: 0,
  };

  await new Promise((resolve, reject) => {
    client.on('qr', () => reject(new Error('A sessao do WhatsApp da VPS precisa ser reconectada.')));
    client.on('auth_failure', (message) => reject(new Error(`Falha de autenticacao: ${message}`)));
    client.on('ready', async () => {
      try {
        const configuredGroupIds = Array.from(new Set([
          ...env.whatsappAllowedGroupIds,
          ...Object.keys(env.whatsappGroupPolicies || {}).filter((key) => String(key).endsWith('@g.us')),
        ]));
        const groupsById = new Map();
        try {
          const availableChats = await listRawGroups(client);
          availableChats.forEach((chat) => {
            const groupId = chat.id;
            const policy = resolveWhatsappGroupPolicy({ groupId, groupName: chat.name, groupPolicies: env.whatsappGroupPolicies });
            if (policy.companyCode && isGroupAllowed({
              groupId,
              groupName: chat.name,
              allowedGroupIds: env.whatsappAllowedGroupIds,
              allowedGroupNames: env.whatsappAllowedGroupNames,
            })) groupsById.set(groupId, chat);
          });
        } catch (error) {
          console.warn(`Nao foi possivel listar os grupos; usando IDs configurados: ${error.message}`);
        }

        for (const groupId of configuredGroupIds) {
          if (groupsById.has(groupId)) continue;
          const policy = resolveWhatsappGroupPolicy({ groupId, groupPolicies: env.whatsappGroupPolicies });
          if (!policy.companyCode || !isGroupAllowed({
            groupId,
            groupName: null,
            allowedGroupIds: env.whatsappAllowedGroupIds,
            allowedGroupNames: env.whatsappAllowedGroupNames,
          })) continue;
          // eslint-disable-next-line no-await-in-loop
          groupsById.set(groupId, { id: groupId, name: null });
        }

        const groups = Array.from(groupsById.values());
        summary.groups = groups.length;
        for (const chat of groups) {
          // eslint-disable-next-line no-await-in-loop
          const messages = await fetchRawMessages(client, chat.id, fetchLimit);
          const todayMessages = messages.filter((message) => isTargetDate(message.timestamp) && !message.fromMe && !message.isNotification);
          summary.messages += todayMessages.length;

          for (const message of todayMessages) {
            if (!message.hasMedia) continue;
            summary.photos += 1;
            try {
              const groupId = chat.id;
              const result = await whatsappService.handleIncomingTextMessage({
                message: {
                  id: message.id?._serialized || String(message.id || ''),
                  groupId,
                  groupName: chat.name || null,
                  chatId: groupId,
                  mediaId: message.mediaId,
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
              if (result?.backendSync?.action === 'mark_invoice_delivered') {
                const previousStatus = String(result?.backendSync?.lookup?.invoice?.status || '').toLowerCase();
                const activityAlreadyExisted = result?.backendSync?.activity?.created === false
                  && result?.backendSync?.activity?.skipped !== true;
                if (previousStatus === 'delivered' || activityAlreadyExisted) summary.alreadyDelivered += 1;
                else summary.delivered += 1;
              } else if (result?.backendSync?.action === 'create_receipt_alert') summary.review += 1;
            } catch (error) {
              summary.failed += 1;
              console.error(`Falha ao recuperar mensagem ${message.id || '-'}: ${error.message}`);
            }
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
  recoveryClient = null;
  console.log(`RECOVERY_SUMMARY:${JSON.stringify(summary)}`);
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await recoveryClient?.destroy().catch(() => undefined);
  process.exitCode = 1;
});
