const env = require('./config/env');
const logger = require('./utils/logger');
const { assertSupportedNode } = require('./utils/runtime');

assertSupportedNode('receipt-whatsapp-bot');

logger.info('Projeto receipt-whatsapp-bot pronto.', {
  botEnv: env.botEnv,
  nextStep: 'Use npm run api para a ingestao central, npm run worker para consumir jobs, npm run debug:ui para a depuracao visual ou npm test para validar as regras basicas.',
});
