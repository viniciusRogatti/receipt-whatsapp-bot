const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const env = require('../config/env');
const logger = require('../utils/logger');
const { ensureDir } = require('../utils/file');
const whatsappService = require('./whatsapp.service');
const apiService = require('./api.service');
const whatsappConnectionStateService = require('./whatsappConnectionState.service');
const {
  isGroupAllowed,
  isGroupMessage,
  parseTextCommand,
  resolveWhatsappGroupPolicy,
} = require('./whatsappRuntimeSupport.service');

let activeClient = null;
let restartScheduled = false;
let healthcheckTimer = null;
let healthcheckFailures = 0;
let receiptCorrectionTimer = null;
let receiptCorrectionInFlight = false;
let stateWritePromise = Promise.resolve();
const groupNamesById = new Map();

const runtimeTelemetry = {
  heartbeatAt: null,
  whatsappState: null,
  lastMessageReceivedAt: null,
  lastMessageProcessedAt: null,
  lastIgnoredMessageAt: null,
  lastIgnoredReason: null,
  lastMessageErrorAt: null,
  lastMessageError: null,
};

const STARTUP_TIMEOUT_MS = 600000;
const AUTHENTICATED_READY_GRACE_MS = 30000;

const nowIso = () => new Date().toISOString();

const persistReadyState = (details = {}) => {
  Object.assign(runtimeTelemetry, details);
  stateWritePromise = stateWritePromise
    .catch(() => undefined)
    .then(() => whatsappConnectionStateService.writeConnectionState('ready', runtimeTelemetry));
  return stateWritePromise;
};

const clearHealthcheck = () => {
  if (!healthcheckTimer) return;
  clearInterval(healthcheckTimer);
  healthcheckTimer = null;
};

const clearReceiptCorrectionMonitor = () => {
  if (!receiptCorrectionTimer) return;
  clearInterval(receiptCorrectionTimer);
  receiptCorrectionTimer = null;
};

const recoverWhatsappMessageById = async (client, messageId) => {
  try {
    const directMessage = await client.getMessageById(messageId);
    if (directMessage) return directMessage;
  } catch {
    // Mensagens anteriores ao restart podem nao estar materializadas no Store.
    // Nesse caso carregamos o historico recente do grupo e procuramos pelo id completo.
  }

  const chatIdMatch = String(messageId || '').match(/^(?:true|false)_([^_]+)_/);
  const chatId = chatIdMatch ? chatIdMatch[1] : '';
  if (!chatId) return null;
  let chat = null;
  let messages = [];
  try {
    chat = await client.getChatById(chatId);
    if (!chat || typeof chat.fetchMessages !== 'function') return null;
    messages = await chat.fetchMessages({ limit: 500 });
  } catch (error) {
    throw new Error(`Falha ao carregar historico do grupo: ${String(error?.message || error || 'erro desconhecido')}`);
  }
  return messages.find((message) => (
    String(message?.id?._serialized || message?.id || '') === messageId
  )) || null;
};

