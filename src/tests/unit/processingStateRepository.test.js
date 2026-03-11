const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../../config/env');
const repository = require('../../services/state/fileProcessingStateRepository.service');

module.exports = () => {
  return [
    {
      name: 'processingStateRepository cria atualiza e consulta estado do job',
      run: async () => {
        const originalStateDir = env.receiptStateDir;
        const tempStateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'receipt-state-test-'));
        env.receiptStateDir = tempStateDir;

        try {
          await repository.createJob({
            jobId: 'job-state-1',
            status: 'queued',
            companyId: 'mar-e-rio',
            source: 'api',
            documentType: 'delivery_receipt',
          });

          await repository.markProcessing('job-state-1', {
            attemptCount: 1,
            workerId: 'worker-test',
          });

          await repository.markRetryScheduled('job-state-1', {
            attemptCount: 1,
            nextRetryAt: '2026-03-11T01:00:00.000Z',
            error: {
              message: 'falha transitoria',
            },
          });

          await repository.markCompleted('job-state-1', {
            providerId: 'google_vision_document_text',
            resultSummary: {
              classification: 'valid',
            },
          });

          const stored = await repository.getJob('job-state-1');

          assert.strictEqual(stored.status, 'completed');
          assert.strictEqual(stored.providerId, 'google_vision_document_text');
          assert.strictEqual(stored.resultSummary.classification, 'valid');
          assert.ok(Array.isArray(stored.events));
          assert.ok(stored.events.length >= 4);
        } finally {
          env.receiptStateDir = originalStateDir;
          await fs.promises.rm(tempStateDir, { recursive: true, force: true });
        }
      },
    },
  ];
};
