const env = require('../../config/env');
const logger = require('../../utils/logger');
const assetStorageService = require('../ingestion/receiptAssetStorage.service');
const maintenanceService = require('../maintenance/receiptInfrastructureMaintenance.service');
const jobQueueService = require('../queue/jobQueue.service');
const processingService = require('../processing/receiptProcessing.service');
const processingStateRepository = require('../state/processingStateRepository.service');
const {
  computeRetryDelayMs,
  normalizeErrorPayload,
  summarizeProcessingResult,
} = require('../infrastructure/receiptInfrastructureSupport.service');

module.exports = {
  async processJob(job, { workerId = 'receipt-worker' } = {}) {
    const correlationId = job.correlationId || (job.payload && job.payload.correlationId) || job.id;
    const attemptCount = Number(job.attempts || 1);
    const maxAttempts = Number(job.maxAttempts || env.receiptQueueMaxAttempts);
    try {
      await processingStateRepository.markProcessing(job.id, {
        workerId,
        correlationId,
        attemptCount,
        queue: {
          driverId: jobQueueService.driverId,
          status: 'processing',
        },
      });

      const result = await processingService.processCanonicalRequest({
        canonicalRequest: job.payload.canonicalRequest,
        asset: job.payload.asset,
        jobContext: {
          jobId: job.id,
          correlationId,
        },
      });
      const invoiceField = result.extraction
        && result.extraction.parsedDocument
        && result.extraction.parsedDocument.fields
        ? result.extraction.parsedDocument.fields.invoiceNumber
        : null;

      await processingStateRepository.markCompleted(job.id, {
        attemptCount,
        providerId: result.extraction.providerId,
        fallbackUsed: result.extraction.attempts.length > 1,
        queue: {
          driverId: jobQueueService.driverId,
          status: 'completed',
        },
        resultSummary: summarizeProcessingResult(result),
      });

      logger.info('Job de canhoto processado.', {
        queueDriver: jobQueueService.driverId,
        jobId: job.id,
        correlationId,
        providerId: result.extraction.providerId,
        providerAttempts: (result.extraction.attempts || []).map((attempt) => ({
          providerId: attempt.providerId,
          status: attempt.status,
          reason: attempt.reason || null,
        })),
        invoiceNumber: invoiceField && invoiceField.value ? String(invoiceField.value).trim() : null,
        classification: result.decision.classification,
        backendAction: result.backendSync ? result.backendSync.action : null,
      });
      return result;
    } catch (error) {
      const retryDelayMs = computeRetryDelayMs(attemptCount, env.receiptQueueBackoffMs);
      const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
      const normalizedError = normalizeErrorPayload(error);
      const willRetry = attemptCount < maxAttempts;

      if (willRetry) {
        await processingStateRepository.markRetryScheduled(job.id, {
          attemptCount,
          nextRetryAt,
          queue: {
            driverId: jobQueueService.driverId,
            status: 'queued',
          },
          error: normalizedError,
        });
      } else {
        await processingStateRepository.markFailed(job.id, {
          attemptCount,
          queue: {
            driverId: jobQueueService.driverId,
            status: 'failed',
          },
          error: normalizedError,
        });
      }

      logger.error('Falha ao processar job de canhoto.', {
        queueDriver: jobQueueService.driverId,
        jobId: job.id,
        correlationId,
        willRetry,
        error: error.message,
      });

      if (!willRetry) {
        await assetStorageService.deleteAsset(job.payload.asset).catch(() => undefined);
      }

      throw error;
    } finally {
      await maintenanceService.runIfDue('worker_job_cycle').catch(() => undefined);
    }
  },

  async runLoop({ workerId = 'receipt-worker', once = false } = {}) {
    await maintenanceService.runIfDue('worker_startup').catch(() => undefined);
    return jobQueueService.consume({
      workerId,
      once,
      processor: async (job) => this.processJob(job, { workerId }),
    });
  },
};
