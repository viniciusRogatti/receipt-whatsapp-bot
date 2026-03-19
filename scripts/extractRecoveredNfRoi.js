const path = require('path');
const env = require('../src/config/env');
const apiService = require('../src/services/api.service');
const imagePreprocessService = require('../src/services/imagePreprocess.service');
const nfExtractorService = require('../src/services/nfExtractor.service');
const ocrService = require('../src/services/ocr.service');
const receiptOrientationService = require('../src/services/receiptPipeline/receiptOrientation.service');
const {
  ensureDir,
  pathExists,
  readJsonFile,
  toSafeFileStem,
  writeJsonFile,
} = require('../src/utils/file');

const DEFAULT_LIMIT = 0;

const parseArgs = (argv = []) => argv.reduce((accumulator, token) => {
  const match = String(token || '').match(/^--([^=]+)=(.*)$/);
  if (!match) return accumulator;
  accumulator[match[1]] = match[2];
  return accumulator;
}, {});

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const summarize = (results = [], totalCandidates = 0) => {
  const processed = results.filter((item) => item.status === 'processed');
  const errored = results.filter((item) => item.status === 'error');
  const withInvoice = processed.filter((item) => !!item.invoiceNumber);
  const lookupFound = processed.filter((item) => item.lookupFound === true);
  const lookupMissing = processed.filter((item) => item.lookupFound === false);
  const fallbackUsed = processed.filter((item) => item.usedFallback);

  return {
    targetDate,
    totalCandidates,
    processedCount: processed.length,
    errorCount: errored.length,
    detectedInvoiceCount: withInvoice.length,
    lookupFoundCount: lookupFound.length,
    lookupMissingCount: lookupMissing.length,
    fallbackUsedCount: fallbackUsed.length,
    detectionRate: processed.length
      ? Number((withInvoice.length / processed.length).toFixed(4))
      : 0,
    completionRate: totalCandidates
      ? Number((processed.length / totalCandidates).toFixed(4))
      : 0,
  };
};

