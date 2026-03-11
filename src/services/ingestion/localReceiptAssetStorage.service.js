const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const {
  ensureDir,
  moveFile,
  pathExists,
  removeFile,
  writeJsonFile,
} = require('../../utils/file');
const {
  buildAssetDescriptor,
  buildAssetId,
  buildAssetObjectKey,
  guessExtension,
  readRemoteAsset,
} = require('./receiptAssetSupport.service');

const getAbsoluteAssetPath = (storageKey) => path.join(env.receiptStorageDir, storageKey);

module.exports = {
  driverId: 'local',

  async persistReceiptAsset({
    companyId,
    sourceId,
    documentType,
    upload = null,
    imageUrl = null,
    metadata = {},
  }) {
    if (!upload && !imageUrl) {
      throw new Error('Nenhuma imagem foi enviada para ingestao.');
    }

    const assetId = buildAssetId(companyId, sourceId);
    const storedAt = new Date();
    const extension = guessExtension(
      upload && upload.path ? upload.path : imageUrl,
      upload ? upload.originalName : null,
      upload ? upload.mimeType : null,
    );
    const storageKey = buildAssetObjectKey({
      companyId,
      documentType,
      sourceId,
      assetId,
      extension,
      storedAt,
    });
    const absolutePath = getAbsoluteAssetPath(storageKey);
    await ensureDir(path.dirname(absolutePath));

    try {
      let sizeBytes = null;
      let contentType = upload ? upload.mimeType || null : null;

      if (upload && upload.path) {
        await moveFile(upload.path, absolutePath);
        const stats = await fs.promises.stat(absolutePath);
        sizeBytes = Number(stats.size || 0) || null;
      } else if (imageUrl) {
        const remoteAsset = await readRemoteAsset(imageUrl, env.receiptProviderGoogleVisionTimeoutMs);
        await fs.promises.writeFile(absolutePath, remoteAsset.buffer);
        sizeBytes = remoteAsset.sizeBytes || remoteAsset.buffer.length;
        contentType = remoteAsset.mimeType;
      }

      const asset = buildAssetDescriptor({
        assetId,
        companyId,
        sourceId,
        documentType,
        storageDriver: this.driverId,
        storageKey,
        extension,
        storedAt: storedAt.toISOString(),
        source: {
          type: upload ? 'upload' : 'image_url',
          originalName: upload ? upload.originalName || null : null,
          remoteUrl: imageUrl || null,
        },
        contentType,
        sizeBytes,
        filePath: absolutePath,
      });

      await writeJsonFile(`${absolutePath}.meta.json`, {
        asset,
        metadata,
      });

      logger.info('Imagem ingerida e armazenada.', {
        assetId,
        storageDriver: this.driverId,
        storageKey,
        companyId,
        documentType,
      });

      return asset;
    } catch (error) {
      if (upload && upload.path) {
        await removeFile(upload.path).catch(() => undefined);
      }

      throw error;
    }
  },

  async materializeAssetForProcessing(asset) {
    if (!(await pathExists(asset.filePath))) {
      throw new Error(`Asset local ausente para processamento: ${asset.storageKey}.`);
    }

    return {
      filePath: asset.filePath,
      cleanup: async () => undefined,
    };
  },

  async deleteAsset(asset) {
    if (!asset || !asset.storageKey) return;
    const absolutePath = getAbsoluteAssetPath(asset.storageKey);
    await removeFile(absolutePath).catch(() => undefined);
    await removeFile(`${absolutePath}.meta.json`).catch(() => undefined);
  },

  async getAssetUrl(asset) {
    return asset && asset.filePath ? asset.filePath : null;
  },

  async cleanup() {
    const rootDir = env.receiptStorageDir;
    if (!(await pathExists(rootDir))) return { deletedCount: 0 };

    const ttlMs = Math.max(1, Number(env.receiptAssetRetentionHours || 168)) * 60 * 60 * 1000;
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

        if (entry.name.endsWith('.meta.json')) continue;

        const stats = await fs.promises.stat(absolutePath).catch(() => null);
        if (!stats || (now - stats.mtimeMs) < ttlMs) continue;

        await removeFile(absolutePath).catch(() => undefined);
        await removeFile(`${absolutePath}.meta.json`).catch(() => undefined);
        deletedCount += 1;
      }
    };

    await walk(rootDir);

    return {
      deletedCount,
    };
  },
};
