const env = require('../config/env');

const LOG_LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevelWeight = LOG_LEVEL_WEIGHT[String(env.logLevel || 'info').toLowerCase()] || LOG_LEVEL_WEIGHT.info;

const writeLog = (level, message, meta = null) => {
  const weight = LOG_LEVEL_WEIGHT[level] || LOG_LEVEL_WEIGHT.info;
  if (weight < currentLevelWeight) return;

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (meta && typeof meta === 'object' && Object.keys(meta).length) {
    payload.meta = meta;
  }

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
};

module.exports = {
  debug: (message, meta) => writeLog('debug', message, meta),
  info: (message, meta) => writeLog('info', message, meta),
  warn: (message, meta) => writeLog('warn', message, meta),
  error: (message, meta) => writeLog('error', message, meta),
};
