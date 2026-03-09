const assert = require('assert');
const nfExtractorService = require('../../services/nfExtractor.service');

module.exports = () => ([
  {
    name: 'nfExtractor extrai NF por contexto direto',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'doc1',
            sourceType: 'nf_roi',
            confidence: 88,
            targetRole: 'nf_block_context',
            meta: {
              requestedRoiId: 'nf_block',
              roiId: 'nf_block',
              sourceVariantId: 'upright__document_gray',
            },
            textRaw: 'NF-e\nN° 16171762\nSÉRIE 1',
          },
        ],
      });

      assert.strictEqual(result.nf, '16171762');
      assert.strictEqual(result.context.foundNfe, true);
      assert.ok(result.confidence >= 0.78);
    },
  },
  {
    name: 'nfExtractor agrega suportes repetidos para a mesma NF em regioes da nota',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'roi1',
            sourceType: 'nf_roi',
            confidence: 75,
            targetRole: 'nf_block_context',
            meta: {
              requestedRoiId: 'nf_block',
              roiId: 'nf_block',
              sourceVariantId: 'upright__document_gray',
            },
            textRaw: 'NF-e N° 16171762',
          },
          {
            id: 'roi2',
            sourceType: 'nf_roi',
            confidence: 81,
            targetRole: 'nf_digits_line',
            meta: {
              requestedRoiId: 'nf_number_line',
              roiId: 'nf_number_line',
              sourceVariantId: 'upright__document_gray',
            },
            textRaw: '16171762',
          },
        ],
      });

      assert.strictEqual(result.nf, '16171762');
      assert.ok(result.confidence >= 0.82);
      assert.ok(result.supportCount >= 2);
      assert.ok(result.roiSupportCount >= 2);
      assert.strictEqual(result.origin, 'roi');
      assert.ok(result.decisionReason.length >= 1);
    },
  },
  {
    name: 'nfExtractor recupera NF com sequencia fuzzy em ROI adaptativa',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'adaptive-roi',
            sourceType: 'nf_roi',
            confidence: 44,
            targetRole: 'nf_block_context_adaptive',
            meta: {
              requestedRoiId: 'nf_block',
              roiId: 'nf_block',
              sourceVariantId: 'rotate_left__document_gray',
            },
            textRaw: 'NF-e\nNº 1TIOS3A\nSÉRIE 1',
          },
        ],
      });

      assert.strictEqual(result.nf, '1710531');
      assert.ok(result.confidence >= 0.65);
    },
  },
  {
    name: 'nfExtractor recupera zero omitido quando OCR le N no meio da NF',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'adaptive-roi-n-zero',
            sourceType: 'nf_roi',
            confidence: 48,
            targetRole: 'nf_digits_line',
            meta: {
              requestedRoiId: 'nf_number_line',
              roiId: 'nf_number_line',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: 'DO NF-e No 1TINS31 SERIE I',
          },
        ],
      });

      assert.strictEqual(result.nf, '1710531');
      assert.ok(result.confidence >= 0.6);
    },
  },
  {
    name: 'nfExtractor prioriza a linha precisa da NF sobre contexto largo sem label',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'nf-line',
            sourceType: 'nf_roi',
            confidence: 0,
            targetRole: 'nf_digits_line',
            meta: {
              requestedRoiId: 'nf_number_line',
              roiId: 'nf_number_line',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: 'NF-e No 1710554 SERIE 1',
          },
          {
            id: 'wide-block',
            sourceType: 'nf_roi',
            confidence: 0,
            targetRole: 'nf_block_context',
            meta: {
              requestedRoiId: 'nf_block_wide',
              roiId: 'nf_block_wide',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: '140651 1',
          },
          {
            id: 'wide-block-2',
            sourceType: 'nf_roi',
            confidence: 0,
            targetRole: 'nf_block_context',
            meta: {
              requestedRoiId: 'nf_block',
              roiId: 'nf_block',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: '140651 1',
          },
        ],
      });

      assert.strictEqual(result.nf, '1710554');
    },
  },
  {
    name: 'nfExtractor prioriza ROI tight quando a leitura larga da NF empata em confianca',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'broad-nf-block',
            sourceType: 'nf_roi',
            confidence: 65,
            targetRole: 'nf_block_context',
            meta: {
              requestedRoiId: 'nf_block',
              roiId: 'nf_block',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: 'DO NF-e No 1710821 SERIE I',
          },
          {
            id: 'broad-nf-wide',
            sourceType: 'nf_roi',
            confidence: 40,
            targetRole: 'nf_block_wide_context',
            meta: {
              requestedRoiId: 'nf_block_wide',
              roiId: 'nf_block_wide',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: 'No 1710821',
          },
          {
            id: 'precise-tight',
            sourceType: 'nf_roi',
            confidence: 83,
            targetRole: 'nf_digits_isolated_confirm',
            meta: {
              requestedRoiId: 'nf_number_tight',
              roiId: 'nf_number_tight',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: 'NF-e Nº 1710521 SERIE I',
          },
        ],
      });

      assert.strictEqual(result.nf, '1710521');
    },
  },
  {
    name: 'nfExtractor sobe confianca para consenso forte em ROIs precisas mesmo sem cabecalho',
    run: async () => {
      const result = await nfExtractorService.extractInvoiceNumber({
        documents: [
          {
            id: 'tight-1',
            sourceType: 'nf_roi',
            confidence: 78,
            targetRole: 'nf_digits_isolated_confirm',
            meta: {
              requestedRoiId: 'nf_number_tight',
              roiId: 'nf_number_tight',
              sourceVariantId: 'upright__document_gray',
            },
            textRaw: '1710496',
          },
          {
            id: 'line-1',
            sourceType: 'nf_roi',
            confidence: 82,
            targetRole: 'nf_digits_line_confirm',
            meta: {
              requestedRoiId: 'nf_number_line',
              roiId: 'nf_number_line',
              sourceVariantId: 'upright__document_binary',
            },
            textRaw: '1710496',
          },
          {
            id: 'line-2',
            sourceType: 'nf_roi',
            confidence: 79,
            targetRole: 'nf_digits_line',
            meta: {
              requestedRoiId: 'nf_number_line',
              roiId: 'nf_number_line',
              sourceVariantId: 'rotate_right__document_gray',
            },
            textRaw: '1710496',
          },
        ],
      });

      assert.strictEqual(result.nf, '1710496');
      assert.ok(result.confidence >= 0.96);
      assert.strictEqual(result.roiSupportCount >= 2, true);
    },
  },
]);
