const env = require('../../config/env');
const storageService = require('./receiptAssetStorage.service');
const jobQueueService = require('../queue/jobQueue.service');
const processingStateRepository = require('../state/processingStateRepository.service');
const {
  buildCorrelationId,
  buildReceiptJobId,
  normalizeErrorPayload,
} = require('../infrastructure/receiptInfrastructureSupport.service');
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
    const correlationId = buildCorrelationId(canonicalRequest.trace, canonicalRequest.trace && canonicalRequest.trace.requestId);
    const asset = await storageService.persistReceiptAsset({
      companyId: canonicalRequest.companyId,
      sourceId: canonicalRequest.source,
      documentType: canonicalRequest.documentType,
      upload: canonicalRequest.upload,
      imageUrl: canonicalRequest.imageUrl,
      metadata: canonicalRequest.metadata,
    });
    const jobId = buildReceiptJobId();

    try {
      await processingStateRepository.createJob({
        jobId,
        correlationId,
        companyId: canonicalRequest.companyId,
        source: canonicalRequest.source,
        documentType: canonicalRequest.documentType,
        status: 'queued',
        attemptCount: 0,
        maxAttempts: env.receiptQueueMaxAttempts,
        asset,
        queue: {
          driverId: jobQueueService.driverId,
        },
        storageDriver: storageService.driverId,
        stateDriver: processingStateRepository.driverId,
        trace: canonicalRequest.trace || null,
        resultSummary: null,
        error: null,
      });

      let job;
      job = await jobQueueService.enqueue({
        jobId,
        payload: {
          jobId,
          correlationId,
          companyId: canonicalRequest.companyId,
          source: canonicalRequest.source,
          documentType: canonicalRequest.documentType,
          canonicalRequest,
          asset,
        },
      });

      await processingStateRepository.markQueued(jobId, {
        attemptCount: 0,
        queue: {
          driverId: jobQueueService.driverId,
          queueJobId: job.id,
          status: job.status,
        },
      });

      return {
        queued: true,
        jobId,
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
        correlationId,
      };
    } catch (error) {
      await processingStateRepository.markFailed(jobId, {
        error: normalizeErrorPayload(error),
        queue: {
          driverId: jobQueueService.driverId,
        },
      }).catch(() => undefined);
      await storageService.deleteAsset(asset).catch(() => undefined);
      throw error;
    }
  },
};
