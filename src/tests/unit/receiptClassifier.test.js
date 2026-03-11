const assert = require('assert');
const receiptClassifierService = require('../../services/receiptClassifier.service');
const {
  RECEIPT_FIELD_KEYS,
} = require('../../config/receiptProfiles');

module.exports = () => ([
  {
    name: 'receiptClassifier marca como valid quando os tres campos e a NF estao fortes',
    run: () => {
      const result = receiptClassifierService.classifyReceiptAnalysis({
        validation: { status: 'usable', templateMatched: true, metrics: { geometryScore: 0.84 } },
        requiredFields: {
          [RECEIPT_FIELD_KEYS.dataRecebimento]: { found: true, confidence: 0.84 },
          [RECEIPT_FIELD_KEYS.issuerHeader]: { found: true, confidence: 0.81 },
          [RECEIPT_FIELD_KEYS.nfe]: { found: true, confidence: 0.98 },
        },
        nfExtraction: {
          nf: '16171762',
          confidence: 0.91,
        },
        fullOcr: {
          bestConfidence: 78,
        },
      });

      assert.strictEqual(result.classification, 'valid');
      assert.strictEqual(result.shouldReplyToWhatsapp, false);
      assert.ok(result.scoreBreakdown.total >= 70);
    },
  },
  {
    name: 'receiptClassifier aplica fallback quando RECEBEMOS nao fecha mas DATA, NF-e e NF estao fortes',
    run: () => {
      const result = receiptClassifierService.classifyReceiptAnalysis({
        validation: { status: 'usable', templateMatched: true, metrics: { geometryScore: 0.8 } },
        requiredFields: {
          [RECEIPT_FIELD_KEYS.dataRecebimento]: { found: true, confidence: 0.89 },
          [RECEIPT_FIELD_KEYS.issuerHeader]: { found: false, confidence: 0.41 },
          [RECEIPT_FIELD_KEYS.nfe]: { found: true, confidence: 0.94 },
        },
        nfExtraction: {
          nf: '16171762',
          confidence: 0.9,
          supportCount: 2,
          sourceTypes: ['field_region'],
        },
        fullOcr: {
          bestConfidence: 73,
        },
      });

      assert.strictEqual(result.classification, 'valid');
      assert.strictEqual(result.fallbackApplied, true);
    },
  },
  {
    name: 'receiptClassifier valida pelo banco quando o cabecalho esta coberto mas a NF existe na empresa ativa',
    run: () => {
      const result = receiptClassifierService.classifyReceiptAnalysis({
        validation: {
          status: 'usable',
          templateMatched: false,
          metrics: { geometryScore: 0.78 },
        },
        requiredFields: {
          [RECEIPT_FIELD_KEYS.dataRecebimento]: { found: true, confidence: 0.9 },
          [RECEIPT_FIELD_KEYS.issuerHeader]: { found: false, confidence: 0.2 },
          [RECEIPT_FIELD_KEYS.nfe]: { found: true, confidence: 0.95 },
        },
        nfExtraction: {
          nf: '1710496',
          confidence: 0.97,
          supportCount: 3,
          sourceTypes: ['field_region', 'nf_roi'],
        },
        invoiceLookup: {
          found: true,
          mode: 'backend_db',
          invoice: {
            invoiceNumber: '1710496',
            companyId: 1,
          },
        },
        fullOcr: {
          bestConfidence: 69,
        },
      });

      assert.strictEqual(result.classification, 'valid');
      assert.strictEqual(result.metrics.databaseFallbackApplied, true);
      assert.ok(result.reasons.some((reason) => reason.includes('existe na base de')));
    },
  },
  {
    name: 'receiptClassifier marca como invalid quando nao ha base minima',
    run: () => {
      const result = receiptClassifierService.classifyReceiptAnalysis({
        validation: { status: 'invalid', templateMatched: false, metrics: { geometryScore: 0.12 } },
        requiredFields: {
          [RECEIPT_FIELD_KEYS.dataRecebimento]: { found: false, confidence: 0.22 },
          [RECEIPT_FIELD_KEYS.issuerHeader]: { found: false, confidence: 0.18 },
          [RECEIPT_FIELD_KEYS.nfe]: { found: false, confidence: 0.11 },
        },
        nfExtraction: {
          nf: null,
          confidence: 0,
        },
        fullOcr: {
          bestConfidence: 12,
        },
      });

      assert.strictEqual(result.classification, 'invalid');
      assert.strictEqual(result.shouldReplyToWhatsapp, true);
    },
  },
  {
    name: 'receiptClassifier invalida imediatamente quando a geometria fica abaixo do minimo',
    run: () => {
      const result = receiptClassifierService.classifyReceiptAnalysis({
        validation: {
          status: 'invalid',
          templateMatched: false,
          metrics: {
            geometryScore: 0.31,
            geometryHardReject: true,
          },
        },
        requiredFields: {
          [RECEIPT_FIELD_KEYS.dataRecebimento]: { found: true, confidence: 0.74 },
          [RECEIPT_FIELD_KEYS.issuerHeader]: { found: false, confidence: 0.22 },
          [RECEIPT_FIELD_KEYS.nfe]: { found: true, confidence: 0.79 },
        },
        nfExtraction: {
          nf: '1710496',
          confidence: 0.92,
        },
        fullOcr: {
          bestConfidence: 63,
        },
      });

      assert.strictEqual(result.classification, 'invalid');
      assert.ok(result.reasons.some((reason) => reason.includes('Fundo muito claro')));
    },
  },
]);
