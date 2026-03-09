if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'warn';
}

const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger');
const { assertSupportedNode } = require('../utils/runtime');
const ocrService = require('../services/ocr.service');
const apiService = require('../services/api.service');
const receiptAnalysisService = require('../services/receiptAnalysis.service');
const {
  ensureDir,
  listImageFiles,
  toSafeFileStem,
  writeJsonFile,
} = require('../utils/file');

const buildImageResult = (imagePath, payload = {}) => ({
  fileName: path.basename(imagePath),
  filePath: imagePath,
  processedAt: new Date().toISOString(),
  status: 'stage_10_completed',
  ...payload,
});
const formatSeconds = (milliseconds) => `${(Number(milliseconds || 0) / 1000).toFixed(1)}s`;

async function main() {
  assertSupportedNode('npm run test:local');

  const resultsDir = path.join(env.outputsDir, 'results');
  const reportsDir = path.join(env.outputsDir, 'reports');
  const processedDir = path.join(env.outputsDir, 'processed');

  await Promise.all([
    ensureDir(env.testImagesDir),
    ensureDir(resultsDir),
    ensureDir(reportsDir),
    ensureDir(processedDir),
  ]);

  const discoveredImageFiles = await listImageFiles(env.testImagesDir);
  const imageFiles = env.receiptLocalMaxImages > 0
    ? discoveredImageFiles.slice(0, env.receiptLocalMaxImages)
    : discoveredImageFiles;
  logger.info('Iniciando runner local das ETAPAS 3 a 10.', {
    testImagesDir: env.testImagesDir,
    outputsDir: env.outputsDir,
    totalImages: imageFiles.length,
  });

  const processed = [];

  for (const imagePath of imageFiles) {
    const relativePath = path.relative(env.testImagesDir, imagePath);
    const outputKey = toSafeFileStem(relativePath);
    const perImageOutputDir = path.join(processedDir, outputKey);
    const outputFileName = `${toSafeFileStem(relativePath)}.json`;
    const outputPath = path.join(resultsDir, outputFileName);

    try {
      const analysis = await receiptAnalysisService.analyzeImage({
        imagePath,
        outputDir: perImageOutputDir,
        profile: env.receiptLocalFastMode ? 'local_fast' : 'batch',
      });
      const apiPreview = await apiService.syncAnalysisResult(analysis);
      const bestVariant = analysis.preprocess.variants.find(
        (variant) => variant.id === analysis.ocrProbe.bestVariantId,
      ) || null;

      const result = buildImageResult(imagePath, {
        classification: analysis.classification,
        validation: analysis.validation,
        preprocess: {
          outputDir: analysis.preprocess.outputDir,
          variantsDir: analysis.preprocess.variantsDir,
          orientation: analysis.preprocess.orientation,
          totalVariants: analysis.preprocess.totalVariants,
          ocrProbeCandidateCount: analysis.preprocess.ocrProbeCandidates.length,
          variants: analysis.preprocess.variants,
        },
        ocrProbe: Object.assign({}, analysis.ocrProbe, {
          bestVariantLabel: bestVariant ? bestVariant.label : null,
        }),
        fullOcr: analysis.fullOcr,
        requiredFields: analysis.detection.requiredFields,
        requiredFieldsSummary: analysis.detection.summary,
        template: analysis.template,
        diagnostics: analysis.diagnostics,
        result: analysis.result,
        nfExtraction: analysis.nfExtraction,
        invoiceLookup: analysis.invoiceLookup,
        timings: analysis.timings,
        apiPreview,
      });

      await writeJsonFile(outputPath, result);
      processed.push({
        fileName: result.fileName,
        outputPath,
        status: result.status,
        classification: analysis.classification.classification,
        businessScore: analysis.classification.metrics.businessScore,
        nf: analysis.nfExtraction.nf,
        nfConfidence: analysis.nfExtraction.confidence,
        nfOrigin: analysis.nfExtraction.origin,
        nfUsedFallback: analysis.nfExtraction.usedFallback,
        templateMatched: analysis.template ? analysis.template.templateMatched : false,
        invoiceConfirmedInDb: !!(analysis.invoiceLookup && analysis.invoiceLookup.found),
        invoiceLookupMode: analysis.invoiceLookup ? analysis.invoiceLookup.mode : null,
        signatureLikelyPresent: analysis.diagnostics && analysis.diagnostics.summary
          ? analysis.diagnostics.summary.signatureLikelyPresent
          : null,
        failedCheckpoints: analysis.diagnostics && analysis.diagnostics.summary
          ? analysis.diagnostics.summary.failedLabels
          : [],
        blockingFailures: analysis.diagnostics && analysis.diagnostics.summary
          ? analysis.diagnostics.summary.blockingFailedKeys
          : [],
        approvalBasis: analysis.diagnostics ? analysis.diagnostics.approvalBasis : null,
        totalVariants: analysis.preprocess.totalVariants,
        bestOrientationId: analysis.ocrProbe.bestOrientationId,
        bestVariantId: analysis.ocrProbe.bestVariantId,
        bestConfidence: analysis.ocrProbe.bestConfidence,
        totalMs: analysis.timings.totalMs,
      });

      if (!env.receiptLocalReportOnly) {
        logger.info('Imagem processada com OCR, validacao e classificacao.', {
          fileName: result.fileName,
          outputPath,
          classification: analysis.classification.classification,
          nf: analysis.nfExtraction.nf,
          bestVariantId: analysis.ocrProbe.bestVariantId,
          totalMs: analysis.timings.totalMs,
        });
      }
    } catch (error) {
      const result = buildImageResult(imagePath, {
        status: 'stage_10_failed',
        error: {
          message: error.message,
        },
      });

      await writeJsonFile(outputPath, result);
      processed.push({
        fileName: result.fileName,
        outputPath,
        status: result.status,
      });

      logger.error('Falha ao preprocessar imagem.', {
        fileName: result.fileName,
        outputPath,
        error: error.message,
      });
    }
  }

  const completedWithTiming = processed.filter(
    (item) => item.status === 'stage_10_completed' && Number(item.totalMs || 0) > 0,
  );
  const totalTimingMs = completedWithTiming.reduce((sum, item) => sum + Number(item.totalMs || 0), 0);
  const averageTimingMs = completedWithTiming.length
    ? Math.round(totalTimingMs / completedWithTiming.length)
    : 0;
  const slowestItem = completedWithTiming
    .slice()
    .sort((left, right) => Number(right.totalMs || 0) - Number(left.totalMs || 0))[0] || null;

  const summary = {
    processedAt: new Date().toISOString(),
    botEnv: env.botEnv,
    totalImages: imageFiles.length,
    resultsDir,
    processedDir,
    successCount: processed.filter((item) => item.status === 'stage_10_completed').length,
    failureCount: processed.filter((item) => item.status !== 'stage_10_completed').length,
    validCount: processed.filter((item) => item.classification === 'valid').length,
    reviewCount: processed.filter((item) => item.classification === 'review').length,
    invalidCount: processed.filter((item) => item.classification === 'invalid').length,
    detectedNfCount: processed.filter((item) => !!item.nf).length,
    nfDetectionRate: processed.length
      ? Number((processed.filter((item) => !!item.nf).length / processed.length).toFixed(4))
      : 0,
    nfFromRoiCount: processed.filter((item) => item.nf && item.nfOrigin === 'roi').length,
    nfFromFallbackCount: processed.filter((item) => item.nf && item.nfUsedFallback).length,
    invoiceConfirmedCount: processed.filter((item) => item.invoiceConfirmedInDb).length,
    templateMatchedCount: processed.filter((item) => item.templateMatched).length,
    averageProcessingMs: averageTimingMs,
    slowestImage: slowestItem
      ? {
        fileName: slowestItem.fileName,
        totalMs: slowestItem.totalMs,
      }
      : null,
    items: processed,
  };

  const summaryPath = path.join(reportsDir, 'local-run-summary.json');
  await writeJsonFile(summaryPath, summary);

  logger.info('Runner local finalizado.', {
    totalImages: imageFiles.length,
    summaryPath,
  });
  const successfulReads = processed.filter((item) => item.classification === 'valid' && item.nf);
  const failedOrReview = processed.filter((item) => item.classification !== 'valid' || !item.nf);

  console.log('');
  console.log('Relatorio final dos canhotos');
  console.log(`Total processado: ${summary.totalImages}`);
  console.log(`Validas: ${summary.validCount} | Revisao: ${summary.reviewCount} | Invalidas: ${summary.invalidCount}`);
  console.log(`NFs lidas com sucesso: ${successfulReads.length}`);
  console.log(`Tempo medio por imagem: ${summary.averageProcessingMs ? formatSeconds(summary.averageProcessingMs) : '0.0s'}`);
  if (summary.slowestImage) {
    console.log(`Imagem mais lenta: ${summary.slowestImage.fileName} (${formatSeconds(summary.slowestImage.totalMs)})`);
  }

  console.log('');
  console.log('NFs lidas com sucesso');
  if (!successfulReads.length) {
    console.log('- nenhuma');
  } else {
    successfulReads.forEach((item) => {
      const approvalLabel = item.approvalBasis === 'nf_confirmada_no_banco'
        ? ' | origem confirmada no banco'
        : '';
      console.log(`- ${item.fileName}: NF ${item.nf} | tempo ${formatSeconds(item.totalMs)}${approvalLabel}`);
    });
  }

  console.log('');
  console.log('Falhas ou revisao');
  if (!failedOrReview.length) {
    console.log('- nenhuma');
  } else {
    failedOrReview.forEach((item) => {
      const failedParts = Array.isArray(item.failedCheckpoints) && item.failedCheckpoints.length
        ? item.failedCheckpoints.join(', ')
        : 'sem diagnostico objetivo';
      console.log(
        `- ${item.fileName}: ${item.classification || item.status} | falhou em: ${failedParts} | NF ${item.nf || 'nao detectada'} | tempo ${formatSeconds(item.totalMs)}`,
      );
    });
  }

  if (!imageFiles.length) {
    logger.warn('Nenhuma imagem encontrada em test-images/. Adicione arquivos e rode novamente.', {
      testImagesDir: env.testImagesDir,
    });
  }
}

main().catch((error) => {
  logger.error('Falha no runner local das ETAPAS 3 a 10.', {
    error: error.message,
  });
  process.exitCode = 1;
}).finally(async () => {
  await apiService.shutdown().catch(() => undefined);
  await ocrService.shutdown().catch(() => undefined);
});
