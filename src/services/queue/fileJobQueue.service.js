const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const {
  computeRetryDelayMs,
  normalizeErrorPayload,
} = require('../infrastructure/receiptInfrastructureSupport.service');
const {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} = require('../../utils/file');

const STATUS_DIRECTORIES = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
};

const buildJobId = () => {
  const compactTimestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const entropy = Math.random().toString(36).slice(2, 10);
  return `receipt-job-${compactTimestamp}-${entropy}`;
};

const getQueueStatusDir = (status) => path.join(env.receiptQueueDir, STATUS_DIRECTORIES[status]);
const getJobFilePath = (jobId, status) => path.join(getQueueStatusDir(status), `${jobId}.json`);
const sleep = (delayMs) => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

const ensureQueueDirs = async () => {
  await Promise.all(
    Object.keys(STATUS_DIRECTORIES).map((status) => ensureDir(getQueueStatusDir(status))),
  );
};

const loadJobIfExists = async (jobId, status) => {
  const filePath = getJobFilePath(jobId, status);
  if (!(await pathExists(filePath))) return null;

  return readJsonFile(filePath);
};

module.exports = {
  driverId: 'file',

  async enqueue(input = {}) {
    await ensureQueueDirs();
    const now = new Date().toISOString();
    const payload = input.payload ? input.payload : input;
    const jobId = input.jobId || buildJobId();
    const job = {
      id: jobId,
      type: 'receipt_ingest',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      attempts: Number(input.attempts || 0),
      maxAttempts: Number(input.maxAttempts || env.receiptQueueMaxAttempts),
      backoffDelayMs: Number(input.backoffDelayMs || env.receiptQueueBackoffMs),
      availableAt: input.availableAt || now,
      payload,
    };

    await writeJsonFile(getJobFilePath(jobId, 'queued'), job);

    logger.info('Job de canhoto enfileirado.', {
      queueDriver: this.driverId,
      jobId,
      correlationId: payload.correlationId || jobId,
      companyId: payload.companyId || null,
      source: payload.source || null,
      documentType: payload.documentType || null,
    });

    return job;
  },

  async claimNextJob(workerId = 'receipt-worker') {
    await ensureQueueDirs();
    const queuedDir = getQueueStatusDir('queued');
    const entries = (await fs.promises.readdir(queuedDir))
      .filter((fileName) => fileName.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));

    for (const fileName of entries) {
      const sourcePath = path.join(queuedDir, fileName);
      const targetPath = path.join(getQueueStatusDir('processing'), fileName);

      try {
        await fs.promises.rename(sourcePath, targetPath);
        const job = await readJsonFile(targetPath);
        const availableAt = new Date(job.availableAt || job.createdAt || 0).getTime();
        if (availableAt && availableAt > Date.now()) {
          await fs.promises.rename(targetPath, sourcePath);
          continue;
        }
        const claimedJob = Object.assign({}, job, {
          status: 'processing',
          attempts: Number(job.attempts || 0) + 1,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          workerId,
        });
        await writeJsonFile(targetPath, claimedJob);
        return claimedJob;
      } catch (error) {
        if (error && ['ENOENT', 'EACCES'].includes(error.code)) continue;
        throw error;
      }
    }

    return null;
  },

  async completeJob(jobId, result = {}) {
    await ensureQueueDirs();
    const processingPath = getJobFilePath(jobId, 'processing');
    const job = await readJsonFile(processingPath);
    const completedJob = Object.assign({}, job, {
      status: 'completed',
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result,
    });

    const completedPath = getJobFilePath(jobId, 'completed');
    await writeJsonFile(completedPath, completedJob);
    await fs.promises.unlink(processingPath).catch(() => undefined);
    return completedJob;
  },

  async failJob(jobId, errorPayload = {}) {
    await ensureQueueDirs();
    const processingPath = getJobFilePath(jobId, 'processing');
    const job = await readJsonFile(processingPath);
    const normalizedError = normalizeErrorPayload(errorPayload);
    const attempts = Number(job.attempts || 0);
    const maxAttempts = Number(job.maxAttempts || env.receiptQueueMaxAttempts);
    const shouldRetry = attempts < maxAttempts;

    if (shouldRetry) {
      const retryDelayMs = computeRetryDelayMs(attempts, job.backoffDelayMs || env.receiptQueueBackoffMs);
      const retryJob = Object.assign({}, job, {
        status: 'queued',
        updatedAt: new Date().toISOString(),
        error: normalizedError,
        nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
        availableAt: new Date(Date.now() + retryDelayMs).toISOString(),
      });

      await writeJsonFile(getJobFilePath(jobId, 'queued'), retryJob);
      await fs.promises.unlink(processingPath).catch(() => undefined);
      return retryJob;
    }

    const failedJob = Object.assign({}, job, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      error: normalizedError,
    });

    const failedPath = getJobFilePath(jobId, 'failed');
    await writeJsonFile(failedPath, failedJob);
    await fs.promises.unlink(processingPath).catch(() => undefined);
    return failedJob;
  },

  async getJob(jobId) {
    await ensureQueueDirs();

    for (const status of Object.keys(STATUS_DIRECTORIES)) {
      const job = await loadJobIfExists(jobId, status);
      if (job) return job;
    }

    return null;
  },

  async consume({ workerId = 'receipt-worker', once = false, processor }) {
    do {
      const job = await this.claimNextJob(workerId);

      if (!job) {
        if (once) return null;
        await sleep(env.receiptWorkerPollMs);
        continue;
      }

      logger.info('Job de canhoto reivindicado pelo worker.', {
        queueDriver: this.driverId,
        jobId: job.id,
        correlationId: job.payload && job.payload.correlationId ? job.payload.correlationId : job.id,
        attemptCount: job.attempts,
        workerId,
      });

      try {
        const result = await processor(job);
        await this.completeJob(job.id, result);
        if (once) return result;
      } catch (error) {
        const failedJob = await this.failJob(job.id, error);
        if (once) return null;

        if (failedJob.status === 'queued') {
          logger.warn('Job retornou para retry no driver file.', {
            queueDriver: this.driverId,
            jobId: failedJob.id,
            nextRetryAt: failedJob.nextRetryAt || null,
          });
        }
      }
    } while (true);
  },

  async cleanup() {
    await ensureQueueDirs();
    const ttlByStatus = {
      completed: env.receiptQueueTerminalTtlHours,
      failed: env.receiptQueueTerminalTtlHours,
    };
    let deletedCount = 0;

    await Promise.all(Object.keys(ttlByStatus).map(async (status) => {
      const dir = getQueueStatusDir(status);
      const exists = await pathExists(dir);
      if (!exists) return;

      const ttlMs = Math.max(1, Number(ttlByStatus[status] || 168)) * 60 * 60 * 1000;
      const entries = await fs.promises.readdir(dir).catch(() => []);

      await Promise.all(entries.map(async (entry) => {
        const filePath = path.join(dir, entry);
        const stats = await fs.promises.stat(filePath).catch(() => null);
        if (!stats || (Date.now() - stats.mtimeMs) < ttlMs) return;
        await fs.promises.unlink(filePath).catch(() => undefined);
        deletedCount += 1;
      }));
    }));

    return {
      deletedCount,
    };
  },

  async close() {
    return undefined;
  },

  __testables: {
    STATUS_DIRECTORIES,
    ensureQueueDirs,
    getJobFilePath,
    getQueueStatusDir,
  },
};
