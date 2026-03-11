const env = require('../../config/env');

const DRIVERS = {
  file: () => require('./fileProcessingStateRepository.service'),
  redis: () => require('./redisProcessingStateRepository.service'),
};

let cachedRepository = null;

const getRepository = () => {
  if (cachedRepository) return cachedRepository;

  const driverFactory = DRIVERS[String(env.receiptProcessingStateRepositoryDriver || 'file').trim()];
  if (!driverFactory) {
    throw new Error(`Driver de state repository nao suportado: ${env.receiptProcessingStateRepositoryDriver}.`);
  }

  cachedRepository = driverFactory();
  return cachedRepository;
};

module.exports = new Proxy({}, {
  get(_target, property) {
    const repository = getRepository();
    const value = repository[property];

    if (typeof value === 'function') {
      return value.bind(repository);
    }

    return value;
  },
});
