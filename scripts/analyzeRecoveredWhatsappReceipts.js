const fs = require('fs');
const path = require('path');
const env = require('../src/config/env');
const {
  PROCESSING_ENGINE_IDS,
} = require('../src/config/profiles');
const extractionOrchestrator = require('../src/services/extraction/documentExtractionOrchestrator.service');
const apiService = require('../src/services/api.service');
const { buildAnalysisFromProcessingResult } = require('../src/services/backendSyncPayloadAdapter.service');
const { resolveReceiptProcessingContext } = require('../src/services/processing/profileResolver.service');
const {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} = require('../src/utils/file');

const DEFAULT_LIMIT = 0;

const parseArgs = (argv = []) => argv.reduce((accumulator, token) => {
  const match = String(token || '').match(/^--([^=]+)=(.*)$/);
  if (!match) return accumulator;
  accumulator[match[1]] = match[2];
  return accumulator;
}, {});

const args = parseArgs(process.argv.slice(2));

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const clone = (value) => {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const targetDate = String(args.date || new Date().toISOString().slice(0, 10)).trim();
const mode = String(args.mode || 'fast').trim().toLowerCase();
const resume = parseBoolean(args.resume, true);
const writeEvery = Math.max(1, Number(args.writeEvery || 1) || 1);
const limit = Math.max(0, Number(args.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT);

const isFastMode = mode === 'fast';

const buildContext = () => {
  const baseContext = resolveReceiptProcessingContext({
    companyId: env.receiptDefaultCompanyId,
    source: 'whatsapp',
    documentType: env.receiptDefaultDocumentType || 'delivery_receipt',
    metadata: {},
  });

  const context = clone(baseContext);

  if (isFastMode) {
    context.documentProfile.extractionStrategy.primaryProvider = PROCESSING_ENGINE_IDS.googleVision;
    context.documentProfile.extractionStrategy.fallbackProviders = [];
    context.documentProfile.extractionStrategy.migrationProviders = [];
    context.documentProfile.extractionStrategy.allowLegacyOnFailure = false;
    context.documentProfile.fallbackPolicy.enabled = false;
  }

  return context;
};

const buildResultKey = (entry = {}) => String(entry.messageId || entry.filePath || '').trim();

const toIsoDate = (value) => {
  if (!value && value !== 0) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const buildProcessingEnvelope = ({ manifestEntry, extraction }) => ({
  request: {
    companyId: env.receiptDefaultCompanyId,
    source: 'whatsapp',
    documentType: env.receiptDefaultDocumentType || 'delivery_receipt',
    metadata: {
      source: 'whatsapp',
      sourceName: 'whatsapp',
      groupId: manifestEntry.groupId || null,
      groupName: manifestEntry.groupName || null,
      chatId: manifestEntry.groupId || null,
      messageId: manifestEntry.messageId || null,
      senderName: manifestEntry.sender || null,
      messageTimestamp: manifestEntry.timestamp || null,
    },
  },
  extraction: {
    providerId: extraction.selectedAttempt && extraction.selectedAttempt.providerId
      ? extraction.selectedAttempt.providerId
      : null,
    parsedDocument: extraction.selectedAttempt && extraction.selectedAttempt.parsedDocument
      ? extraction.selectedAttempt.parsedDocument
      : null,
    attempts: Array.isArray(extraction.attempts)
      ? extraction.attempts.map((attempt) => ({
        providerId: attempt.providerId,
        status: attempt.status,
        reason: attempt.reason || null,
      }))
      : [],
  },
  decision: extraction.decision || null,
});

const summarize = (results = [], totalCandidates = 0) => {
  const processed = results.filter((item) => item.status === 'processed');
  const errored = results.filter((item) => item.status === 'error');
  const withInvoice = processed.filter((item) => !!item.invoiceNumber);
  const lookupFound = processed.filter((item) => item.lookupFound === true);
  const lookupMissing = processed.filter((item) => item.lookupFound === false);
  const valid = processed.filter((item) => item.classification === 'valid');
  const review = processed.filter((item) => item.classification === 'review');
  const invalid = processed.filter((item) => item.classification === 'invalid');
  const legacyCandidates = processed.filter((item) => (
    !item.invoiceNumber
    || item.lookupFound === false
    || item.classification !== 'valid'
  ));

  return {
    targetDate,
    mode,
    totalCandidates,
    processedCount: processed.length,
    errorCount: errored.length,
    detectedInvoiceCount: withInvoice.length,
    lookupFoundCount: lookupFound.length,
    lookupMissingCount: lookupMissing.length,
    validCount: valid.length,
    reviewCount: review.length,
    invalidCount: invalid.length,
    legacyCandidatesCount: legacyCandidates.length,
    completionRate: totalCandidates
      ? Number((processed.length / totalCandidates).toFixed(4))
      : 0,
    invoiceDetectionRate: processed.length
      ? Number((withInvoice.length / processed.length).toFixed(4))
      : 0,
  };
};

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('Use --date=YYYY-MM-DD.');
  }

  const recoveryRoot = path.join(env.outputsDir, 'recovery', targetDate);
  const reportsDir = path.join(recoveryRoot, 'reports');
  const manifestPath = path.join(reportsDir, 'manifest.json');
  const outputReportPath = path.join(reportsDir, `${mode}-pass-report.json`);
  const outputSummaryPath = path.join(reportsDir, `${mode}-pass-summary.json`);

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Manifesto nao encontrado: ${manifestPath}`);
  }

  await ensureDir(reportsDir);

  const manifest = await readJsonFile(manifestPath);
  const candidates = manifest
    .filter((entry) => entry && entry.filePath && entry.status !== 'ignored_non_image_or_download_failed')
    .slice(0, limit > 0 ? limit : undefined);

  const existingResults = resume && await pathExists(outputReportPath)
    ? await readJsonFile(outputReportPath)
    : [];
  const resultsByKey = new Map(
    Array.isArray(existingResults)
      ? existingResults
        .map((entry) => [buildResultKey(entry), entry])
        .filter(([key]) => key)
      : [],
  );

  const context = buildContext();
  let processedSinceLastWrite = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const manifestEntry = candidates[index];
    const resultKey = buildResultKey(manifestEntry);

    if (!resultKey) continue;
    if (resume && resultsByKey.has(resultKey)) continue;

    const startedAt = Date.now();
    let result = null;

    try {
      if (!(await pathExists(manifestEntry.filePath))) {
        throw new Error('Arquivo de imagem nao encontrado para analise.');
      }

      const extraction = await extractionOrchestrator.extract({
        imagePath: manifestEntry.filePath,
        context,
      });
      const processingEnvelope = buildProcessingEnvelope({
        manifestEntry,
        extraction,
      });
      const analysis = buildAnalysisFromProcessingResult(processingEnvelope);
      const parsedDocument = processingEnvelope.extraction.parsedDocument || {};
      const fields = parsedDocument.fields || {};
      const invoiceNumber = analysis.nfExtraction && analysis.nfExtraction.nf
        ? analysis.nfExtraction.nf
        : null;
      const lookup = invoiceNumber
        ? await apiService.findInvoiceByNumber(invoiceNumber)
        : null;

      result = {
        messageId: manifestEntry.messageId || null,
        timestamp: manifestEntry.timestamp || null,
        occurredAt: manifestEntry.occurredAt || null,
        sender: manifestEntry.sender || null,
        fileName: path.basename(manifestEntry.filePath),
        filePath: manifestEntry.filePath,
        status: 'processed',
        mode,
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        providerId: processingEnvelope.extraction.providerId,
        providerAttempts: processingEnvelope.extraction.attempts,
        classification: analysis.classification && analysis.classification.classification
          ? analysis.classification.classification
          : 'invalid',
        reasons: analysis.classification && Array.isArray(analysis.classification.reasons)
          ? analysis.classification.reasons
          : [],
        invoiceNumber,
        invoiceConfidence: analysis.nfExtraction ? Number(analysis.nfExtraction.confidence || 0) : 0,
        receiptDate: fields.receiptDate && fields.receiptDate.found ? fields.receiptDate.value || null : null,
        issuerHeaderFound: !!(fields.issuerHeader && fields.issuerHeader.found),
        issuerHeaderConfidence: fields.issuerHeader ? Number(fields.issuerHeader.confidence || 0) : 0,
        averageConfidence: parsedDocument.summary ? Number(parsedDocument.summary.averageConfidence || 0) : 0,
        missingFieldKeys: parsedDocument.summary && Array.isArray(parsedDocument.summary.missingFieldKeys)
          ? parsedDocument.summary.missingFieldKeys
          : [],
        lookupFound: lookup ? !!lookup.found : null,
        lookupMode: lookup ? lookup.mode || null : null,
        lookupReason: lookup ? lookup.reason || null : null,
        lookupCompanyCode: lookup && lookup.company ? lookup.company.code || null : null,
        lookupInvoiceId: lookup && lookup.invoice ? lookup.invoice.id || null : null,
        lookupInvoiceNumber: lookup && lookup.invoice ? lookup.invoice.number || null : null,
        lookupTripId: lookup && lookup.invoice ? lookup.invoice.tripId || null : null,
        lookupTripDate: lookup && lookup.invoice ? toIsoDate(lookup.invoice.tripDate) : null,
      };
    } catch (error) {
      result = {
        messageId: manifestEntry.messageId || null,
        timestamp: manifestEntry.timestamp || null,
        occurredAt: manifestEntry.occurredAt || null,
        sender: manifestEntry.sender || null,
        fileName: manifestEntry.filePath ? path.basename(manifestEntry.filePath) : null,
        filePath: manifestEntry.filePath || null,
        status: 'error',
        mode,
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: error.message,
      };
    }

    resultsByKey.set(resultKey, result);
    processedSinceLastWrite += 1;

    if (processedSinceLastWrite >= writeEvery) {
      const orderedResults = Array.from(resultsByKey.values())
        .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
      await writeJsonFile(outputReportPath, orderedResults);
      await writeJsonFile(outputSummaryPath, summarize(orderedResults, candidates.length));
      processedSinceLastWrite = 0;
    }

    const label = result.status === 'processed'
      ? `${result.invoiceNumber || 'sem_nf'} | ${result.classification} | lookup ${result.lookupFound === null ? '-' : result.lookupFound ? 'ok' : 'nao'}`
      : `erro | ${result.error}`;

    console.log(`[${index + 1}/${candidates.length}] ${manifestEntry.sender || '-'} | ${label}`);
  }

  const orderedResults = Array.from(resultsByKey.values())
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  const summary = summarize(orderedResults, candidates.length);

  await writeJsonFile(outputReportPath, orderedResults);
  await writeJsonFile(outputSummaryPath, summary);

  console.log('');
  console.log(`Data alvo: ${targetDate}`);
  console.log(`Modo: ${mode}`);
  console.log(`Processadas: ${summary.processedCount}/${summary.totalCandidates}`);
  console.log(`Com NF: ${summary.detectedInvoiceCount}`);
  console.log(`NF encontrada no banco: ${summary.lookupFoundCount}`);
  console.log(`Validas: ${summary.validCount} | Revisao: ${summary.reviewCount} | Invalidas: ${summary.invalidCount}`);
  console.log(`Candidatas para OCR pesado: ${summary.legacyCandidatesCount}`);
  console.log(`Relatorio: ${outputReportPath}`);
  console.log(`Resumo: ${outputSummaryPath}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await apiService.shutdown().catch(() => undefined);
  });
