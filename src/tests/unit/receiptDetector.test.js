const assert = require('assert');
const receiptDetectorService = require('../../services/receiptDetector.service');

module.exports = () => ([
  {
    name: 'receiptDetector identifica campos obrigatorios com texto limpo',
    run: async () => {
      const result = await receiptDetectorService.detectRequiredFields({
        documents: [
          {
            id: 'doc1',
            textRaw: 'DATA DE RECEBIMENTO\nRECEBEMOS DE MAR E RIO\nNF-e\nN° 16171762\nSÉRIE 1',
          },
        ],
      });

      assert.strictEqual(result.requiredFields.dataRecebimento.found, true);
      assert.strictEqual(result.requiredFields.recebemosDeMarERio.found, true);
      assert.strictEqual(result.requiredFields.nfe.found, true);
    },
  },
  {
    name: 'receiptDetector tolera pequenas distorcoes de OCR',
    run: async () => {
      const result = await receiptDetectorService.detectRequiredFields({
        documents: [
          {
            id: 'doc2',
            textRaw: 'DATA DE RECEBIMEN10\nRECEBEM0S DE MAR E RI0\nNFe',
          },
        ],
      });

      assert.strictEqual(result.requiredFields.dataRecebimento.found, true);
      assert.strictEqual(result.requiredFields.recebemosDeMarERio.found, true);
      assert.strictEqual(result.requiredFields.nfe.found, true);
    },
  },
]);
