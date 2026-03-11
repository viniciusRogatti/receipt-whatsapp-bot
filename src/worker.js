const logger = require('./utils/logger');
const redisClientService = require('./services/infrastructure/redisClient.service');
const jobQueueService = require('./services/queue/jobQueue.service');
const workerService = require('./services/worker/receiptWorker.service');

const once = process.argv.includes('--once');

const shutdown = async () => {
  await jobQueueService.close().catch(() => undefined);
  await redisClientService.closeAll().catch(() => undefined);
};

workerService.runLoop({
  workerId: once ? 'receipt-worker-once' : 'receipt-worker',
  once,
}).catch((error) => {
  logger.error('Worker de canhotos finalizou com erro.', {
    error: error.message,
  });
  process.exitCode = 1;
}).finally(async () => {
  await shutdown();
});
