const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { ensureDir, removeFile } = require('../../utils/file');
const {
  buildAssetDescriptor,
  buildAssetId,
  buildAssetObjectKey,
  guessExtension,
  materializeBufferToTempFile,
  readRemoteAsset,
} = require('./receiptAssetSupport.service');

const streamToBuffer = async (stream) => {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const getS3Client = () => {
  const { S3Client } = require('@aws-sdk/client-s3');

  return new S3Client({
    region: env.receiptS3Region,
    endpoint: env.receiptS3Endpoint || undefined,
    forcePathStyle: !!env.receiptS3ForcePathStyle,
  });
};

const buildPublicUrl = (storageKey) => {
  if (!env.receiptS3PublicBaseUrl) return null;
  return `${env.receiptS3PublicBaseUrl.replace(/\/+$/, '')}/${storageKey}`;
};

module.exports = {
  driverId: 's3',

  async persistReceiptAsset({
    companyId,
    sourceId,
    documentType,
    upload = null,
    imageUrl = null,
    metadata = {},
  }) {
    if (!env.receiptS3Bucket) {
      throw new Error('RECEIPT_S3_BUCKET nao configurado para o driver S3.');
    }

    if (!upload && !imageUrl) {
      throw new Error('Nenhuma imagem foi enviada para ingestao.');
    }

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3Client = getS3Client();
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

    try {
      let buffer = null;
      let contentType = upload ? upload.mimeType || null : null;

      if (upload && upload.path) {
        buffer = await fs.promises.readFile(upload.path);
      } else if (imageUrl) {
        const remoteAsset = await readRemoteAsset(imageUrl, env.receiptProviderGoogleVisionTimeoutMs);
        buffer = remoteAsset.buffer;
        contentType = remoteAsset.mimeType;
      }

      await s3Client.send(new PutObjectCommand({
        Bucket: env.receiptS3Bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: contentType || undefined,
        Metadata: Object.keys(metadata || {}).reduce((accumulator, key) => {
          accumulator[key] = String(metadata[key]);
          return accumulator;
        }, {}),
      }));

      if (upload && upload.path) {
        await removeFile(upload.path).catch(() => undefined);
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
        sizeBytes: buffer.length,
        bucket: env.receiptS3Bucket,
        publicUrl: buildPublicUrl(storageKey),
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

  async materializeAssetForProcessing(asset, { jobId } = {}) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3Client = getS3Client();
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: asset.bucket || env.receiptS3Bucket,
      Key: asset.storageKey,
    }));
    const buffer = await streamToBuffer(response.Body);
    const targetDir = path.join(env.receiptProcessingTmpDir, String(jobId || 'job').trim());

    return materializeBufferToTempFile({
      buffer,
      targetDir,
      fileName: `${asset.assetId}${asset.extension || '.jpg'}`,
    });
  },

  async deleteAsset(asset) {
    if (!asset || !asset.storageKey) return;
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3Client = getS3Client();
    await s3Client.send(new DeleteObjectCommand({
      Bucket: asset.bucket || env.receiptS3Bucket,
      Key: asset.storageKey,
    }));
  },

  async getAssetUrl(asset, options = {}) {
    if (asset && asset.publicUrl) return asset.publicUrl;

    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const s3Client = getS3Client();
    const command = new GetObjectCommand({
      Bucket: asset.bucket || env.receiptS3Bucket,
      Key: asset.storageKey,
    });

    return getSignedUrl(s3Client, command, {
      expiresIn: Number(options.expiresIn || env.receiptS3SignedUrlExpiresSeconds || 900),
    });
  },

  async cleanup() {
    await ensureDir(env.receiptProcessingTmpDir);
    return {
      deletedCount: 0,
      note: 'Use lifecycle policy no bucket para retenção definitiva de objetos.',
    };
  },
};
