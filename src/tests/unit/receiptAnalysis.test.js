const assert = require('assert');
const apiService = require('../../services/api.service');
const receiptAnalysisService = require('../../services/receiptAnalysis.service');

const {
  resolveCandidateByInvoiceLookup,
  mergeOrientationProbeFallbackFields,
} = receiptAnalysisService.__testables;

const buildCandidate = ({
  nf,
  confidence,
  supportingVariants,
  supportCount = 1,
  roiSupportCount = 1,
  variantSupportCount = 1,
}) => ({
  nf,
  confidence,
  method: 'window_context',
  supportCount,
  roiSupportCount,
  variantSupportCount,
  precisionScore: 0,
  sourceTypes: ['nf_roi'],
  context: {
    foundNfe: false,
    foundNumeroMarker: false,
  },
  decisionReason: ['linha_curta', 'comprimento_esperado'],
  supportingTexts: [nf],
  supportingRois: ['nf_block'],
  supportingVariants,
  usedFallback: false,
  origin: 'roi',
  evidence: [
    {
      evidence: nf,
      regionId: 'nf_block',
      requestedRoiId: 'nf_block',
      sourceType: 'nf_roi',
    },
  ],
});

module.exports = () => ([
  {
    name: 'receiptAnalysis recupera NF por transposicao adjacente confirmada no banco',
    run: async () => {
      const originalFindInvoiceByNumber = apiService.findInvoiceByNumber;
      apiService.findInvoiceByNumber = async (invoiceNumber) => ({
        found: invoiceNumber === '1710500',
        invoice: invoiceNumber === '1710500'
          ? { invoiceNumber }
          : null,
        mode: 'mock',
        reason: invoiceNumber === '1710500' ? 'invoice_found' : 'invoice_not_found',
      });

      try {
        const result = await resolveCandidateByInvoiceLookup({
          nfExtraction: {
            nf: '1719508',
            confidence: 0.5,
            candidates: [
              buildCandidate({
                nf: '1719508',
                confidence: 0.5,
                supportingVariants: ['rotate_left__ink_clean_rescue'],
                supportCount: 2,
              }),
              buildCandidate({
                nf: '1719408',
                confidence: 0.45,
                supportingVariants: ['rotate_left__ink_clean_rescue'],
                supportCount: 2,
              }),
              buildCandidate({
                nf: '7110500',
                confidence: 0.37,
                supportingVariants: ['rotate_left__document_gray'],
              }),
            ],
          },
          currentLookup: {
            found: false,
            invoice: null,
            mode: 'mock',
            reason: 'invoice_not_found',
          },
        });

        assert.strictEqual(result.reranked, true);
        assert.strictEqual(result.nfExtraction.nf, '1710500');
        assert.strictEqual(result.nfExtraction.method, 'db_fuzzy_rescue');
        assert.strictEqual(result.invoiceLookup.found, true);
      } finally {
        apiService.findInvoiceByNumber = originalFindInvoiceByNumber;
      }
    },
  },
  {
    name: 'receiptAnalysis aproveita campo do orientation probe quando a estrutura final falha',
    run: async () => {
      const merged = mergeOrientationProbeFallbackFields({
        requiredFields: {
          dataRecebimento: { found: false, confidence: 0.12 },
          issuerHeader: { found: false, confidence: 0.18 },
          nfe: { found: false, confidence: 0.2 },
        },
        orientationProbe: {
          bestOrientationId: 'rotate_left',
          results: [
            {
              orientationId: 'rotate_left',
              requiredFields: {
                dataRecebimento: {
                  found: false,
                  confidence: 0.41,
                  method: 'token_fuzzy',
                  reasons: ['regiao_esperada'],
                },
                issuerHeader: {
                  found: false,
                  confidence: 0.44,
                  method: 'token_fuzzy',
                  reasons: ['regiao_esperada'],
                },
                nfe: {
                  found: true,
                  confidence: 0.69,
                  method: 'token_fuzzy',
                  reasons: ['regiao_esperada', 'recorte_especifico'],
                },
              },
            },
          ],
        },
      });

      assert.strictEqual(merged.requiredFields.nfe.found, true);
      assert.strictEqual(merged.requiredFields.nfe.sourceType, 'orientation_probe_fallback');
      assert.strictEqual(merged.mergedCount, 1);
    },
  },
]);
