const env = require('../../config/env');

const clients = new Map();

const buildRedisOptions = () => ({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

const createRedisClient = async (role = 'default') => {
  if (!env.receiptRedisUrl) {
    throw new Error('RECEIPT_REDIS_URL nao configurada para o driver Redis/BullMQ.');
  }

  const Redis = require('ioredis');
  const client = new Redis(env.receiptRedisUrl, buildRedisOptions());
  client.__receiptRole = role;
  await client.connect().catch((error) => {
    if (String(error.message || '').toLowerCase().includes('already connecting')
      || String(error.message || '').toLowerCase().includes('already connected')) {
      return undefined;
    }
    throw error;
  });
  return client;
};

module.exports = {
  async getClient(role = 'default') {
    if (!clients.has(role)) {
      clients.set(role, createRedisClient(role));
    }

    return clients.get(role);
  },

  async closeAll() {
    const entries = Array.from(clients.entries());
    clients.clear();
    await Promise.all(entries.map(async ([, clientPromise]) => {
      const client = await clientPromise.catch(() => null);
      if (client) {
        await client.quit().catch(() => client.disconnect());
      }
    }));
  },
};
