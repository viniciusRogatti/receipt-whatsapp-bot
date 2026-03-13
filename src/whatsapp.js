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

whatsappRuntimeService.start().catch(async (error) => {
  logger.error('Falha ao iniciar o runner do WhatsApp.', {
    error: error.message,
  });
  await shutdown('startup_error');
  process.exitCode = 1;
});
