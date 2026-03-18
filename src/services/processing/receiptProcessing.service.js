const extractionOrchestrator = require('../extraction/documentExtractionOrchestrator.service');
const assetStorageService = require('../ingestion/receiptAssetStorage.service');
const apiService = require('../api.service');
const profileResolver = require('./profileResolver.service');

module.exports = {
  async processCanonicalRequest({ canonicalRequest, asset, jobContext = {} }) {
    const context = profileResolver.resolveReceiptProcessingContext(canonicalRequest);
    const materializedAsset = await assetStorageService.materializeAssetForProcessing(asset, {
      jobId: jobContext.jobId,
      correlationId: jobContext.correlationId,
    });

    try {
      const extraction = await extractionOrchestrator.extract({
        imagePath: materializedAsset.filePath,
        context,
      });

      const result = {
        request: canonicalRequest,
        asset,
        context: {
          companyProfile: context.companyProfile,
          sourceProfile: context.sourceProfile,
          documentProfile: {
            id: context.documentProfile.id,
            label: context.documentProfile.label,
            documentType: context.documentProfile.documentType,
            extractionStrategy: context.documentProfile.extractionStrategy,
            validation: context.documentProfile.validation,
          },
        },
        extraction: {
          providerId: extraction.selectedAttempt.providerId,
          parsedDocument: extraction.selectedAttempt.parsedDocument || null,
          attempts: extraction.attempts.map((attempt) => ({
            providerId: attempt.providerId,
            status: attempt.status,
            reason: attempt.reason || null,
          })),
        },
        decision: extraction.decision,
        completedAt: new Date().toISOString(),
      };

      if (context.sourceProfile && context.sourceProfile.id === 'whatsapp') {
        result.backendSync = await apiService.syncProcessingResult(result, {
          imagePath: materializedAsset.filePath,
        });
      }

      return result;
    } finally {
      if (materializedAsset && typeof materializedAsset.cleanup === 'function') {
        await materializedAsset.cleanup().catch(() => undefined);
      }
    }
  },
};
