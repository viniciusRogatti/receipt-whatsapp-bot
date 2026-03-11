const env = require('../../config/env');
const logger = require('../../utils/logger');
const queueService = require('../queue/fileJobQueue.service');
const processingService = require('../processing/receiptProcessing.service');

const sleep = (delayMs) => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

module.exports = {
  async processNextJob({ workerId = 'receipt-worker' } = {}) {
    const job = await queueService.claimNextJob(workerId);
    if (!job) return null;

    try {
      const result = await processingService.processCanonicalRequest({
        canonicalRequest: job.payload.canonicalRequest,
        asset: job.payload.asset,
      });
      await queueService.completeJob(job.id, result);
      logger.info('Job de canhoto processado.', {
        jobId: job.id,
        providerId: result.extraction.providerId,
        classification: result.decision.classification,
      });
      return result;
    } catch (error) {
      await queueService.failJob(job.id, {
        message: error.message,
      });
      logger.error('Falha ao processar job de canhoto.', {
        jobId: job.id,
        error: error.message,
      });
      return null;
    }
  },

  async runLoop({ workerId = 'receipt-worker', once = false } = {}) {
    do {
      const result = await this.processNextJob({ workerId });
      if (once) return result;
      if (!result) {
        await sleep(env.receiptWorkerPollMs);
      }
    } while (true);
  },
};
