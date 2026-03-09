const env = require('./config/env');
const logger = require('./utils/logger');
const { assertSupportedNode } = require('./utils/runtime');

assertSupportedNode('receipt-whatsapp-bot');

logger.info('Projeto receipt-whatsapp-bot pronto.', {
  botEnv: env.botEnv,
  nextStep: 'Use npm run test:local para processar imagens, npm run debug:ui para a depuracao visual ou npm test para validar as regras basicas.',
});
