const assert = require('assert');
const {
  buildAnalysisFromProcessingResult,
  buildMetadataFromCanonicalRequest,
} = require('../../services/backendSyncPayloadAdapter.service');

module.exports = () => {
  return [
    {
      name: 'backendSyncPayloadAdapter adapta resultado canonico para o formato legacy de sincronizacao',
      run: () => {
        const analysis = buildAnalysisFromProcessingResult({
          extraction: {
            providerId: 'google_vision_document_text',
            parsedDocument: {
              fields: {
                invoiceNumber: {
                  value: 'NF 1710486',
                  found: true,
                  confidence: 0.91,
                },
              },
              summary: {
                averageConfidence: 0.84,
              },
              fullText: 'NF-e 1710486',
            },
          },
          decision: {
            classification: 'valid',
            reasons: ['Tudo certo'],
            metrics: {
              averageConfidence: 0.84,
            },
          },
        });

        assert.strictEqual(analysis.nfExtraction.nf, '1710486');
        assert.strictEqual(analysis.nfExtraction.confidence, 0.91);
        assert.strictEqual(analysis.classification.classification, 'valid');
        assert.deepStrictEqual(analysis.classification.reasons, ['Tudo certo']);
      },
    },
    {
      name: 'backendSyncPayloadAdapter preserva metadata relevante do WhatsApp no request canonico',
      run: () => {
        const metadata = buildMetadataFromCanonicalRequest({
          companyId: 'mar-e-rio',
          source: 'whatsapp',
          documentType: 'delivery_receipt',
          metadata: {
            groupId: '5511@g.us',
            groupName: 'KP  - CANHOTOS',
            messageId: 'abc',
            senderPhone: '5511999999999',
            sourceName: 'whatsapp',
          },
        });

        assert.strictEqual(metadata.source, 'whatsapp');
        assert.strictEqual(metadata.companyId, 'mar-e-rio');
        assert.strictEqual(metadata.groupId, '5511@g.us');
        assert.strictEqual(metadata.groupName, 'KP  - CANHOTOS');
        assert.strictEqual(metadata.messageId, 'abc');
        assert.strictEqual(metadata.senderPhone, '5511999999999');
      },
    },
  ];
};
