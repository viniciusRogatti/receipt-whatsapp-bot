const path = require('path');
const env = require('../src/config/env');
const apiService = require('../src/services/api.service');
const {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} = require('../src/utils/file');

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

const args = parseArgs(process.argv.slice(2));
const targetDate = String(args.date || new Date().toISOString().slice(0, 10)).trim();
const resume = parseBoolean(args.resume, true);
const includeLookupMissing = parseBoolean(args.includeLookupMissing, false);
const minConfidence = Math.max(0, Number(args.minConfidence || 0) || 0);
const limit = Math.max(0, Number(args.limit || 0) || 0);

const buildResultKey = (item = {}) => String(item.messageId || item.filePath || '').trim();

const summarize = (results = [], totalCandidates = 0) => ({
  targetDate,
  totalCandidates,
  importedCount: results.filter((item) => item.status === 'imported').length,
  alreadyExistsCount: results.filter((item) => item.status === 'already_exists').length,
  skippedCount: results.filter((item) => item.status === 'skipped').length,
  failedCount: results.filter((item) => item.status === 'failed').length,
});

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('Use --date=YYYY-MM-DD.');
  }

  const recoveryRoot = path.join(env.outputsDir, 'recovery', targetDate);
  const reportsDir = path.join(recoveryRoot, 'reports');
  const sourceReportPath = path.join(reportsDir, 'nf-roi-report.json');
  const importReportPath = path.join(reportsDir, 'receipts-import-report.json');
  const importSummaryPath = path.join(reportsDir, 'receipts-import-summary.json');

  if (!(await pathExists(sourceReportPath))) {
    throw new Error(`Relatorio de leitura nao encontrado: ${sourceReportPath}`);
  }

  await ensureDir(reportsDir);

  const sourceReport = await readJsonFile(sourceReportPath);
  const existingImportReport = resume && await pathExists(importReportPath)
    ? await readJsonFile(importReportPath)
    : [];
  const resultsByKey = new Map(
    Array.isArray(existingImportReport)
      ? existingImportReport
        .map((entry) => [buildResultKey(entry), entry])
        .filter(([key]) => key)
      : [],
  );

  const candidates = sourceReport
    .filter((item) => item && item.status === 'processed')
    .filter((item) => !!item.invoiceNumber)
    .filter((item) => includeLookupMissing ? true : item.lookupFound === true)
    .filter((item) => Number(item.invoiceConfidence || 0) >= minConfidence)
    .slice(0, limit > 0 ? limit : undefined);

  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    const resultKey = buildResultKey(item);
    if (!resultKey) continue;
    if (resume && resultsByKey.has(resultKey)) continue;

    let result;

    try {
      const lookup = await apiService.findInvoiceByNumber(item.invoiceNumber);
      const upload = await apiService.importRecoveredReceiptEvidence({
        invoiceNumber: item.invoiceNumber,
        imagePath: item.filePath,
        lookup,
        metadata: {
          source: 'whatsapp_recovery',
          sourceName: 'whatsapp_recovery',
          messageId: item.messageId || null,
          messageTimestamp: item.timestamp || null,
          senderName: item.sender || null,
          deliveredAt: item.timestamp || null,
        },
      });

      result = {
        messageId: item.messageId || null,
        timestamp: item.timestamp || null,
        occurredAt: item.occurredAt || null,
        sender: item.sender || null,
        filePath: item.filePath || null,
        invoiceNumber: item.invoiceNumber || null,
        invoiceConfidence: Number(item.invoiceConfidence || 0),
        lookupFound: !!lookup.found,
        processedAt: new Date().toISOString(),
        status: upload.uploaded
          ? 'imported'
          : upload.reason === 'receipt_already_exists'
            ? 'already_exists'
            : 'skipped',
        upload,
      };
    } catch (error) {
      result = {
        messageId: item.messageId || null,
        timestamp: item.timestamp || null,
        occurredAt: item.occurredAt || null,
        sender: item.sender || null,
        filePath: item.filePath || null,
        invoiceNumber: item.invoiceNumber || null,
        invoiceConfidence: Number(item.invoiceConfidence || 0),
        processedAt: new Date().toISOString(),
        status: 'failed',
        error: {
          message: error.message,
          code: error.code || null,
          status: Number(error.status || 0) || null,
          details: error.details || null,
        },
      };
    }

    resultsByKey.set(resultKey, result);

    const ordered = Array.from(resultsByKey.values())
      .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
    await writeJsonFile(importReportPath, ordered);
    await writeJsonFile(importSummaryPath, summarize(ordered, candidates.length));

    if (result.status === 'imported') {
      console.log(`[${index + 1}/${candidates.length}] NF ${result.invoiceNumber} importada para a pagina.`);
    } else if (result.status === 'already_exists') {
      console.log(`[${index + 1}/${candidates.length}] NF ${result.invoiceNumber} ja tinha canhoto na pagina.`);
    } else if (result.status === 'skipped') {
      console.log(`[${index + 1}/${candidates.length}] NF ${result.invoiceNumber} ignorada: ${result.upload.reason || 'skip'}.`);
    } else {
      console.log(`[${index + 1}/${candidates.length}] NF ${result.invoiceNumber || '-'} falhou: ${result.error.message}.`);
    }
  }

  const ordered = Array.from(resultsByKey.values())
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  const summary = summarize(ordered, candidates.length);
  await writeJsonFile(importReportPath, ordered);
  await writeJsonFile(importSummaryPath, summary);

  console.log('');
  console.log(`Data alvo: ${targetDate}`);
  console.log(`Candidatas: ${summary.totalCandidates}`);
  console.log(`Importadas: ${summary.importedCount}`);
  console.log(`Ja existentes: ${summary.alreadyExistsCount}`);
  console.log(`Ignoradas: ${summary.skippedCount}`);
  console.log(`Falhas: ${summary.failedCount}`);
  console.log(`Relatorio: ${importReportPath}`);
  console.log(`Resumo: ${importSummaryPath}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await apiService.shutdown().catch(() => undefined);
  });
