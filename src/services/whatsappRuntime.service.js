const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const env = require('../config/env');
const logger = require('../utils/logger');
const { ensureDir, removeFile } = require('../utils/file');
const whatsappService = require('./whatsapp.service');
const {
  isGroupAllowed,
  isGroupMessage,
  isImageMimeType,
  parseTextCommand,
  resolveMediaFileName,
} = require('./whatsappRuntimeSupport.service');

let activeClient = null;

const extractPhoneDigits = (value) => {
  const match = String(value || '').match(/^(\d+)(?:@|$)/);
  return match ? match[1] : null;
};

const sanitizeSegment = (value, fallback = 'group') => {
  const normalized = String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const buildPuppeteerOptions = () => {
  const args = env.whatsappBrowserArgs.length
    ? env.whatsappBrowserArgs.slice()
    : ['--no-sandbox', '--disable-setuid-sandbox'];

  const options = {
    headless: env.whatsappHeadless,
    args,
  };

  if (env.whatsappBrowserExecutablePath) {
    options.executablePath = env.whatsappBrowserExecutablePath;
  }

  return options;
};

const buildClient = () => new Client({
  authStrategy: new LocalAuth({
    clientId: env.whatsappClientId,
    dataPath: env.whatsappSessionDir,
  }),
  puppeteer: buildPuppeteerOptions(),
});

const buildHelpMessage = () => (
  [
    'Comandos disponiveis:',
    `${env.whatsappCommandPrefix} status`,
    `${env.whatsappCommandPrefix} ajuda`,
  ].join('\n')
);

const buildStatusMessage = () => (
  env.receiptAsyncWhatsappMode
    ? 'Bot online. O modo assincrono esta ativo e as imagens novas serao apenas enfileiradas.'
    : `Bot online. O modo atual processa imagens novas e sincroniza o backend em modo ${env.receiptBackendSyncMode}.`
);

const replyIfEnabled = async (message, text) => {
  if (!env.whatsappReplyEnabled) return false;
  await message.reply(text);
  return true;
};

const listAvailableGroups = async (client) => {
  if (!env.whatsappLogGroupsOnReady) return;

  const chats = await client.getChats();
  const groups = chats
    .filter((chat) => chat.isGroup)
    .map((chat) => ({
      id: chat.id && chat.id._serialized ? chat.id._serialized : String(chat.id || ''),
      name: chat.name || null,
    }));

  logger.info('Sessao do WhatsApp pronta com os grupos visiveis.', {
    totalGroups: groups.length,
    groups,
  });
};

const buildMessageContext = async (message, chat) => {
  const timestamp = Number(message.timestamp || 0);
  let contact = null;

  if (typeof message.getContact === 'function') {
    try {
      contact = await message.getContact();
    } catch (error) {
      logger.debug('Nao foi possivel resolver o contato do remetente no WhatsApp.', {
        chatId: message.from,
        error: error.message,
      });
    }
  }

  const senderId = message.author
    || (contact && contact.id && contact.id._serialized ? contact.id._serialized : null)
    || message._data && message._data.author
    || message._data && message._data.from
    || null;
  const senderPhone = contact && contact.number
    ? String(contact.number)
    : extractPhoneDigits(senderId);
  const senderContactName = contact && (contact.name || contact.shortName)
    ? String(contact.name || contact.shortName)
    : null;
  const senderName = contact && contact.pushname
    ? String(contact.pushname)
    : (message._data && message._data.notifyName ? String(message._data.notifyName) : null);
  const sender = senderContactName || senderName || senderPhone || senderId || null;

  return {
    id: message.id && message.id._serialized ? message.id._serialized : String(message.id || ''),
    companyId: env.receiptDefaultCompanyId,
    groupId: message.from,
    groupName: chat && chat.name ? chat.name : null,
    chatId: message.from,
    mediaId: message._data && message._data.id ? message._data.id.id : null,
    sender,
    senderId,
    senderPhone,
    senderName,
    senderContactName,
    timestamp: timestamp > 0 ? timestamp * 1000 : null,
  };
};

const downloadImageToDisk = async (messageContext, media) => {
  const fileName = resolveMediaFileName({
    mimeType: media.mimetype,
    originalFileName: media.filename || '',
    messageId: messageContext.id,
  });
  const groupSegment = sanitizeSegment(messageContext.groupName || messageContext.groupId, 'group');
  const targetDir = path.join(env.whatsappMediaDir, groupSegment);
  const targetPath = path.join(targetDir, `${Date.now()}-${fileName}`);

  await ensureDir(targetDir);
  await fs.promises.writeFile(targetPath, Buffer.from(media.data, 'base64'));
  return targetPath;
};

const handleTextCommand = async (message) => {
  if (!env.whatsappCommandsEnabled) return false;

  const command = parseTextCommand({
    body: message.body,
    prefix: env.whatsappCommandPrefix,
  });

  if (!command) return false;

  if (command.command === 'status' || command.command === 'ping') {
    await replyIfEnabled(message, buildStatusMessage());
    return true;
  }

  await replyIfEnabled(message, buildHelpMessage());
  return true;
};

const handleIncomingMedia = async (message, chat) => {
  const media = await whatsappService.downloadMedia(message, async (sourceMessage) => sourceMessage.downloadMedia());
  if (!media || !media.data || !isImageMimeType(media.mimetype)) {
    logger.debug('Midia ignorada por nao ser imagem.', {
      chatId: message.from,
      mimetype: media ? media.mimetype : null,
    });
    return;
  }

  const messageContext = await buildMessageContext(message, chat);
  const mediaPath = await downloadImageToDisk(messageContext, media);

  try {
    const result = await whatsappService.handleIncomingImageMessage({
      message: messageContext,
      mediaPath,
      reply: async (text) => replyIfEnabled(message, text),
      outputDir: path.join(process.cwd(), 'outputs', 'whatsapp', sanitizeSegment(messageContext.groupId, 'group')),
    });

    logger.info('Mensagem de imagem processada no WhatsApp.', {
      chatId: messageContext.chatId,
      groupName: messageContext.groupName,
      messageId: messageContext.id,
      classification: result.analysis && result.analysis.classification
        ? result.analysis.classification.classification
        : null,
      replied: result.replied,
      backendAction: result.backendSync ? result.backendSync.action : null,
      backendSyncError: result.backendSyncError ? result.backendSyncError.message : null,
      queued: !!result.queued,
    });
  } finally {
    await removeFile(mediaPath);
  }
};

const handleMessage = async (message) => {
  if (!message || message.fromMe) return;
  if (!isGroupMessage(message.from)) return;

  const chat = await message.getChat();
  if (!chat || !chat.isGroup) return;

  if (!isGroupAllowed({
    groupId: message.from,
    groupName: chat.name,
    allowedGroupIds: env.whatsappAllowedGroupIds,
    allowedGroupNames: env.whatsappAllowedGroupNames,
  })) {
    logger.debug('Mensagem de grupo ignorada por nao estar na allowlist.', {
      chatId: message.from,
      groupName: chat.name || null,
    });
    return;
  }

  if (message.hasMedia) {
    await handleIncomingMedia(message, chat);
    return;
  }

  await handleTextCommand(message);
};

module.exports = {
  async start() {
    if (activeClient) return activeClient;

    await ensureDir(env.whatsappSessionDir);
    await ensureDir(env.whatsappMediaDir);

    const client = buildClient();

    client.on('qr', (qr) => {
      logger.info('QR do WhatsApp gerado. Escaneie com o telefone que participa do grupo.', {
        clientId: env.whatsappClientId,
      });
      qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      logger.info('Sessao do WhatsApp autenticada.', {
        clientId: env.whatsappClientId,
      });
    });

    client.on('ready', async () => {
      logger.info('Cliente do WhatsApp conectado.', {
        clientId: env.whatsappClientId,
        asyncMode: env.receiptAsyncWhatsappMode,
        backendSyncMode: env.receiptBackendSyncMode,
      });
      if (env.receiptAsyncWhatsappMode) {
        logger.warn('Modo assincrono ativo no WhatsApp. O bot vai enfileirar imagens, mas nao respondera no grupo apos o worker concluir.', {
          clientId: env.whatsappClientId,
        });
      }
      await listAvailableGroups(client).catch((error) => {
        logger.warn('Falha ao listar grupos disponiveis do WhatsApp.', {
          error: error.message,
        });
      });
    });

    client.on('auth_failure', (message) => {
      logger.error('Falha de autenticacao no WhatsApp.', {
        clientId: env.whatsappClientId,
        details: message,
      });
    });

    client.on('disconnected', (reason) => {
      logger.warn('Cliente do WhatsApp desconectado.', {
        clientId: env.whatsappClientId,
        reason,
      });
    });

    client.on('message', (message) => {
      handleMessage(message).catch(async (error) => {
        logger.error('Falha ao processar mensagem recebida no WhatsApp.', {
          error: error.message,
          chatId: message && message.from ? message.from : null,
        });

        if (message && env.whatsappReplyEnabled && env.whatsappReplyOnOperationalFailure) {
          await message.reply('Houve uma falha ao processar essa mensagem agora. Tente novamente em instantes.').catch(() => undefined);
        }
      });
    });

    await client.initialize();
    activeClient = client;
    return client;
  },

  async stop() {
    if (!activeClient) return;

    const currentClient = activeClient;
    activeClient = null;
    await currentClient.destroy().catch(() => undefined);
  },
};
