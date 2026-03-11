const env = require('../../config/env');
const DRIVERS = {
  local: () => require('./localReceiptAssetStorage.service'),
  s3: () => require('./s3ReceiptAssetStorage.service'),
};

let cachedStorage = null;

const getStorage = () => {
  if (cachedStorage) return cachedStorage;

  const driverFactory = DRIVERS[String(env.receiptAssetStorageDriver || 'local').trim()];
  if (!driverFactory) {
    throw new Error(`Driver de asset storage nao suportado: ${env.receiptAssetStorageDriver}.`);
  }

  cachedStorage = driverFactory();
  return cachedStorage;
};

module.exports = new Proxy({}, {
  get(_target, property) {
    const storage = getStorage();
    const value = storage[property];

    if (typeof value === 'function') {
      return value.bind(storage);
    }

    return value;
  },
});