const processPendingReceiptCorrections = async (client) => {
  if (receiptCorrectionInFlight || activeClient !== client) return;
  receiptCorrectionInFlight = true;
  try {
    const corrections = await apiService.listPendingReceiptCorrections();
    for (const correction of corrections) {
      const messageId = String(correction?.messageId || '').trim();
      const correctedInvoiceNumber = String(correction?.correctedInvoiceNumber || '').trim();
      if (!messageId || !correctedInvoiceNumber) continue;

      let tempFilePath = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        const message = await recoverWhatsappMessageById(client, messageId);
        if (!message || !message.hasMedia) throw new Error('A mensagem original nao possui mais uma foto recuperavel.');
        // eslint-disable-next-line no-await-in-loop
        let media = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          media = await message.downloadMedia();
        } catch (error) {
          throw new Error(`Falha ao baixar a foto original: ${String(error?.message || error || 'erro desconhecido')}`);
        }
        if (!media?.data || !String(media.mimetype || '').toLowerCase().startsWith('image/')) {
          throw new Error('A midia original nao e uma imagem valida.');
        }
        await ensureDir(env.receiptIngressTmpDir);
        const extension = String(media.mimetype).toLowerCase().includes('png')
          ? '.png'
          : String(media.mimetype).toLowerCase().includes('webp') ? '.webp' : '.jpg';
        tempFilePath = path.join(
          env.receiptIngressTmpDir,
          `correction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.writeFile(tempFilePath, Buffer.from(media.data, 'base64'));
        const companyScope = { id: Number(correction.companyId) || null };
        // eslint-disable-next-line no-await-in-loop
        await apiService.importRecoveredReceiptEvidence({
          invoiceNumber: correctedInvoiceNumber,
          imagePath: tempFilePath,
          companyScope,
          metadata: {
            source: 'whatsapp_correction',
            messageId,
            reportedInvoiceNumber: correction.reportedInvoiceNumber || null,
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await apiService.completePendingReceiptCorrection(correction.notificationId, companyScope);
        logger.info('Canhoto recuperado e vinculado a NF corrigida.', {
          reportedInvoiceNumber: correction.reportedInvoiceNumber || null,
          correctedInvoiceNumber,
          messageId,
        });
      } catch (error) {
        const companyScope = { id: Number(correction.companyId) || null };
        // eslint-disable-next-line no-await-in-loop
        await apiService.failPendingReceiptCorrection(
          correction.notificationId,
          error.message,
          companyScope,
        ).catch(() => undefined);
        logger.warn('Nao foi possivel concluir correcao de canhoto agora.', {
          correctedInvoiceNumber,
          messageId,
          error: error.message,
        });
      } finally {
        if (tempFilePath) {
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.unlink(tempFilePath).catch(() => undefined);
        }
      }
    }
  } finally {
    receiptCorrectionInFlight = false;
  }
};

const startReceiptCorrectionMonitor = (client) => {
  clearReceiptCorrectionMonitor();
  setTimeout(() => void processPendingReceiptCorrections(client), 5000);
  receiptCorrectionTimer = setInterval(() => void processPendingReceiptCorrections(client), 15000);
};

const recordMessageReceived = () => persistReadyState({
  lastMessageReceivedAt: nowIso(),
  lastMessageErrorAt: null,
  lastMessageError: null,
});

const recordMessageProcessed = () => persistReadyState({
  lastMessageProcessedAt: nowIso(),
  lastIgnoredMessageAt: null,
  lastIgnoredReason: null,
  lastMessageErrorAt: null,
  lastMessageError: null,
});

const recordIgnoredMessage = (reason) => persistReadyState({
  lastIgnoredMessageAt: nowIso(),
  lastIgnoredReason: String(reason || 'ignored').trim() || 'ignored',
  lastMessageErrorAt: null,
  lastMessageError: null,
});

const recordMessageError = (error) => persistReadyState({
  lastMessageErrorAt: nowIso(),
  lastMessageError: String(error?.message || error || 'unknown_error').trim() || 'unknown_error',
});

const extractPhoneDigits = (value) => {
  const match = String(value || '').match(/^(\d+)(?:@|$)/);
  return match ? match[1] : null;
};

const normalizeMessageText = (value) => String(value || '').trim();

const buildPuppeteerOptions = () => {
  const args = env.whatsappBrowserArgs.length
    ? env.whatsappBrowserArgs.slice()
    : ['--no-sandbox', '--disable-setuid-sandbox'];

  const options = {
    headless: env.whatsappHeadless,
    args,
    protocolTimeout: env.whatsappProtocolTimeoutMs,
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

const cleanupStaleSessionArtifacts = async () => {
  const candidatePaths = [
    path.join(env.whatsappSessionDir, `session-${env.whatsappClientId}`, 'SingletonLock'),
    path.join(env.whatsappSessionDir, `session-${env.whatsappClientId}`, 'SingletonCookie'),
    path.join(env.whatsappSessionDir, `session-${env.whatsappClientId}`, 'SingletonSocket'),
    path.join(env.whatsappSessionDir, `session-${env.whatsappClientId}`, 'DevToolsActivePort'),
    path.join(env.whatsappSessionDir, `session-${env.whatsappClientId}`, 'Default', 'LOCK'),
  ];
  const removed = [];

  await Promise.all(candidatePaths.map(async (targetPath) => {
    try {
      await fs.promises.unlink(targetPath);
      removed.push(path.relative(env.projectRoot, targetPath));
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      logger.warn('Falha ao limpar artefato antigo da sessao do WhatsApp.', {
        path: targetPath,
        error: error.message,
      });
    }
  }));

  if (removed.length) {
    logger.info('Artefatos antigos da sessao do WhatsApp foram removidos antes do startup.', {
      files: removed,
    });
  }
};

const scheduleProcessRestart = (reason) => {
  if (restartScheduled) return;
  restartScheduled = true;
  clearHealthcheck();

  logger.warn('Solicitando reinicio do processo do WhatsApp para recuperacao automatica.', {
    reason,
  });

  setTimeout(() => {
    process.exit(1);
  }, 250);
};

const startHealthcheck = (client) => {
  clearHealthcheck();
  healthcheckFailures = 0;

  const check = async () => {
    if (activeClient !== client || restartScheduled) return;

    try {
      const whatsappState = String(await client.getState() || 'unknown').trim().toUpperCase();
      healthcheckFailures = 0;
      await persistReadyState({
        heartbeatAt: nowIso(),
        whatsappState,
      });

      if (whatsappState === 'CONNECTED') return;

      logger.warn('Healthcheck detectou cliente do WhatsApp sem conexao ativa.', {
        clientId: env.whatsappClientId,
        whatsappState,
      });
      if (activeClient === client) activeClient = null;
      await whatsappConnectionStateService.writeConnectionState('disconnected', {
        reason: `healthcheck_${whatsappState.toLowerCase()}`,
      });
      scheduleProcessRestart(`healthcheck:${whatsappState}`);
    } catch (error) {
      healthcheckFailures += 1;
      logger.warn('Healthcheck nao conseguiu confirmar o cliente do WhatsApp.', {
        clientId: env.whatsappClientId,
        failures: healthcheckFailures,
        error: error.message,
      });
      if (healthcheckFailures < 2) return;

      if (activeClient === client) activeClient = null;
      await whatsappConnectionStateService.writeConnectionState('error', {
        reason: 'healthcheck_failed',
        message: error.message,
      });
      scheduleProcessRestart('healthcheck_failed');
    }
  };

  check().catch(() => undefined);
  healthcheckTimer = setInterval(() => {
    check().catch(() => undefined);
  }, env.whatsappHealthcheckMs);
};

const buildHelpMessage = () => (
  [
    'Comandos disponiveis:',
    `${env.whatsappCommandPrefix} status`,
    `${env.whatsappCommandPrefix} ajuda`,
  ].join('\n')
);

const buildStatusMessage = () => (
  env.receiptAsyncWhatsappMode
    ? 'Bot online. O modo assincrono esta ativo e as mensagens novas serao apenas enfileiradas.'
    : `Bot online. O modo atual processa mensagens novas e sincroniza o backend em modo ${env.receiptBackendSyncMode}.`
);

const replyIfEnabled = async (message, text) => {
  if (!env.whatsappReplyEnabled) return false;
  await message.reply(text);
  return true;
};

const listAvailableGroups = async (client) => {
  const groups = await client.pupPage.evaluate(() => window
    .require('WAWebCollections')
    .Chat
    .getModelsArray()
    .map((chat) => ({
      id: chat.id?._serialized || '',
      name: chat.formattedTitle || chat.name || chat.contact?.name || null,
    }))
    .filter((chat) => chat.id.endsWith('@g.us')));

  groupNamesById.clear();
  groups.forEach((group) => {
    if (group.id && group.name) groupNamesById.set(group.id, group.name);
  });

  if (!env.whatsappLogGroupsOnReady) return;

  logger.info('Sessao do WhatsApp pronta com os grupos visiveis.', {
    totalGroups: groups.length,
    groups,
  });
};

const buildMessageContext = async (message, chat) => {
  const timestamp = Number(message.timestamp || 0);
  const messageText = normalizeMessageText(
    message.body
    || message.caption
    || (message._data && (message._data.caption || message._data.body))
    || '',
  );
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
  const groupPolicy = resolveWhatsappGroupPolicy({
    groupId: message.from,
    groupName: chat && chat.name ? chat.name : null,
    groupPolicies: env.whatsappGroupPolicies,
  });

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
    messageText: messageText || null,
    caption: messageText || null,
    body: messageText || null,
    whatsappProcessingMode: groupPolicy.processingMode || 'caption_only',
    expectedCompanyCode: groupPolicy.companyCode || null,
    expectedCompanyId: groupPolicy.companyId || null,
    expectedCompanyName: groupPolicy.companyName || null,
  };
};

const resolveMessageGroupName = (message = {}) => normalizeMessageText(
  message.groupName
  || message._data?.chatName
  || message._data?.groupSubject
  || groupNamesById.get(message.from)
  || message._data?.notifyName
  || '',
) || null;

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
  const messageContext = await buildMessageContext(message, chat);
  let tempFilePath = null;
  try {
    // A baixa normal depende apenas da NF na legenda. Baixar a foto antes
    // disso fazia uma falha temporária da mídia impedir o processamento.
    const result = await whatsappService.handleIncomingTextMessage({
      message: messageContext,
      reply: async (text) => replyIfEnabled(message, text),
    });

    if (
      && result?.backendSync?.reason === 'invoice_not_found_from_message_text'
    ) {
      try {
        const media = await message.downloadMedia();
        if (media?.data && String(media.mimetype || '').toLowerCase().startsWith('image/')) {
          await ensureDir(env.receiptIngressTmpDir);
          const extension = String(media.mimetype).toLowerCase().includes('png')
            ? '.png'
            : String(media.mimetype).toLowerCase().includes('webp') ? '.webp' : '.jpg';
          tempFilePath = path.join(
            env.receiptIngressTmpDir,
            `whatsapp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`,
          );
          await fs.promises.writeFile(tempFilePath, Buffer.from(media.data, 'base64'));
          await apiService.storeUnidentifiedReceiptEvidence({
            imagePath: tempFilePath,
            messageId: messageContext.id,
            companyScope: { id: Number(messageContext.expectedCompanyId) || Number(messageContext.companyId) || null },
          });
        }
      } catch (error) {
        logger.warn('Nao foi possivel salvar a evidencia da foto sem NF identificada.', {
          chatId: messageContext.chatId,
          groupName: messageContext.groupName,
          messageId: messageContext.id,
          error: error.message,
        });
      }
    }

    if (result && result.ignored) {
      logger.debug('Midia ignorada porque o texto/caption nao trouxe NF candidata.', {
        chatId: messageContext.chatId,
        groupName: messageContext.groupName,
        messageId: messageContext.id,
      });
      return result;
    }

    logger.info('Mensagem com midia processada em modo texto no WhatsApp.', {
      chatId: messageContext.chatId,
      groupName: messageContext.groupName,
      messageId: messageContext.id,
      backendAction: result && result.backendSync ? result.backendSync.action : null,
      backendReason: result && result.backendSync ? result.backendSync.reason || null : null,
      replied: result ? result.replied : false,
    });
    return result;
  } finally {
    if (tempFilePath) await fs.promises.unlink(tempFilePath).catch(() => undefined);
  }
};

const handleIncomingText = async (message, chat) => {
  const messageContext = await buildMessageContext(message, chat);
  const result = await whatsappService.handleIncomingTextMessage({
    message: messageContext,
    reply: async (text) => replyIfEnabled(message, text),
  });

  if (result && result.ignored) {
    logger.debug('Mensagem de texto ignorada por nao conter NF candidata.', {
      chatId: messageContext.chatId,
      groupName: messageContext.groupName,
      messageId: messageContext.id,
    });
    return result;
  }

  logger.info('Mensagem de texto processada no WhatsApp.', {
    chatId: messageContext.chatId,
    groupName: messageContext.groupName,
    messageId: messageContext.id,
    backendAction: result && result.backendSync ? result.backendSync.action : null,
    backendReason: result && result.backendSync ? result.backendSync.reason || null : null,
    replied: result ? result.replied : false,
  });
  return result;
};

const handleMessage = async (message) => {
  if (!message || message.fromMe) return;
  if (!isGroupMessage(message.from)) return;

  await recordMessageReceived();
  const groupName = resolveMessageGroupName(message);
  const chat = { isGroup: true, name: groupName };

  if (!isGroupAllowed({
    groupId: message.from,
    groupName,
    allowedGroupIds: env.whatsappAllowedGroupIds,
    allowedGroupNames: env.whatsappAllowedGroupNames,
  })) {
    logger.debug('Mensagem de grupo ignorada por nao estar na allowlist.', {
      chatId: message.from,
      groupName,
    });
    await recordIgnoredMessage('group_not_allowed');
    return;
  }

  if (message.hasMedia) {
    const result = await handleIncomingMedia(message, chat);
    if (result?.ignored) await recordIgnoredMessage(result.reason);
    else await recordMessageProcessed();
    return;
  }

  const commandHandled = await handleTextCommand(message);
  if (commandHandled) {
    await recordMessageProcessed();
    return;
  }

  const result = await handleIncomingText(message, chat);
  if (result?.ignored) await recordIgnoredMessage(result.reason);
  else await recordMessageProcessed();
};

module.exports = {
  async start() {
    if (activeClient) return activeClient;

    await ensureDir(env.whatsappSessionDir);
    await cleanupStaleSessionArtifacts();
    restartScheduled = false;
    clearHealthcheck();
    Object.assign(runtimeTelemetry, {
      heartbeatAt: null,
      whatsappState: null,
      lastMessageReceivedAt: null,
      lastMessageProcessedAt: null,
      lastIgnoredMessageAt: null,
      lastIgnoredReason: null,
      lastMessageErrorAt: null,
      lastMessageError: null,
    });
    await whatsappConnectionStateService.writeConnectionState('starting')
      .catch((error) => logger.warn('Falha ao registrar inicio da conexao do WhatsApp.', {
        error: error.message,
      }));

    const client = buildClient();
    activeClient = client;

    let startupSettled = false;
    let startupTimeout = null;
    let authenticatedReadyTimeout = null;

    const clearStartupTimeout = () => {
      if (!startupTimeout) return;
      clearTimeout(startupTimeout);
      startupTimeout = null;
    };

    const clearAuthenticatedReadyTimeout = () => {
      if (!authenticatedReadyTimeout) return;
      clearTimeout(authenticatedReadyTimeout);
      authenticatedReadyTimeout = null;
    };

    const finalizeStartupSuccess = () => {
      if (startupSettled) return false;
      startupSettled = true;
      clearStartupTimeout();
      clearAuthenticatedReadyTimeout();
      return true;
    };

    const failStartup = async (error) => {
      if (startupSettled) return;
      startupSettled = true;
      clearStartupTimeout();
      clearAuthenticatedReadyTimeout();

      if (activeClient === client) {
        activeClient = null;
      }

      await client.destroy().catch(() => undefined);
      throw error;
    };

    client.on('qr', (qr) => {
      logger.info('QR do WhatsApp gerado. Escaneie com o telefone que participa do grupo.', {
        clientId: env.whatsappClientId,
      });
      whatsappConnectionStateService.writeConnectionState('qr_required', { qr })
        .catch((error) => logger.warn('Falha ao registrar QR do WhatsApp para recuperacao web.', {
          error: error.message,
        }));
      qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      logger.info('Sessao do WhatsApp autenticada.', {
        clientId: env.whatsappClientId,
      });
      whatsappConnectionStateService.writeConnectionState('authenticated')
        .catch((error) => logger.warn('Falha ao registrar autenticacao do WhatsApp.', {
          error: error.message,
        }));

      clearAuthenticatedReadyTimeout();
      authenticatedReadyTimeout = setTimeout(() => {
        if (startupSettled) return;

        logger.warn('Sessao autenticada, mas o cliente do WhatsApp nao ficou pronto dentro da tolerancia esperada.', {
          clientId: env.whatsappClientId,
          graceMs: AUTHENTICATED_READY_GRACE_MS,
        });

        scheduleProcessRestart('authenticated_without_ready_timeout');
      }, AUTHENTICATED_READY_GRACE_MS);
    });

    client.on('ready', async () => {
      logger.info('Cliente do WhatsApp conectado.', {
        clientId: env.whatsappClientId,
        asyncMode: env.receiptAsyncWhatsappMode,
        backendSyncMode: env.receiptBackendSyncMode,
      });
      await persistReadyState({
        heartbeatAt: nowIso(),
        whatsappState: 'CONNECTED',
      })
        .catch((error) => logger.warn('Falha ao registrar prontidao do WhatsApp.', {
          error: error.message,
        }));
      finalizeStartupSuccess();
      startHealthcheck(client);
      startReceiptCorrectionMonitor(client);
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
      clearHealthcheck();
      clearReceiptCorrectionMonitor();
      logger.error('Falha de autenticacao no WhatsApp.', {
        clientId: env.whatsappClientId,
        details: message,
      });
      whatsappConnectionStateService.writeConnectionState('auth_failure', {
        message,
        reason: 'auth_failure',
      }).catch(() => undefined);
      if (!startupSettled) {
        failStartup(new Error(`Falha de autenticacao no WhatsApp: ${message || 'auth_failure'}`))
          .catch(() => undefined);
        return;
      }
      if (activeClient === client) {
        activeClient = null;
      }
      scheduleProcessRestart('auth_failure');
    });

    client.on('disconnected', (reason) => {
      clearHealthcheck();
      clearReceiptCorrectionMonitor();
      logger.warn('Cliente do WhatsApp desconectado.', {
        clientId: env.whatsappClientId,
        reason,
      });
      whatsappConnectionStateService.writeConnectionState('disconnected', { reason })
        .catch(() => undefined);
      if (!startupSettled) {
        failStartup(new Error(`Cliente do WhatsApp desconectou antes do startup concluir: ${reason || 'unknown'}`))
          .catch(() => undefined);
        return;
      }
      if (activeClient === client) {
        activeClient = null;
      }
      scheduleProcessRestart(`disconnected:${reason || 'unknown'}`);
    });

    client.on('message', (message) => {
      handleMessage(message).catch(async (error) => {
        await recordMessageError(error).catch(() => undefined);
        logger.error('Falha ao processar mensagem recebida no WhatsApp.', {
          error: error.message,
          chatId: message && message.from ? message.from : null,
        });

        if (message && env.whatsappReplyEnabled && env.whatsappReplyOnOperationalFailure) {
          await message.reply('Houve uma falha ao processar essa mensagem agora. Tente novamente em instantes.').catch(() => undefined);
        }
      });
    });

    startupTimeout = setTimeout(() => {
      failStartup(new Error(`Tempo limite de inicializacao do WhatsApp excedido (${STARTUP_TIMEOUT_MS} ms).`))
        .catch((error) => {
          logger.error('Falha ao finalizar startup travado do WhatsApp.', {
            error: error.message,
          });
        });
    }, STARTUP_TIMEOUT_MS);

    try {
      await client.initialize();
    } catch (error) {
      await whatsappConnectionStateService.writeConnectionState('error', {
        message: error.message,
        reason: 'initialization_failure',
      }).catch(() => undefined);
      await failStartup(error);
    }

    if (!startupSettled) {
      await new Promise((resolve, reject) => {
        const poll = () => {
          if (startupSettled) {
            if (activeClient === client) {
              resolve();
              return;
            }

            reject(new Error('O cliente do WhatsApp falhou durante a inicializacao.'));
            return;
          }

          setTimeout(poll, 250);
        };

        poll();
      });
    }

    return client;
  },

  async stop() {
    restartScheduled = false;
    clearHealthcheck();
    clearReceiptCorrectionMonitor();
    if (!activeClient) {
      await whatsappConnectionStateService.writeConnectionState('stopped').catch(() => undefined);
      return;
    }

    const currentClient = activeClient;
    activeClient = null;
    await currentClient.destroy().catch(() => undefined);
    await whatsappConnectionStateService.writeConnectionState('stopped').catch(() => undefined);
  },
};
