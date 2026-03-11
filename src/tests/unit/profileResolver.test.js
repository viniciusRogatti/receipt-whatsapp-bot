const assert = require('assert');
const env = require('../../config/env');
const profileResolver = require('../../services/processing/profileResolver.service');

module.exports = () => {
  return [
    {
      name: 'profileResolver resolves company from ingest token and defaults',
      run: () => {
        const originalTokens = env.receiptCompanyIngestTokens;
        env.receiptCompanyIngestTokens = {
          'mar-e-rio': ['token-mar-e-rio'],
        };

        try {
          const request = profileResolver.buildCanonicalReceiptRequest({
            payload: {
              metadata: JSON.stringify({
                groupId: 'grupo-1',
              }),
            },
            headers: {
              'x-ingest-token': 'token-mar-e-rio',
            },
            sourceHint: 'whatsapp',
          });
          const context = profileResolver.resolveReceiptProcessingContext(request);

          assert.strictEqual(request.companyId, 'mar-e-rio');
          assert.strictEqual(request.source, 'whatsapp');
          assert.strictEqual(request.documentType, 'delivery_receipt');
          assert.strictEqual(request.metadata.groupId, 'grupo-1');
          assert.strictEqual(context.companyProfile.displayName, 'MAR E RIO');
          assert.strictEqual(context.sourceProfile.id, 'whatsapp');
          assert.strictEqual(context.documentProfile.id, 'delivery_receipt');
          assert.strictEqual(
            context.documentProfile.fieldDefinitions.issuerHeader.label,
            'RECEBEMOS DE MAR E RIO',
          );
        } finally {
          env.receiptCompanyIngestTokens = originalTokens;
        }
      },
    },
  ];
};
