const express = require('express');
const multer = require('multer');
const path = require('path');
const { processImageForOcr } = require('./services/imagePreprocess.service');

const app = express();
const port = Number(process.env.PORT || 3000);
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/process', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }

    const processedImages = await processImageForOcr(req.file.buffer);

    return res.json({
      success: true,
      images: processedImages,
    });
  } catch (error) {
    console.error('Erro ao processar imagem:', error);
    return res.status(500).json({ error: 'Falha no processamento da imagem.' });
  }
});

app.listen(port, () => {
  console.log(`Laboratorio visual rodando em http://localhost:${port}`);
});
