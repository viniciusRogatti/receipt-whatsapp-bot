const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const env = require('../../config/env');
const ingestionService = require('../../services/ingestion/receiptIngestion.service');
const jobQueueService = require('../../services/queue/jobQueue.service');
const processingStateRepository = require('../../services/state/processingStateRepository.service');
const { ensureDir } = require('../../utils/file');
const profileResolver = require('../../services/processing/profileResolver.service');

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
]);

const parseMetadataField = (metadata) => {
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;

  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
};

const buildPayloadFromRequest = (req) => ({
  companyId: req.receiptApiCompanyId,
  source: req.body.source,
  documentType: req.body.documentType,
  imageUrl: req.body.imageUrl,
  requestId: req.body.requestId,
  metadata: parseMetadataField(req.body.metadata),
});

const buildUpload = (file) => (file
  ? {
    path: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
  }
  : null);

const cleanupTempUpload = async (file) => {
  if (!file || !file.path) return;
  await fs.promises.unlink(file.path).catch(() => undefined);
};

const authorizeReceiptApi = (req, res, next) => {
  const companyId = profileResolver.resolveCompanyIdFromCredentials({ headers: req.headers });
  if (!companyId) {
    return res.status(401).json({ error: 'INVALID_INGEST_CREDENTIALS' });
  }

  req.receiptApiCompanyId = companyId;
  return next();
};

const receiptApiRateLimiter = rateLimit({
  windowMs: env.receiptApiRateLimitWindowMs,
  limit: env.receiptApiRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RECEIPT_INGEST_RATE_LIMITED' },
});

const sendUploadError = async (error, req, res, next) => {
  if (!error) return next();
  await cleanupTempUpload(req.file);

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'RECEIPT_FILE_TOO_LARGE' });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code || 'INVALID_RECEIPT_UPLOAD' });
  }
  if (error.code === 'INVALID_RECEIPT_MIME_TYPE') {
    return res.status(415).json({ error: error.code });
  }
  return next(error);
};

const createRouter = () => {
  const router = express.Router();

  ensureDir(env.receiptIngressTmpDir).catch(() => undefined);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, env.receiptIngressTmpDir),
      filename: (_req, file, callback) => {
        const extension = path.extname(file.originalname || '') || '.bin';
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`;
        callback(null, fileName);
      },
    }),
    limits: {
      fileSize: env.receiptApiMaxFileBytes,
      files: 1,
      fields: 8,
      parts: 10,
      fieldSize: 1024 * 1024,
    },
    fileFilter: (_req, file, callback) => {
      if (ALLOWED_IMAGE_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
        return callback(null, true);
      }
      const error = new Error('Tipo de arquivo nao suportado.');
      error.code = 'INVALID_RECEIPT_MIME_TYPE';
      return callback(error);
    },
  });
  const receiveImage = (req, res, next) => upload.single('image')(req, res, (error) => (
    sendUploadError(error, req, res, next)
  ));

  router.post('/receipts/ingest', authorizeReceiptApi, receiptApiRateLimiter, receiveImage, async (req, res) => {
    try {
      const result = await ingestionService.ingestReceipt({
        payload: buildPayloadFromRequest(req),
        headers: req.headers,
        uploadedFile: buildUpload(req.file),
      });

      return res.status(202).json(Object.assign({}, result, {
        statusUrl: `/v1/receipts/jobs/${result.jobId}`,
      }));
    } catch (error) {
      await cleanupTempUpload(req.file);
      return res.status(400).json({
        error: error.message,
      });
    }
  });

  router.post('/sources/whatsapp/receipts', authorizeReceiptApi, receiptApiRateLimiter, receiveImage, async (req, res) => {
    try {
      const result = await ingestionService.ingestReceipt({
        payload: buildPayloadFromRequest(req),
        headers: req.headers,
        uploadedFile: buildUpload(req.file),
        sourceHint: 'whatsapp',
      });

      return res.status(202).json(Object.assign({}, result, {
        statusUrl: `/v1/receipts/jobs/${result.jobId}`,
      }));
    } catch (error) {
      await cleanupTempUpload(req.file);
      return res.status(400).json({
        error: error.message,
      });
    }
  });

  router.get('/receipts/jobs/:jobId', authorizeReceiptApi, receiptApiRateLimiter, async (req, res) => {
    const job = await processingStateRepository.getJob(req.params.jobId);
    if (!job || String(job.companyId || '') !== String(req.receiptApiCompanyId || '')) {
      return res.status(404).json({
        error: 'Job nao encontrado.',
      });
    }

    const queueMetadata = await jobQueueService.getJob(req.params.jobId).catch(() => null);

    return res.json(Object.assign({}, job, queueMetadata ? {
      queueMetadata,
    } : {}));
  });

  return router;
};

module.exports = createRouter;
module.exports.authorizeReceiptApi = authorizeReceiptApi;
module.exports.receiptApiRateLimiter = receiptApiRateLimiter;
module.exports.__testables = { buildPayloadFromRequest };
