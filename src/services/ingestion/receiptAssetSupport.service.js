const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../../utils/file');
const { buildAssetObjectKey } = require('../infrastructure/receiptInfrastructureSupport.service');

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

const readRemoteAsset = async (imageUrl, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      sizeBytes: Number(response.headers.get('content-length') || 0) || null,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const buildAssetDescriptor = ({
  assetId,
  companyId,
  sourceId,
  documentType,
  storageDriver,
  storageKey,
  extension,
  source,
  contentType = null,
  sizeBytes = null,
  filePath = null,
  bucket = null,
  publicUrl = null,
  storedAt = new Date().toISOString(),
}) => ({
  assetId,
  companyId,
  sourceId,
  documentType,
  storageDriver,
  storageKey,
  extension,
  storedAt,
  source,
  contentType,
  sizeBytes,
  filePath,
  bucket,
  publicUrl,
});

const materializeBufferToTempFile = async ({
  buffer,
  targetDir,
  fileName,
}) => {
  await ensureDir(targetDir);
  const filePath = path.join(targetDir, fileName);
  await fs.promises.writeFile(filePath, buffer);
  return {
    filePath,
    cleanup: async () => {
      await fs.promises.unlink(filePath).catch(() => undefined);
    },
  };
};

module.exports = {
  buildAssetDescriptor,
  buildAssetId,
  buildAssetObjectKey,
  guessExtension,
  materializeBufferToTempFile,
  readRemoteAsset,
};
