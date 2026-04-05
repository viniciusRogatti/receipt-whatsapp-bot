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
    {
      name: 'fileJobQueue processa varias imagens enfileiradas sem perder jobs',
      run: async () => {
        const originalQueueDir = env.receiptQueueDir;
        const tempQueueDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'receipt-queue-test-'));
        env.receiptQueueDir = tempQueueDir;

        try {
          const first = await queueService.enqueue({
            companyId: 'mar-e-rio',
            source: 'whatsapp',
            documentType: 'delivery_receipt',
            payload: {
              correlationId: 'msg-1',
            },
          });
          const second = await queueService.enqueue({
            companyId: 'mar-e-rio',
            source: 'whatsapp',
            documentType: 'delivery_receipt',
            payload: {
              correlationId: 'msg-2',
            },
          });

          assert.notStrictEqual(first.id, second.id);

          const claimedFirst = await queueService.claimNextJob('unit-test-worker');
          const claimedSecond = await queueService.claimNextJob('unit-test-worker');

          assert.ok(claimedFirst);
          assert.ok(claimedSecond);
          assert.notStrictEqual(claimedFirst.id, claimedSecond.id);

          await queueService.completeJob(claimedFirst.id, { ok: true, correlationId: 'msg-1' });
          await queueService.completeJob(claimedSecond.id, { ok: true, correlationId: 'msg-2' });

          const storedFirst = await queueService.getJob(claimedFirst.id);
          const storedSecond = await queueService.getJob(claimedSecond.id);

          assert.strictEqual(storedFirst.status, 'completed');
          assert.strictEqual(storedSecond.status, 'completed');
        } finally {
          env.receiptQueueDir = originalQueueDir;
          await fs.promises.rm(tempQueueDir, { recursive: true, force: true });
        }
      },
    },
  ];
};
