const path = require('path');
const env = require('../config/env');
const receiptProfile = require('../config/receiptProfile');
const logger = require('../utils/logger');
const receiptAnalysisService = require('./receiptAnalysis.service');
const debugVisualizationService = require('./debugVisualization.service');
const {
  copyFile,
  ensureDir,
  listImageFiles,
  pathExists,
  readJsonFile,
  toSafeFileStem,
  writeJsonFile,
} = require('../utils/file');

const OUTPUT_ASSET_PREFIX = '/debug-assets';
const TEST_IMAGE_PREFIX = '/debug-test-images';

const encodePathForUrl = (rawPath) => rawPath
  .split(path.sep)
  .map((segment) => encodeURIComponent(segment))
  .join('/');

const toOutputAssetUrl = (absolutePath) => {
  const relativePath = path.relative(env.outputsDir, absolutePath);
  return `${OUTPUT_ASSET_PREFIX}/${encodePathForUrl(relativePath)}`;
};

const toTestImageUrl = (absolutePath) => {
  const relativePath = path.relative(env.testImagesDir, absolutePath);
  return `${TEST_IMAGE_PREFIX}/${encodePathForUrl(relativePath)}`;
};

const ensureInsideRoot = (rootDir, candidatePath) => {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

const buildSessionId = (label = 'session') => `${Date.now()}-${toSafeFileStem(label)}-${Math.random().toString(36).slice(2, 8)}`;
const companyName = receiptProfile.company.displayName;

const buildFriendlyLogs = (analysis) => {
  const logs = [];
  const requiredFields = analysis.detection.requiredFields || {};
  const missingFields = Object.keys(requiredFields)
    .filter((fieldKey) => !requiredFields[fieldKey].found)
    .map((fieldKey) => requiredFields[fieldKey].label || fieldKey);

  logs.push({
    level: 'info',
    message: `${analysis.preprocess.totalVariants} variantes preprocessadas foram geradas.`,
  });
  logs.push({
    level: 'info',
    message: `Melhor orientacao: ${analysis.ocrProbe.bestOrientationId || 'indefinida'} (${analysis.ocrProbe.bestVariantId || 'sem variante'}).`,
  });
  logs.push({
    level: analysis.template && analysis.template.templateMatched ? 'success' : 'warning',
    message: analysis.template && analysis.template.templateMatched
      ? `Template ${receiptProfile.template.label} confirmado na imagem alinhada.`
      : `Template ${receiptProfile.template.label} ainda esta ambiguo ou parcialmente cortado.`,
  });
  logs.push({
    level: analysis.nfExtraction.nf ? 'success' : 'warning',
    message: analysis.nfExtraction.nf
      ? `NF candidata extraida: ${analysis.nfExtraction.nf} (confianca ${analysis.nfExtraction.confidence}, origem ${analysis.nfExtraction.origin || 'indefinida'}${analysis.nfExtraction.usedFallback ? ', fallback' : ''}).`
      : 'Nenhuma NF confiavel foi extraida.',
  });
  logs.push({
    level: analysis.invoiceLookup && analysis.invoiceLookup.found ? 'success' : 'info',
    message: analysis.invoiceLookup && analysis.invoiceLookup.found
      ? `NF confirmada no banco (${analysis.invoiceLookup.mode || 'lookup'}).`
      : `NF nao confirmada no banco de ${companyName}.`,
  });
  logs.push({
    level: analysis.template && analysis.template.signatureCheck && analysis.template.signatureCheck.present ? 'success' : 'info',
    message: analysis.template && analysis.template.signatureCheck
      ? analysis.template.signatureCheck.present
        ? `Assinatura com indicio visual presente (score ${analysis.template.signatureCheck.score}).`
        : `Assinatura ausente ou fraca na area central (score ${analysis.template.signatureCheck.score}).`
      : 'Assinatura nao avaliada nesta imagem.',
  });
  logs.push({
    level: missingFields.length ? 'warning' : 'success',
    message: missingFields.length
      ? `Campos ausentes ou fracos: ${missingFields.join(', ')}.`
      : 'Todos os campos obrigatorios foram identificados.',
  });
  logs.push({
    level: analysis.validation && analysis.validation.status === 'invalid' ? 'warning' : 'info',
    message: `Validacao estrutural: ${analysis.validation ? analysis.validation.status : 'indefinida'}.`,
  });
  logs.push({
    level: analysis.classification.classification === 'valid' ? 'success' : 'info',
    message: `Classificacao final: ${analysis.classification.classification} (score ${analysis.classification.metrics.businessScore}).`,
  });

  return logs;
};

const decorateVisualStep = (step) => Object.assign({}, step, {
  url: toOutputAssetUrl(step.filePath),
});

const decorateRegionHighlight = (highlight) => Object.assign({}, highlight, {
  url: toOutputAssetUrl(highlight.filePath),
  boxes: (highlight.boxes || []).map((box) => Object.assign({}, box, {
    url: box.filePath ? toOutputAssetUrl(box.filePath) : null,
  })),
});

module.exports = {
  async listAvailableTestImages() {
    const imageFiles = await listImageFiles(env.testImagesDir);

    return imageFiles.map((absolutePath) => ({
      id: path.relative(env.testImagesDir, absolutePath),
      name: path.basename(absolutePath),
      relativePath: path.relative(env.testImagesDir, absolutePath),
      absolutePath,
      url: toTestImageUrl(absolutePath),
    }));
  },

  async readSession(sessionId) {
    const manifestPath = path.join(env.debugSessionsDir, sessionId, 'session.json');
    const exists = await pathExists(manifestPath);
    if (!exists) return null;
    return readJsonFile(manifestPath);
  },

  async createSession({ sourceImagePath, displayName, sourceKind = 'upload', onProgress = null }) {
    const emitProgress = (payload) => {
      if (typeof onProgress !== 'function') return;
      onProgress(Object.assign({
        at: new Date().toISOString(),
      }, payload));
    };

    const sourceExists = await pathExists(sourceImagePath);
    if (!sourceExists) {
      throw new Error('Imagem de origem nao encontrada para depuracao.');
    }

    await ensureDir(env.debugSessionsDir);

    const sessionId = buildSessionId(displayName || path.basename(sourceImagePath));
    const sessionDir = path.join(env.debugSessionsDir, sessionId);
    const inputDir = path.join(sessionDir, 'input');
    const analysisDir = path.join(sessionDir, 'analysis');
    const analysisJsonPath = path.join(sessionDir, 'analysis.json');
    const sessionJsonPath = path.join(sessionDir, 'session.json');
    const copiedSourcePath = path.join(
      inputDir,
      `${toSafeFileStem(displayName || path.basename(sourceImagePath))}${path.extname(sourceImagePath) || '.png'}`,
    );

    await Promise.all([
      ensureDir(sessionDir),
      ensureDir(inputDir),
      ensureDir(analysisDir),
    ]);

    emitProgress({
      step: 'setup',
      status: 'running',
      message: 'Preparando sessao local de debug.',
    });
    await copyFile(sourceImagePath, copiedSourcePath);
    emitProgress({
      step: 'setup',
      status: 'completed',
      message: 'Imagem copiada para a sessao local.',
    });

    const analysis = await receiptAnalysisService.analyzeImage({
      imagePath: copiedSourcePath,
      outputDir: analysisDir,
      onProgress,
      profile: 'debug',
    });
    await writeJsonFile(analysisJsonPath, analysis);

    emitProgress({
      step: 'debug_assets',
      status: 'running',
      message: 'Gerando artefatos visuais da depuracao.',
    });
    const debugArtifacts = await debugVisualizationService.buildArtifacts({
      sessionDir,
      sourceImagePath: copiedSourcePath,
      preprocess: analysis.preprocess,
      structuredOcr: analysis.structuredOcr,
      nfExtraction: analysis.nfExtraction,
    });
    emitProgress({
      step: 'debug_assets',
      status: 'completed',
      message: 'Artefatos visuais prontos.',
    });

    const manifest = {
      sessionId,
      createdAt: new Date().toISOString(),
      source: {
        kind: sourceKind,
        displayName: displayName || path.basename(sourceImagePath),
        filePath: copiedSourcePath,
        url: toOutputAssetUrl(copiedSourcePath),
      },
      analysisRef: {
        filePath: analysisJsonPath,
        url: toOutputAssetUrl(analysisJsonPath),
      },
      receiptProfile: analysis.receiptProfile || {
        id: receiptProfile.id,
        company: receiptProfile.company,
      },
      timings: analysis.timings,
      summary: {
        classification: analysis.classification.classification,
        businessScore: analysis.classification.metrics.businessScore,
        nf: analysis.nfExtraction.nf,
        nfConfidence: analysis.nfExtraction.confidence,
        nfOrigin: analysis.nfExtraction.origin,
        nfUsedFallback: analysis.nfExtraction.usedFallback,
        bestOrientationId: analysis.ocrProbe.bestOrientationId,
        templateMatched: analysis.template ? analysis.template.templateMatched : false,
        requiredFieldCount: analysis.detection.summary.detectedCount,
        missingFields: analysis.detection.summary.missingFields,
      },
      result: analysis.result,
      template: analysis.template,
      validation: analysis.validation,
      classification: analysis.classification,
      diagnostics: analysis.diagnostics,
      invoiceLookup: analysis.invoiceLookup,
      requiredFields: analysis.detection.requiredFields,
      requiredFieldsSummary: analysis.detection.summary,
      nfExtraction: analysis.nfExtraction,
      texts: {
        fullOcrRaw: analysis.fullOcr.bestTextRaw,
        fullOcrNormalized: analysis.fullOcr.bestTextNormalized,
        bestVariantId: analysis.ocrProbe.bestVariantId,
        bestOrientationId: analysis.ocrProbe.bestOrientationId,
        fullOcrBestTargetId: analysis.fullOcr.bestTargetId,
        regionPreviews: analysis.structuredOcr && analysis.structuredOcr.regionOcr && Array.isArray(analysis.structuredOcr.regionOcr.results)
          ? analysis.structuredOcr.regionOcr.results.map((result) => ({
            targetId: result.targetId,
            label: result.label,
            confidence: result.confidence,
            score: result.score,
            textPreview: result.textPreview,
          }))
          : [],
        nfRoiPreviews: analysis.nfExtraction && analysis.nfExtraction.roiOcr && Array.isArray(analysis.nfExtraction.roiOcr.results)
          ? analysis.nfExtraction.roiOcr.results.map((result) => ({
            targetId: result.targetId,
            label: result.label,
            confidence: result.confidence,
            score: result.score,
            textPreview: result.textPreview,
            meta: result.meta,
          }))
          : [],
      },
      visualSteps: (debugArtifacts.visualSteps || []).map(decorateVisualStep),
      regionHighlights: (debugArtifacts.regionHighlights || []).map(decorateRegionHighlight),
      logs: buildFriendlyLogs(analysis),
    };

    await writeJsonFile(sessionJsonPath, manifest);

    logger.info('Sessao de debug visual criada.', {
      sessionId,
      sourceKind,
      displayName,
      classification: manifest.summary.classification,
    });

    return manifest;
  },

  resolveTestImagePath(relativePath) {
    const absolutePath = path.resolve(env.testImagesDir, relativePath);
    if (!ensureInsideRoot(env.testImagesDir, absolutePath)) {
      throw new Error('Caminho da imagem de teste invalido.');
    }
    return absolutePath;
  },
};
