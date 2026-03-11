const queueService = require('../queue/fileJobQueue.service');
const storageService = require('./receiptAssetStorage.service');
const profileResolver = require('../processing/profileResolver.service');

module.exports = {
  async ingestReceipt({
    payload = {},
    headers = {},
    uploadedFile = null,
    sourceHint = null,
  }) {
    const canonicalRequest = profileResolver.buildCanonicalReceiptRequest({
      payload,
      headers,
      sourceHint,
      uploadedFile,
    });
    const context = profileResolver.resolveReceiptProcessingContext(canonicalRequest);
    const asset = await storageService.persistReceiptAsset({
      companyId: canonicalRequest.companyId,
      sourceId: canonicalRequest.source,
      documentType: canonicalRequest.documentType,
      upload: canonicalRequest.upload,
      imageUrl: canonicalRequest.imageUrl,
      metadata: canonicalRequest.metadata,
    });
    const job = await queueService.enqueue({
      companyId: canonicalRequest.companyId,
      source: canonicalRequest.source,
      documentType: canonicalRequest.documentType,
      canonicalRequest,
      asset,
    });

    return {
      queued: true,
      jobId: job.id,
      status: job.status,
      companyId: canonicalRequest.companyId,
      source: canonicalRequest.source,
      documentType: canonicalRequest.documentType,
      assetId: asset.assetId,
      profileSummary: {
        company: context.companyProfile.displayName,
        source: context.sourceProfile.label,
        document: context.documentProfile.label,
      },
    };
  },
};
