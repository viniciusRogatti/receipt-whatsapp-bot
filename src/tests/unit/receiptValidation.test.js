const assert = require('assert');
const receiptValidationService = require('../../services/receiptPipeline/receiptValidation.service');

module.exports = () => ([
  {
    name: 'receiptValidation marca imagem como usable quando DATA e NF-e aparecem',
    run: () => {
      const result = receiptValidationService.validateReceiptStructure({
        requiredFields: {
          dataRecebimento: { found: true, confidence: 0.82 },
          recebemosDeMarERio: { found: false, confidence: 0.34 },
          nfe: { found: true, confidence: 0.91 },
        },
        template: {
          templateMatched: true,
          geometryScore: 0.84,
        },
        fullOcr: {
          bestConfidence: 58,
        },
      });

      assert.strictEqual(result.status, 'usable');
      assert.strictEqual(result.canRunNfFallback, true);
    },
  },
  {
    name: 'receiptValidation marca imagem como invalid quando nao ha estrutura minima',
    run: () => {
      const result = receiptValidationService.validateReceiptStructure({
        requiredFields: {
          dataRecebimento: { found: false, confidence: 0.12 },
          recebemosDeMarERio: { found: false, confidence: 0.11 },
          nfe: { found: false, confidence: 0.1 },
        },
        template: {
          templateMatched: false,
          geometryScore: 0.12,
        },
        fullOcr: {
          bestConfidence: 14,
        },
      });

      assert.strictEqual(result.status, 'invalid');
      assert.strictEqual(result.canRunNfFallback, false);
    },
  },
]);
