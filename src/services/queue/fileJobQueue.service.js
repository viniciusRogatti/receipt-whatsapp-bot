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
  async enqueue(payload = {}) {
    await ensureQueueDirs();
    const now = new Date().toISOString();
    const jobId = buildJobId();
    const job = {
      id: jobId,
      type: 'receipt_ingest',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      payload,
    };

    await writeJsonFile(getJobFilePath(jobId, 'queued'), job);

    logger.info('Job de canhoto enfileirado.', {
      jobId,
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
    const failedJob = Object.assign({}, job, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      error: errorPayload,
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

  __testables: {
    STATUS_DIRECTORIES,
    ensureQueueDirs,
    getJobFilePath,
    getQueueStatusDir,
  },
};
