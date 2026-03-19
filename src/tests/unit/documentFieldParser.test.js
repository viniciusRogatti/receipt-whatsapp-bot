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
    {
      name: 'documentFieldParser prioritizes the fixed NF-e area over unrelated numbers elsewhere on the receipt',
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
              'NF-e',
              '1719844',
              '33621540',
            ].join('\n'),
            pageWidth: 1000,
            pageHeight: 500,
            lines: [
              {
                text: 'RECEBEMOS DE MAR E RIO PESCADOS IND IMP EXP',
                confidence: 0.95,
                boundingPoly: {
                  vertices: [
                    { x: 120, y: 30 },
                    { x: 760, y: 30 },
                    { x: 760, y: 90 },
                    { x: 120, y: 90 },
                  ],
                },
              },
              {
                text: 'NF-e',
                confidence: 0.84,
                boundingPoly: {
                  vertices: [
                    { x: 860, y: 50 },
                    { x: 940, y: 50 },
                    { x: 940, y: 95 },
                    { x: 860, y: 95 },
                  ],
                },
              },
              {
                text: '1719844',
                confidence: 0.77,
                boundingPoly: {
                  vertices: [
                    { x: 875, y: 110 },
                    { x: 965, y: 110 },
                    { x: 965, y: 175 },
                    { x: 875, y: 175 },
                  ],
                },
              },
              {
                text: '33621540',
                confidence: 0.99,
                boundingPoly: {
                  vertices: [
                    { x: 230, y: 250 },
                    { x: 420, y: 250 },
                    { x: 420, y: 300 },
                    { x: 230, y: 300 },
                  ],
                },
              },
            ],
            providerConfidence: 0.9,
          },
        });

        assert.strictEqual(parsed.fields.invoiceNumber.value, '1719844');
        assert.strictEqual(parsed.fields.invoiceNumber.found, true);
      },
    },
  ];
};
