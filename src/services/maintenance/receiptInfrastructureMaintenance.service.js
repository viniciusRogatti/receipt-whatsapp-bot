const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { pathExists } = require('../../utils/file');
const jobQueueService = require('../queue/jobQueue.service');
const assetStorageService = require('../ingestion/receiptAssetStorage.service');
const processingStateRepository = require('../state/processingStateRepository.service');

let lastRunAt = 0;

const cleanupDirectoryByAge = async (targetDir, maxAgeHours, label) => {
  const exists = await pathExists(targetDir);
  if (!exists) return { deletedCount: 0 };

  const ttlMs = Math.max(1, Number(maxAgeHours || 24)) * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;

  const walk = async (currentDir) => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        const remainingEntries = await fs.promises.readdir(absolutePath).catch(() => []);
        if (!remainingEntries.length) {
          await fs.promises.rmdir(absolutePath).catch(() => undefined);
        }
        continue;
      }

      const stats = await fs.promises.stat(absolutePath).catch(() => null);
      if (!stats || (now - stats.mtimeMs) < ttlMs) continue;

      await fs.promises.unlink(absolutePath).catch(() => undefined);
      deletedCount += 1;
    }
  };

  await walk(targetDir);

  if (deletedCount) {
    logger.info('Arquivos temporarios antigos removidos.', {
      label,
      deletedCount,
    });
  }

  return { deletedCount };
};

module.exports = {
  async runOnce(reason = 'manual') {
    const queueCleanup = typeof jobQueueService.cleanup === 'function'
      ? await jobQueueService.cleanup().catch(() => ({ deletedCount: 0 }))
      : { deletedCount: 0 };
    const assetCleanup = typeof assetStorageService.cleanup === 'function'
      ? await assetStorageService.cleanup().catch(() => ({ deletedCount: 0 }))
      : { deletedCount: 0 };
    const stateCleanup = typeof processingStateRepository.cleanup === 'function'
      ? await processingStateRepository.cleanup().catch(() => ({ deletedCount: 0 }))
      : { deletedCount: 0 };
    const ingressCleanup = await cleanupDirectoryByAge(
      env.receiptIngressTmpDir,
      env.receiptTempTtlHours,
      'receipt_ingress_tmp',
    );
    const processingCleanup = await cleanupDirectoryByAge(
      env.receiptProcessingTmpDir,
      env.receiptTempTtlHours,
      'receipt_processing_tmp',
    );

    lastRunAt = Date.now();
    logger.info('Rotina de manutencao da infraestrutura concluida.', {
      reason,
      queueDeleted: queueCleanup.deletedCount || 0,
      assetDeleted: assetCleanup.deletedCount || 0,
      stateDeleted: stateCleanup.deletedCount || 0,
      ingressDeleted: ingressCleanup.deletedCount || 0,
      processingDeleted: processingCleanup.deletedCount || 0,
    });

    return {
      queueCleanup,
      assetCleanup,
      stateCleanup,
      ingressCleanup,
      processingCleanup,
    };
  },

  async runIfDue(reason = 'scheduled') {
    const intervalMs = Math.max(10_000, Number(env.receiptMaintenanceIntervalMs || 60_000));
    if ((Date.now() - lastRunAt) < intervalMs) return null;
    return this.runOnce(reason);
  },
};
