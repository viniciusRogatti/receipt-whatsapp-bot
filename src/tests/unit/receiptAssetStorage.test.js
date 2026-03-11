const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../../config/env');
const storage = require('../../services/ingestion/localReceiptAssetStorage.service');

module.exports = () => {
  return [
    {
      name: 'receiptAssetStorage local persiste materializa e remove asset',
      run: async () => {
        const originalStorageDir = env.receiptStorageDir;
        const originalProcessingTmpDir = env.receiptProcessingTmpDir;
        const tempStorageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'receipt-storage-test-'));
        const tempProcessingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'receipt-processing-test-'));
        const uploadFilePath = path.join(tempProcessingDir, 'upload.jpg');
        env.receiptStorageDir = tempStorageDir;
        env.receiptProcessingTmpDir = tempProcessingDir;

        try {
          await fs.promises.writeFile(uploadFilePath, Buffer.from('fake-image'));

          const asset = await storage.persistReceiptAsset({
            companyId: 'mar-e-rio',
            sourceId: 'api',
            documentType: 'delivery_receipt',
            upload: {
              path: uploadFilePath,
              originalName: 'upload.jpg',
              mimeType: 'image/jpeg',
            },
            metadata: {
              sender: 'tester',
            },
          });

          assert.strictEqual(asset.storageDriver, 'local');
          assert.ok(asset.filePath);

          const materialized = await storage.materializeAssetForProcessing(asset, {
            jobId: 'job-local-1',
          });

          assert.strictEqual(materialized.filePath, asset.filePath);
          assert.strictEqual(await fs.promises.readFile(materialized.filePath, 'utf8'), 'fake-image');

          await storage.deleteAsset(asset);

          await assert.rejects(
            fs.promises.access(asset.filePath),
            /ENOENT/,
          );
        } finally {
          env.receiptStorageDir = originalStorageDir;
          env.receiptProcessingTmpDir = originalProcessingTmpDir;
          await fs.promises.rm(tempStorageDir, { recursive: true, force: true });
          await fs.promises.rm(tempProcessingDir, { recursive: true, force: true });
        }
      },
    },
  ];
};
