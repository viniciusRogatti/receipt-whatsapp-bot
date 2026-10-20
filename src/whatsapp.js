const apiService = require('./services/api.service');
const whatsappRuntimeService = require('./services/whatsappRuntime.service');
const logger = require('./utils/logger');
const { assertSupportedNode } = require('./utils/runtime');

assertSupportedNode('receipt-whatsapp-bot whatsapp');

let shuttingDown = false;

const shutdown = async (signal = 'shutdown') => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Encerrando runner do WhatsApp.', {
    signal,
  });

  await whatsappRuntimeService.stop().catch(() => undefined);
  await apiService.shutdown().catch(() => undefined);
};

process.on('SIGINT', () => {
  shutdown('SIGINT')
    .finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
    .finally(() => process.exit(0));
});

whatsappRuntimeService.start().then(client => {
  if (process.env.DRIVER_WHATSAPP_OUTBOX_ENABLED !== 'true') return;
  const { MessageMedia } = require('whatsapp-web.js');
  const { createOutboxWorker } = require('./services/driverWhatsappOutbox.service');
  const env = require('./config/env');
  const path = require('node:path');
  const whatsappService = require('./services/whatsapp.service');
  const workers = (process.env.DRIVER_WHATSAPP_OUTBOX_COMPANY_IDS || '1,2,3').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0).map(companyId => createOutboxWorker({ api: (route, options = {}) => apiService.occurrenceOutboxRequest(route, { ...options, companyScope: { id: companyId } }), client, MessageMedia, directory: path.join(env.whatsappMediaDir, 'astro-outbox', String(companyId)), logger,
    processReceipt: async ({ item, record }) => {
      const result = await whatsappService.handleIncomingTextMessage({ message: { id: record.messageId, groupId: item.groupId, groupName: item.groupName, chatId: item.groupId, timestamp: record.timestamp * 1000, caption: item.message, messageText: item.message, hasPhoto: true, imagePath: record.imagePath, sender: 'ASTRO · envio pelo bot' }, reply: async () => false });
      if (result?.ignored || result?.backendSync?.action === 'failed') throw new Error('RECEIPT_INGESTION_PENDING');
    } }));
  const poll = () => { if (!shuttingDown) for (const worker of workers) worker.tick().catch(() => logger.warn('Fila do ASTRO temporariamente indisponível.')); };
  const timer = setInterval(poll, 15000); timer.unref(); poll();
}).catch(async (error) => {
  logger.error('Falha ao iniciar o runner do WhatsApp.', {
    error: error.message,
  });
  await shutdown('startup_error');
  process.exit(1);
});
