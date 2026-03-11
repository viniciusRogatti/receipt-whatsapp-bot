const env = require('../../config/env');

const DRIVERS = {
  file: () => require('./fileJobQueue.service'),
  bullmq: () => require('./bullmqJobQueue.service'),
};

let cachedQueue = null;

const getQueue = () => {
  if (cachedQueue) return cachedQueue;

  const driverFactory = DRIVERS[String(env.receiptJobQueueDriver || 'file').trim()];
  if (!driverFactory) {
    throw new Error(`Driver de fila nao suportado: ${env.receiptJobQueueDriver}.`);
  }

  cachedQueue = driverFactory();
  return cachedQueue;
};

module.exports = new Proxy({}, {
  get(_target, property) {
    const queue = getQueue();
    const value = queue[property];

    if (typeof value === 'function') {
      return value.bind(queue);
    }

    return value;
  },
});
