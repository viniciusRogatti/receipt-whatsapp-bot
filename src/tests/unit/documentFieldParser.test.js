const assert = require('assert');
const { resolveProcessingContext } = require('../../config/profiles');
const parserService = require('../../services/processing/documentFieldParser.service');

module.exports = () => {
  return [
    {
      name: 'documentFieldParser extracts invoice date and issuer header from structured OCR',
      run: () => {
        const context = resolveProcessingContext({
          companyId: 'mar-e-rio',
          sourceId: 'whatsapp',
          documentType: 'delivery_receipt',
        });

        const parsed = parserService.parseStructuredDocument({
          providerId: 'google_vision_document_text',
          documentProfile: context.documentProfile,
          ocrDocument: {
            fullText: [
              'RECEBEMOS DE MAR E RIO PESCADOS IND IMP EXP',
              'DATA DE RECEBIMENTO 10/03/2026',
              'NF-e 1710500',
            ].join('\n'),
            lines: [
              {
                text: 'RECEBEMOS DE MAR E RIO PESCADOS IND IMP EXP',
                confidence: 0.95,
              },
              {
                text: 'DATA DE RECEBIMENTO 10/03/2026',
                confidence: 0.92,
              },
              {
                text: 'NF-e 1710500',
                confidence: 0.91,
              },
            ],
            providerConfidence: 0.93,
          },
        });

        assert.strictEqual(parsed.fields.invoiceNumber.value, '1710500');
        assert.strictEqual(parsed.fields.receiptDate.value, '10/03/2026');
        assert.strictEqual(parsed.fields.issuerHeader.found, true);
        assert.ok(parsed.summary.averageConfidence >= 0.8);
      },
    },
  ];
};
