const logger = require('./utils/logger');
const maintenanceService = require('./services/maintenance/receiptInfrastructureMaintenance.service');
const jobQueueService = require('./services/queue/jobQueue.service');
const redisClientService = require('./services/infrastructure/redisClient.service');

maintenanceService.runOnce('manual_cli').catch((error) => {
  logger.error('Rotina de manutencao finalizou com erro.', {
    error: error.message,
  });
  process.exitCode = 1;
}).finally(async () => {
  await jobQueueService.close().catch(() => undefined);
  await redisClientService.closeAll().catch(() => undefined);
});
