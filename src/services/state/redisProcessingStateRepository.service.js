const env = require('../../config/env');
const logger = require('../../utils/logger');
const redisClientService = require('../infrastructure/redisClient.service');
const {
  appendEvent,
  isTerminalStatus,
} = require('../infrastructure/receiptInfrastructureSupport.service');

const getRedisKey = (jobId) => `${env.receiptRedisPrefix}:state:${jobId}`;

const readRecord = async (jobId) => {
  const client = await redisClientService.getClient('state_repository');
  const raw = await client.get(getRedisKey(jobId));
  return raw ? JSON.parse(raw) : null;
};

const writeRecord = async (jobId, record) => {
  const client = await redisClientService.getClient('state_repository');
  await client.set(getRedisKey(jobId), JSON.stringify(record));
  return record;
};

const mergeRecord = (currentRecord, patch = {}) => {
  const nextRecord = Object.assign({}, currentRecord, patch, {
    queue: Object.assign({}, currentRecord.queue || {}, patch.queue || {}),
    asset: patch.asset !== undefined
      ? patch.asset
      : (currentRecord.asset || null),
    resultSummary: patch.resultSummary !== undefined
      ? patch.resultSummary
      : (currentRecord.resultSummary || null),
    error: patch.error !== undefined
      ? patch.error
      : (currentRecord.error || null),
    updatedAt: new Date().toISOString(),
  });

  if (patch.event) {
    nextRecord.events = appendEvent(currentRecord.events, patch.event);
  } else {
    nextRecord.events = Array.isArray(currentRecord.events) ? currentRecord.events.slice() : [];
  }

  delete nextRecord.event;
  return nextRecord;
};

const updateStatus = async (jobId, patch = {}) => {
  const currentRecord = await readRecord(jobId);
  if (!currentRecord) {
    throw new Error(`Job ${jobId} nao encontrado no state repository Redis.`);
  }

  return writeRecord(jobId, mergeRecord(currentRecord, patch));
};

module.exports = {
  driverId: 'redis',

  async createJob(record = {}) {
    const persistedRecord = Object.assign({}, record, {
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || new Date().toISOString(),
      events: appendEvent([], {
        type: 'created',
        data: {
          status: record.status || 'created',
        },
      }),
    });

    return writeRecord(record.jobId, persistedRecord);
  },

  async markQueued(jobId, patch = {}) {
    return updateStatus(jobId, Object.assign({}, patch, {
      status: 'queued',
      event: {
        type: 'queued',
        data: {
          attemptCount: patch.attemptCount || 0,
          nextRetryAt: patch.nextRetryAt || null,
        },
      },
    }));
  },

  async markProcessing(jobId, patch = {}) {
    return updateStatus(jobId, Object.assign({}, patch, {
      status: 'processing',
      startedAt: patch.startedAt || new Date().toISOString(),
      event: {
        type: 'processing',
        data: {
          attemptCount: patch.attemptCount || 1,
          workerId: patch.workerId || null,
        },
      },
    }));
  },

  async markRetryScheduled(jobId, patch = {}) {
    return updateStatus(jobId, Object.assign({}, patch, {
      status: 'queued',
      event: {
        type: 'retry_scheduled',
        data: {
          attemptCount: patch.attemptCount || null,
          nextRetryAt: patch.nextRetryAt || null,
        },
      },
    }));
  },

  async markCompleted(jobId, patch = {}) {
    return updateStatus(jobId, Object.assign({}, patch, {
      status: 'completed',
      completedAt: patch.completedAt || new Date().toISOString(),
      error: null,
      event: {
        type: 'completed',
        data: {
          providerId: patch.providerId || null,
          classification: patch.resultSummary && patch.resultSummary.classification
            ? patch.resultSummary.classification
            : null,
        },
      },
    }));
  },

  async markFailed(jobId, patch = {}) {
    return updateStatus(jobId, Object.assign({}, patch, {
      status: 'failed',
      failedAt: patch.failedAt || new Date().toISOString(),
      event: {
        type: 'failed',
        data: {
          attemptCount: patch.attemptCount || null,
          message: patch.error && patch.error.message ? patch.error.message : null,
        },
      },
    }));
  },

  async getJob(jobId) {
    return readRecord(jobId);
  },

  async cleanup() {
    const client = await redisClientService.getClient('state_repository_cleanup');
    const pattern = `${env.receiptRedisPrefix}:state:*`;
    const ttlMs = Math.max(1, Number(env.receiptStateTtlHours || 168)) * 60 * 60 * 1000;
    const now = Date.now();
    let cursor = '0';
    let deletedCount = 0;

    do {
      const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      const keys = result[1] || [];

      for (const key of keys) {
        const raw = await client.get(key);
        if (!raw) continue;

        const record = JSON.parse(raw);
        if (!isTerminalStatus(record.status)) continue;

        const referenceDate = new Date(record.updatedAt || record.completedAt || record.failedAt || 0).getTime();
        if (!referenceDate || (now - referenceDate) < ttlMs) continue;

        await client.del(key);
        deletedCount += 1;
      }
    } while (cursor !== '0');

    if (deletedCount) {
      logger.info('Registros antigos de processamento removidos.', {
        repositoryDriver: 'redis',
        deletedCount,
      });
    }

    return {
      deletedCount,
    };
  },
};
