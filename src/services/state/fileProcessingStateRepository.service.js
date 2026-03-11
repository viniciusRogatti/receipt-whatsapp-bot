const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} = require('../../utils/file');
const {
  appendEvent,
  isTerminalStatus,
} = require('../infrastructure/receiptInfrastructureSupport.service');

const getStateFilePath = (jobId) => path.join(env.receiptStateDir, `${jobId}.json`);

const readRecord = async (jobId) => {
  const filePath = getStateFilePath(jobId);
  if (!(await pathExists(filePath))) return null;
  return readJsonFile(filePath);
};

const writeRecord = async (jobId, record) => {
  await ensureDir(env.receiptStateDir);
  await writeJsonFile(getStateFilePath(jobId), record);
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
    throw new Error(`Job ${jobId} nao encontrado no state repository local.`);
  }

  const nextRecord = mergeRecord(currentRecord, patch);
  return writeRecord(jobId, nextRecord);
};

const cleanupExpiredStates = async () => {
  await ensureDir(env.receiptStateDir);
  const entries = await fs.promises.readdir(env.receiptStateDir).catch(() => []);
  const now = Date.now();
  const ttlMs = Math.max(1, Number(env.receiptStateTtlHours || 168)) * 60 * 60 * 1000;
  let deletedCount = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(env.receiptStateDir, entry);
    const record = await readJsonFile(filePath).catch(() => null);
    if (!record || !isTerminalStatus(record.status)) continue;

    const referenceDate = new Date(record.updatedAt || record.completedAt || record.failedAt || 0).getTime();
    if (!referenceDate || (now - referenceDate) < ttlMs) continue;

    await fs.promises.unlink(filePath).catch(() => undefined);
    deletedCount += 1;
  }

  if (deletedCount) {
    logger.info('Registros antigos de processamento removidos.', {
      repositoryDriver: 'file',
      deletedCount,
    });
  }

  return {
    deletedCount,
  };
};

module.exports = {
  driverId: 'file',

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
    return cleanupExpiredStates();
  },
};
