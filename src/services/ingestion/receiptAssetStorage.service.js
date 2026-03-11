const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const {
  ensureDir,
  moveFile,
  removeFile,
  writeJsonFile,
} = require('../../utils/file');

const buildAssetId = (companyId, sourceId) => {
  const compactTimestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const entropy = Math.random().toString(36).slice(2, 10);
  return `${companyId}-${sourceId}-${compactTimestamp}-${entropy}`;
};

const guessExtension = (sourcePath, originalName, mimeType) => {
  const mimeToExtension = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
  };

  const candidates = [
    path.extname(String(originalName || '')),
    path.extname(String(sourcePath || '')),
    mimeToExtension[String(mimeType || '').toLowerCase()] || '',
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  return candidates[0] || '.jpg';
};

const readRemoteAsset = async (imageUrl) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.receiptProviderGoogleVisionTimeoutMs);

  try {
    const response = await fetch(imageUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Falha ao baixar imagem remota (${response.status}).`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: response.headers.get('content-type') || null,
    };
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {
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
    const now = new Date();
    const targetDir = path.join(
      env.receiptStorageDir,
      companyId,
      documentType,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    );
    await ensureDir(targetDir);

    let finalPath = null;
    let extension = '.jpg';
    let sourceDescriptor = {
      type: 'unknown',
      originalName: null,
      remoteUrl: imageUrl || null,
    };

    try {
      if (upload && upload.path) {
        extension = guessExtension(upload.path, upload.originalName, upload.mimeType);
        finalPath = path.join(targetDir, `${assetId}${extension}`);
        await moveFile(upload.path, finalPath);
        sourceDescriptor = {
          type: 'upload',
          originalName: upload.originalName || null,
          remoteUrl: null,
          mimeType: upload.mimeType || null,
        };
      } else if (imageUrl) {
        const remoteAsset = await readRemoteAsset(imageUrl);
        extension = guessExtension(imageUrl, null, remoteAsset.mimeType);
        finalPath = path.join(targetDir, `${assetId}${extension}`);
        await fs.promises.writeFile(finalPath, remoteAsset.buffer);
        sourceDescriptor = {
          type: 'image_url',
          originalName: null,
          remoteUrl: imageUrl,
          mimeType: remoteAsset.mimeType,
        };
      }

      const asset = {
        assetId,
        companyId,
        sourceId,
        documentType,
        storedAt: new Date().toISOString(),
        filePath: finalPath,
        fileName: path.basename(finalPath),
        extension,
        source: sourceDescriptor,
      };

      await writeJsonFile(`${finalPath}.meta.json`, {
        asset,
        metadata,
      });

      logger.info('Imagem ingerida e armazenada.', {
        assetId,
        companyId,
        sourceId,
        documentType,
        filePath: finalPath,
      });

      return asset;
    } catch (error) {
      if (upload && upload.path) {
        await removeFile(upload.path).catch(() => undefined);
      }

      throw error;
    }
  },
};
