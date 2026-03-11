const env = require('../config/env');
const logger = require('../utils/logger');
const createApp = require('./app');

const app = createApp();

app.listen(env.receiptApiPort, () => {
  logger.info('API central de ingestao pronta.', {
    port: env.receiptApiPort,
  });
});
