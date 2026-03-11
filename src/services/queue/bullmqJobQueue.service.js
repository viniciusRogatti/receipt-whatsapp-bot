const env = require('../../config/env');
const logger = require('../../utils/logger');
const redisClientService = require('../infrastructure/redisClient.service');

let queuePromise = null;
const activeConsumers = new Set();

const getBullmq = () => require('bullmq');

const getQueue = async () => {
  if (!queuePromise) {
    queuePromise = (async () => {
      const { Queue } = getBullmq();
      const connection = await redisClientService.getClient('bullmq_queue');
      return new Queue(env.receiptQueueName, {
        connection,
        prefix: env.receiptRedisPrefix,
        defaultJobOptions: {
          attempts: env.receiptQueueMaxAttempts,
          backoff: {
            type: 'exponential',
            delay: env.receiptQueueBackoffMs,
          },
          removeOnComplete: {
            age: env.receiptQueueRemoveOnCompleteAgeSeconds,
            count: env.receiptQueueRemoveOnCompleteCount,
          },
          removeOnFail: {
            age: env.receiptQueueRemoveOnFailAgeSeconds,
            count: env.receiptQueueRemoveOnFailCount,
          },
        },
      });
    })().catch((error) => {
      queuePromise = null;
      throw error;
    });
  }

  return queuePromise;
};

const normalizeBullJob = async (job) => {
  const state = await job.getState();

  return {
    id: job.id,
    type: job.name,
    status: state,
    attempts: Number(job.attemptsMade || 0) + 1,
    maxAttempts: Number(job.opts.attempts || env.receiptQueueMaxAttempts),
    payload: job.data,
    correlationId: job.data && job.data.correlationId ? job.data.correlationId : job.id,
    raw: job,
  };
};

module.exports = {
  driverId: 'bullmq',

  async enqueue({ jobId, payload = {}, maxAttempts = env.receiptQueueMaxAttempts } = {}) {
    const queue = await getQueue();
    const job = await queue.add('receipt_ingest', payload, {
      jobId,
      attempts: maxAttempts,
      backoff: {
        type: 'exponential',
        delay: env.receiptQueueBackoffMs,
      },
    });

    logger.info('Job de canhoto enfileirado.', {
      queueDriver: this.driverId,
      jobId: job.id,
      correlationId: payload.correlationId || job.id,
      companyId: payload.companyId || null,
      source: payload.source || null,
      documentType: payload.documentType || null,
    });

    return {
      id: job.id,
      status: 'queued',
      attempts: 0,
      maxAttempts,
      payload,
      queueName: env.receiptQueueName,
    };
  },

  async getJob(jobId) {
    const queue = await getQueue();
    const job = await queue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    return {
      id: job.id,
      status: state,
      attemptsMade: Number(job.attemptsMade || 0),
      timestamp: job.timestamp,
      processedOn: job.processedOn || null,
      finishedOn: job.finishedOn || null,
    };
  },

  async consume({ workerId = 'receipt-worker', once = false, processor }) {
    const { Worker, QueueEvents } = getBullmq();
    const workerConnection = await redisClientService.getClient(`bullmq_worker_${workerId}`);
    const eventsConnection = await redisClientService.getClient(`bullmq_events_${workerId}`);
    const queueEvents = new QueueEvents(env.receiptQueueName, {
      connection: eventsConnection,
      prefix: env.receiptRedisPrefix,
    });
    const worker = new Worker(env.receiptQueueName, async (job) => {
      const normalizedJob = await normalizeBullJob(job);
      logger.info('Job de canhoto reivindicado pelo worker.', {
        queueDriver: this.driverId,
        jobId: normalizedJob.id,
        correlationId: normalizedJob.correlationId,
        attemptCount: normalizedJob.attempts,
        workerId,
      });
      return processor(normalizedJob);
    }, {
      connection: workerConnection,
      prefix: env.receiptRedisPrefix,
      concurrency: env.receiptQueueConcurrency,
    });
    activeConsumers.add({
      worker,
      queueEvents,
    });

    await Promise.all([
      worker.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    queueEvents.on('completed', ({ jobId }) => {
      logger.info('Job finalizado na fila.', {
        queueDriver: this.driverId,
        jobId,
      });
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.warn('Job falhou na fila.', {
        queueDriver: this.driverId,
        jobId,
        failedReason,
      });
    });

    queueEvents.on('stalled', ({ jobId }) => {
      logger.warn('Job estagnado detectado na fila.', {
        queueDriver: this.driverId,
        jobId,
      });
    });

    if (!once) {
      return new Promise((resolve, reject) => {
        worker.on('error', reject);
        queueEvents.on('error', reject);
        worker.on('closed', resolve);
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(async () => {
        if (settled) return;
        settled = true;
        activeConsumers.forEach((consumer) => {
          if (consumer.worker === worker) activeConsumers.delete(consumer);
        });
        await worker.close().catch(() => undefined);
        await queueEvents.close().catch(() => undefined);
        resolve(null);
      }, env.receiptQueueOnceIdleMs);

      const finish = async (result, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeConsumers.forEach((consumer) => {
          if (consumer.worker === worker) activeConsumers.delete(consumer);
        });
        await worker.close().catch(() => undefined);
        await queueEvents.close().catch(() => undefined);
        if (error) reject(error);
        else resolve(result);
      };

      worker.on('completed', async (_job, result) => {
        await finish(result || null);
      });

      worker.on('failed', async () => {
        await finish(null);
      });

      worker.on('error', async (error) => {
        await finish(null, error);
      });

      queueEvents.on('error', async (error) => {
        await finish(null, error);
      });
    });
  },

  async cleanup() {
    const queue = await getQueue();
    const completed = await queue.clean(
      env.receiptQueueRemoveOnCompleteAgeSeconds * 1000,
      1000,
      'completed',
    ).catch(() => []);
    const failed = await queue.clean(
      env.receiptQueueRemoveOnFailAgeSeconds * 1000,
      1000,
      'failed',
    ).catch(() => []);

    return {
      deletedCount: completed.length + failed.length,
    };
  },

  async close() {
    const consumers = Array.from(activeConsumers.values());
    activeConsumers.clear();
    await Promise.all(consumers.map(async (consumer) => {
      await consumer.worker.close().catch(() => undefined);
      await consumer.queueEvents.close().catch(() => undefined);
    }));

    if (!queuePromise) return;
    const queue = await queuePromise.catch(() => null);
    queuePromise = null;
    if (queue) {
      await queue.close().catch(() => undefined);
    }
  },
};
