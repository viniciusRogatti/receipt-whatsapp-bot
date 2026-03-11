const logger = require('./utils/logger');
const workerService = require('./services/worker/receiptWorker.service');

const once = process.argv.includes('--once');

workerService.runLoop({
  workerId: once ? 'receipt-worker-once' : 'receipt-worker',
  once,
}).catch((error) => {
  logger.error('Worker de canhotos finalizou com erro.', {
    error: error.message,
  });
  process.exitCode = 1;
});
