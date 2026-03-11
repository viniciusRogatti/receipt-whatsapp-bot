const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../../config/env');
const queueService = require('../../services/queue/fileJobQueue.service');

module.exports = () => {
  return [
    {
      name: 'fileJobQueue enqueues claims and completes a receipt job',
      run: async () => {
        const originalQueueDir = env.receiptQueueDir;
        const tempQueueDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'receipt-queue-test-'));
        env.receiptQueueDir = tempQueueDir;

        try {
          const enqueued = await queueService.enqueue({
            companyId: 'mar-e-rio',
            source: 'api',
            documentType: 'delivery_receipt',
          });
          assert.strictEqual(enqueued.status, 'queued');

          const claimed = await queueService.claimNextJob('unit-test-worker');
          assert.ok(claimed);
          assert.strictEqual(claimed.status, 'processing');
          assert.strictEqual(claimed.workerId, 'unit-test-worker');

          const completed = await queueService.completeJob(claimed.id, {
            ok: true,
          });
          assert.strictEqual(completed.status, 'completed');
          assert.strictEqual(completed.result.ok, true);

          const stored = await queueService.getJob(claimed.id);
          assert.strictEqual(stored.status, 'completed');
        } finally {
          env.receiptQueueDir = originalQueueDir;
          await fs.promises.rm(tempQueueDir, { recursive: true, force: true });
        }
      },
    },
  ];
};
