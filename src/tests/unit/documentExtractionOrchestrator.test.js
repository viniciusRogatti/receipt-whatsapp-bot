const assert = require('assert');
const env = require('../../config/env');
const orchestrator = require('../../services/extraction/documentExtractionOrchestrator.service');
const { resolveProcessingContext } = require('../../config/profiles');
const googleVisionProvider = require('../../services/extraction/providers/googleVisionExtraction.provider');
const openAiRescueProvider = require('../../services/extraction/providers/openAiReceiptRescue.provider');
const legacyProvider = require('../../services/extraction/providers/legacyReceiptExtraction.provider');

module.exports = () => {
  return [
    {
      name: 'documentExtractionOrchestrator ignora fallback legado quando desabilitado por env',
      run: async () => {
        const originalLegacyFallbackEnabled = env.receiptLegacyFallbackEnabled;
        const originalGoogleExtract = googleVisionProvider.extract;
        const originalOpenAiExtract = openAiRescueProvider.extract;
        const originalLegacyExtract = legacyProvider.extract;
        let legacyCalled = false;

        env.receiptLegacyFallbackEnabled = false;
        googleVisionProvider.extract = async function extractPrimary() {
          return {
            providerId: this.id,
            status: 'success',
            extractedDocument: {
              providerId: this.id,
              fullText: 'NF-e 1710486',
              fields: {
                invoiceNumber: {
                  key: 'invoiceNumber',
                  label: 'NF-e',
                  found: true,
                  value: '1710486',
                  confidence: 0.67,
                  source: 'google_vision',
                },
                receiptDate: {
                  key: 'receiptDate',
                  label: 'Data de recebimento',
                  found: false,
                  value: null,
                  confidence: 0,
                  source: 'google_vision',
                },
                issuerHeader: {
                  key: 'issuerHeader',
                  label: 'RECEBEMOS DE MAR E RIO',
                  found: false,
                  value: null,
                  confidence: 0,
                  source: 'google_vision',
                },
              },
              summary: {
                foundFieldCount: 1,
                missingFieldKeys: ['receiptDate', 'issuerHeader'],
                averageConfidence: 0.67,
              },
            },
          };
        };
        openAiRescueProvider.extract = async function extractFallback() {
          return {
            providerId: this.id,
            status: 'unavailable',
            reason: 'openai_not_configured',
          };
        };
        legacyProvider.extract = async function extractLegacy() {
          legacyCalled = true;
          return {
            providerId: this.id,
            status: 'success',
            extractedDocument: {
              providerId: this.id,
              fullText: 'legado',
              fields: {},
              summary: {
                foundFieldCount: 0,
                missingFieldKeys: ['invoiceNumber', 'receiptDate', 'issuerHeader'],
                averageConfidence: 0,
              },
            },
          };
        };

        try {
          const context = resolveProcessingContext({
            companyId: 'mar-e-rio',
            sourceId: 'whatsapp',
            documentType: 'delivery_receipt',
          });
          const result = await orchestrator.extract({
            imagePath: '/tmp/fake-image.jpg',
            context,
          });

          assert.strictEqual(legacyCalled, false);
          assert.strictEqual(result.selectedAttempt.providerId, googleVisionProvider.id);
          assert.strictEqual(
            result.attempts.some((attempt) => attempt.providerId === legacyProvider.id),
            false,
          );
        } finally {
          env.receiptLegacyFallbackEnabled = originalLegacyFallbackEnabled;
          googleVisionProvider.extract = originalGoogleExtract;
          openAiRescueProvider.extract = originalOpenAiExtract;
          legacyProvider.extract = originalLegacyExtract;
        }
      },
    },
    {
      name: 'documentExtractionOrchestrator aprova foto boa quando so um campo textual nao fecha no OCR',
      run: async () => {
        const originalGoogleExtract = googleVisionProvider.extract;
        const originalOpenAiExtract = openAiRescueProvider.extract;
        const originalLegacyExtract = legacyProvider.extract;

        googleVisionProvider.extract = async function extractPrimary() {
          return {
            providerId: this.id,
            status: 'success',
            extractedDocument: {
              providerId: this.id,
              fullText: 'NF-e 1710486 DATA DE RECEBIMENTO 20/03/2026',
              fields: {
                invoiceNumber: {
                  key: 'invoiceNumber',
                  label: 'NF-e',
                  found: true,
                  value: '1710486',
                  confidence: 0.93,
                  source: 'google_vision',
                },
                receiptDate: {
                  key: 'receiptDate',
                  label: 'Data de recebimento',
                  found: true,
                  value: '20/03/2026',
                  confidence: 0.9,
                  source: 'google_vision',
                },
                issuerHeader: {
                  key: 'issuerHeader',
                  label: 'RECEBEMOS DE MAR E RIO',
                  found: false,
                  value: null,
                  confidence: 0,
                  source: 'google_vision',
                },
              },
              summary: {
                foundFieldCount: 2,
                missingFieldKeys: ['issuerHeader'],
                averageConfidence: 0.92,
              },
            },
          };
        };
        openAiRescueProvider.extract = async function extractFallback() {
          return {
            providerId: this.id,
            status: 'unavailable',
            reason: 'openai_not_configured',
          };
        };
        legacyProvider.extract = async function extractLegacy() {
          throw new Error('legacy nao deveria ser chamado');
        };

        try {
          const context = resolveProcessingContext({
            companyId: 'mar-e-rio',
            sourceId: 'whatsapp',
            documentType: 'delivery_receipt',
          });
          const result = await orchestrator.extract({
            imagePath: '/tmp/fake-image.jpg',
            context,
          });

          assert.strictEqual(result.selectedAttempt.providerId, googleVisionProvider.id);
          assert.strictEqual(result.decision.classification, 'valid');
          assert.strictEqual(result.decision.accepted, true);
          assert.ok(
            result.decision.reasons.includes(
              'Aprovado com um unico campo textual ausente porque os demais campos vieram fortes na imagem.',
            ),
          );
        } finally {
          googleVisionProvider.extract = originalGoogleExtract;
          openAiRescueProvider.extract = originalOpenAiExtract;
          legacyProvider.extract = originalLegacyExtract;
        }
      },
    },
  ];
};
