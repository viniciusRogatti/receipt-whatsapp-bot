const express = require('express');
const createReceiptsRouter = require('./routes/receipts.routes');

const createApp = () => {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'receipt-ingestion-api',
    });
  });

  app.use('/v1', createReceiptsRouter());

  return app;
};

module.exports = createApp;
