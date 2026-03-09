const path = require('path');
const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const logger = require('../utils/logger');
const { ensureDir } = require('../utils/file');
const { assertSupportedNode } = require('../utils/runtime');
const debugSessionService = require('../services/debugSession.service');
const debugJobService = require('../services/debugJob.service');

const app = express();
const publicDir = path.join(__dirname, 'public');
const uploadTempDir = path.join(env.outputsDir, 'debug-temp-uploads');

const upload = multer({
  dest: uploadTempDir,
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
});

const asyncHandler = (handler) => async (request, response) => {
  try {
    await handler(request, response);
  } catch (error) {
    logger.error('Erro na interface local de debug.', {
      path: request.path,
      error: error.message,
    });
    response.status(400).json({
      error: error.message,
    });
  }
};

app.use(express.json({ limit: '2mb' }));
app.use('/debug-assets', express.static(env.outputsDir));
app.use('/debug-test-images', express.static(env.testImagesDir));
app.use('/debug-ui', express.static(publicDir));

app.get('/api/debug/test-images', asyncHandler(async (_request, response) => {
  const items = await debugSessionService.listAvailableTestImages();
  response.json({
    items,
  });
}));

app.post('/api/debug/jobs/test-image', asyncHandler(async (request, response) => {
  const relativePath = String(request.body && request.body.relativePath || '').trim();
  if (!relativePath) {
    throw new Error('Informe a imagem de teste que deve ser analisada.');
  }

  const job = await debugJobService.createTestImageJob({
    relativePath,
  });
  response.status(202).json(job);
}));

app.post('/api/debug/jobs/upload', upload.single('file'), asyncHandler(async (request, response) => {
  if (!request.file || !request.file.path) {
    throw new Error('Selecione um arquivo de imagem para o upload.');
  }

  const job = await debugJobService.createUploadJob({
    filePath: request.file.path,
    originalName: request.file.originalname || path.basename(request.file.path),
  });
  response.status(202).json(job);
}));

app.get('/api/debug/jobs/:jobId', asyncHandler(async (request, response) => {
  const job = debugJobService.getJob(request.params.jobId);
  if (!job) {
    response.status(404).json({
      error: 'Job nao encontrado.',
    });
    return;
  }

  response.json(job);
}));

app.get('/api/debug/sessions/:sessionId', asyncHandler(async (request, response) => {
  const session = await debugSessionService.readSession(request.params.sessionId);
  if (!session) {
    response.status(404).json({
      error: 'Sessao nao encontrada.',
    });
    return;
  }

  response.json(session);
}));

app.get('/', (_request, response) => {
  response.redirect('/debug-ui');
});

async function main() {
  assertSupportedNode('npm run debug:ui');

  await Promise.all([
    ensureDir(env.outputsDir),
    ensureDir(env.debugSessionsDir),
    ensureDir(uploadTempDir),
  ]);

  app.listen(env.debugServerPort, () => {
    logger.info('Interface local de debug pronta.', {
      port: env.debugServerPort,
      url: `http://localhost:${env.debugServerPort}/debug-ui`,
    });
  });
}

main().catch((error) => {
  logger.error('Falha ao subir a interface local de debug.', {
    error: error.message,
  });
  process.exitCode = 1;
});
