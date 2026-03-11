const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const env = require('./config/env');
const { processImageForOcr } = require('./services/imagePreprocess.service');
const { ensureDir } = require('./utils/file');

const app = express();
const port = Number(process.env.PORT || 3000);
ensureDir(env.receiptIngressTmpDir).catch(() => undefined);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, env.receiptIngressTmpDir),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname || '') || '.bin';
      callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`);
    },
  }),
});

app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/process', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }

    const fileBuffer = await fs.promises.readFile(req.file.path);
    const processedImages = await processImageForOcr(fileBuffer);
    await fs.promises.unlink(req.file.path).catch(() => undefined);

    return res.json({
      success: true,
      images: processedImages,
    });
  } catch (error) {
    if (req.file && req.file.path) {
      await fs.promises.unlink(req.file.path).catch(() => undefined);
    }
    console.error('Erro ao processar imagem:', error);
    return res.status(500).json({ error: 'Falha no processamento da imagem.' });
  }
});

app.listen(port, () => {
  console.log(`Laboratorio visual rodando em http://localhost:${port}`);
});
