const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const debugSessionService = require('./debugSession.service');

const jobs = new Map();
const STAGE_ORDER = [
  'setup',
  'preprocess',
  'orientation',
  'global_ocr',
  'region_ocr',
  'field_detection',
  'nf_extraction',
  'classification',
  'debug_assets',
];

const buildStages = () => STAGE_ORDER.reduce((accumulator, step) => {
  accumulator[step] = {
    status: 'idle',
    updatedAt: null,
    message: '',
  };
  return accumulator;
}, {});

const cloneJobForResponse = (job) => ({
  id: job.id,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  status: job.status,
  sourceLabel: job.sourceLabel,
  stages: job.stages,
  logs: job.logs,
  result: job.result,
  error: job.error,
});

const markJobUpdated = (job) => {
  job.updatedAt = new Date().toISOString();
};

const appendLog = (job, entry) => {
  job.logs.push(Object.assign({
    at: new Date().toISOString(),
    level: 'info',
  }, entry));
  if (job.logs.length > 200) {
    job.logs = job.logs.slice(-200);
  }
  markJobUpdated(job);
};

const updateStage = (job, payload) => {
  if (!payload.step || !job.stages[payload.step]) {
    appendLog(job, {
      level: payload.status === 'failed' ? 'error' : 'info',
      message: payload.message || payload.step || 'Evento de debug.',
    });
    return;
  }

  job.stages[payload.step] = {
    status: payload.status || 'running',
    updatedAt: payload.at || new Date().toISOString(),
    message: payload.message || '',
    data: payload.data || null,
  };

  appendLog(job, {
    level: payload.status === 'failed' ? 'error' : payload.status === 'completed' ? 'success' : 'info',
    message: payload.message || payload.step,
  });
};

const unlinkIfExists = async (targetPath) => {
  if (!targetPath) return;
  try {
    await fs.promises.unlink(targetPath);
  } catch {
    // arquivo temporario ja foi removido
  }
};

const runJob = async (job, execute) => {
  try {
    job.status = 'running';
    markJobUpdated(job);

    const result = await execute({
      onProgress: (event) => updateStage(job, event),
    });

    job.result = result;
    job.status = 'completed';
    appendLog(job, {
      level: 'success',
      message: `Sessao ${result.sessionId} concluida.`,
    });
  } catch (error) {
    job.status = 'failed';
    job.error = {
      message: error.message,
    };
    appendLog(job, {
      level: 'error',
      message: error.message,
    });
    logger.error('Falha ao executar job de debug local.', {
      jobId: job.id,
      error: error.message,
    });
  } finally {
    markJobUpdated(job);
  }
};

module.exports = {
  async createTestImageJob({ relativePath }) {
    const sourcePath = debugSessionService.resolveTestImagePath(relativePath);
    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      sourceLabel: relativePath,
      stages: buildStages(),
      logs: [],
      result: null,
      error: null,
    };

    jobs.set(job.id, job);
    appendLog(job, {
      message: `Job criado para a imagem ${relativePath}.`,
    });

    setImmediate(() => {
      runJob(job, ({ onProgress }) => debugSessionService.createSession({
        sourceImagePath: sourcePath,
        displayName: path.basename(relativePath),
        sourceKind: 'test-image',
        onProgress,
      }));
    });

    return cloneJobForResponse(job);
  },

  async createUploadJob({ filePath, originalName }) {
    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      sourceLabel: originalName,
      stages: buildStages(),
      logs: [],
      result: null,
      error: null,
    };

    jobs.set(job.id, job);
    appendLog(job, {
      message: `Job criado para upload ${originalName}.`,
    });

    setImmediate(() => {
      runJob(job, async ({ onProgress }) => {
        try {
          return await debugSessionService.createSession({
            sourceImagePath: filePath,
            displayName: originalName,
            sourceKind: 'upload',
            onProgress,
          });
        } finally {
          await unlinkIfExists(filePath);
        }
      });
    });

    return cloneJobForResponse(job);
  },

  getJob(jobId) {
    const job = jobs.get(jobId);
    return job ? cloneJobForResponse(job) : null;
  },
};
