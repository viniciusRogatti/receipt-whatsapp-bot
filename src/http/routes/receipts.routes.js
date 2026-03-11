const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const env = require('../../config/env');
const ingestionService = require('../../services/ingestion/receiptIngestion.service');
const jobQueueService = require('../../services/queue/jobQueue.service');
const processingStateRepository = require('../../services/state/processingStateRepository.service');
const { ensureDir } = require('../../utils/file');

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
  companyId: req.body.companyId,
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
  });

  router.post('/receipts/ingest', upload.single('image'), async (req, res) => {
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

  router.post('/sources/whatsapp/receipts', upload.single('image'), async (req, res) => {
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

  router.get('/receipts/jobs/:jobId', async (req, res) => {
    const job = await processingStateRepository.getJob(req.params.jobId);
    if (!job) {
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