const args = parseArgs(process.argv.slice(2));
const targetDate = String(args.date || new Date().toISOString().slice(0, 10)).trim();
const limit = Math.max(0, Number(args.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT);
const resume = parseBoolean(args.resume, true);
const writeEvery = Math.max(1, Number(args.writeEvery || 1) || 1);

const buildResultKey = (entry = {}) => String(entry.messageId || entry.filePath || '').trim();

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('Use --date=YYYY-MM-DD.');
  }

  const recoveryRoot = path.join(env.outputsDir, 'recovery', targetDate);
  const reportsDir = path.join(recoveryRoot, 'reports');
  const processedDir = path.join(recoveryRoot, 'nf-roi-processed');
  const manifestPath = path.join(reportsDir, 'manifest.json');
  const reportPath = path.join(reportsDir, 'nf-roi-report.json');
  const summaryPath = path.join(reportsDir, 'nf-roi-summary.json');

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Manifesto nao encontrado: ${manifestPath}`);
  }

  await Promise.all([
    ensureDir(reportsDir),
    ensureDir(processedDir),
  ]);

  const manifest = await readJsonFile(manifestPath);
  const candidates = manifest
    .filter((entry) => entry && entry.filePath && entry.status !== 'ignored_non_image_or_download_failed')
    .slice(0, limit > 0 ? limit : undefined);

  const existingResults = resume && await pathExists(reportPath)
    ? await readJsonFile(reportPath)
    : [];
  const resultsByKey = new Map(
    Array.isArray(existingResults)
      ? existingResults
        .map((entry) => [buildResultKey(entry), entry])
        .filter(([key]) => key)
      : [],
  );
  let processedSinceLastWrite = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    const resultKey = buildResultKey(entry);

    if (!resultKey) continue;
    if (resume && resultsByKey.has(resultKey)) continue;

    const startedAt = Date.now();
    let result = null;

    try {
      if (!(await pathExists(entry.filePath))) {
        throw new Error('Arquivo de imagem nao encontrado para OCR da NF.');
      }

      const imageOutputDir = path.join(processedDir, toSafeFileStem(path.basename(entry.filePath)));
      const preprocess = await imagePreprocessService.preprocessImage({
        imagePath: entry.filePath,
        outputDir: imageOutputDir,
        profile: 'local_fast',
      });
      const orientationProbe = await receiptOrientationService.selectBestOrientation({
        preprocess,
        fastMode: true,
      });
      const nfExtraction = await nfExtractorService.extractInvoiceNumber({
        preprocess,
        orientationProbe,
        documents: [],
        fullOcr: null,
        regionOcr: null,
        fastMode: true,
      });
      const invoiceNumber = nfExtraction.nf || null;
      const lookup = invoiceNumber
        ? await apiService.findInvoiceByNumber(invoiceNumber)
        : null;

      result = {
        messageId: entry.messageId || null,
        timestamp: entry.timestamp || null,
        occurredAt: entry.occurredAt || null,
        sender: entry.sender || null,
        fileName: path.basename(entry.filePath),
        filePath: entry.filePath,
        imageOutputDir,
        status: 'processed',
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        orientationId: orientationProbe.bestOrientationId || null,
        orientationScore: Number(orientationProbe.bestScore || 0),
        invoiceNumber,
        invoiceConfidence: Number(nfExtraction.confidence || 0),
        invoiceOrigin: nfExtraction.origin || null,
        sourceRegion: nfExtraction.sourceRegion || null,
        sourceRegionId: nfExtraction.sourceRegionId || null,
        supportCount: Number(nfExtraction.supportCount || 0),
        roiSupportCount: Number(nfExtraction.roiSupportCount || 0),
        variantSupportCount: Number(nfExtraction.variantSupportCount || 0),
        usedFallback: !!nfExtraction.usedFallback,
        decisionReason: Array.isArray(nfExtraction.decisionReason) ? nfExtraction.decisionReason : [],
        candidates: Array.isArray(nfExtraction.candidates)
          ? nfExtraction.candidates.slice(0, 5).map((candidate) => ({
            nf: candidate.nf || null,
            confidence: Number(candidate.confidence || 0),
            supportCount: Number(candidate.supportCount || 0),
            roiSupportCount: Number(candidate.roiSupportCount || 0),
            variantSupportCount: Number(candidate.variantSupportCount || 0),
            origin: candidate.origin || null,
            usedFallback: !!candidate.usedFallback,
          }))
          : [],
        lookupFound: lookup ? !!lookup.found : null,
        lookupMode: lookup ? lookup.mode || null : null,
        lookupReason: lookup ? lookup.reason || null : null,
        lookupInvoiceId: lookup && lookup.invoice ? lookup.invoice.id || null : null,
        lookupTripId: lookup && lookup.invoice ? lookup.invoice.tripId || null : null,
      };
    } catch (error) {
      result = {
        messageId: entry.messageId || null,
        timestamp: entry.timestamp || null,
        occurredAt: entry.occurredAt || null,
        sender: entry.sender || null,
        fileName: entry.filePath ? path.basename(entry.filePath) : null,
        filePath: entry.filePath || null,
        status: 'error',
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: error.message,
      };
    }

    resultsByKey.set(resultKey, result);
    processedSinceLastWrite += 1;

    if (processedSinceLastWrite >= writeEvery) {
      const ordered = Array.from(resultsByKey.values())
        .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
      await writeJsonFile(reportPath, ordered);
      await writeJsonFile(summaryPath, summarize(ordered, candidates.length));
      processedSinceLastWrite = 0;
    }

    const label = result.status === 'processed'
      ? `${result.invoiceNumber || 'sem_nf'} | conf ${result.invoiceConfidence || 0} | lookup ${result.lookupFound === null ? '-' : result.lookupFound ? 'ok' : 'nao'}`
      : `erro | ${result.error}`;
    console.log(`[${index + 1}/${candidates.length}] ${entry.sender || '-'} | ${label}`);
  }

  const ordered = Array.from(resultsByKey.values())
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  const summary = summarize(ordered, candidates.length);

  await writeJsonFile(reportPath, ordered);
  await writeJsonFile(summaryPath, summary);

  console.log('');
  console.log(`Data alvo: ${targetDate}`);
  console.log(`Processadas: ${summary.processedCount}/${summary.totalCandidates}`);
  console.log(`Com NF: ${summary.detectedInvoiceCount}`);
  console.log(`Encontradas no banco: ${summary.lookupFoundCount}`);
  console.log(`Nao encontradas no banco: ${summary.lookupMissingCount}`);
  console.log(`Fallback usado: ${summary.fallbackUsedCount}`);
  console.log(`Relatorio: ${reportPath}`);
  console.log(`Resumo: ${summaryPath}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await ocrService.shutdown().catch(() => undefined);
    await apiService.shutdown().catch(() => undefined);
  });
