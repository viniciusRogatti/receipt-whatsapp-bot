const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const env = require('../src/config/env');
const receiptAnalysisService = require('../src/services/receiptAnalysis.service');
const ocrService = require('../src/services/ocr.service');
const apiService = require('../src/services/api.service');
const {
  ensureDir,
  writeJsonFile,
} = require('../src/utils/file');

const DEFAULT_LIMIT = 500;

const parseArgs = (argv = []) => argv.reduce((accumulator, token) => {
  const match = String(token || '').match(/^--([^=]+)=(.*)$/);
  if (!match) return accumulator;
  accumulator[match[1]] = match[2];
  return accumulator;
}, {});

const args = parseArgs(process.argv.slice(2));

const targetDate = String(args.date || new Date().toISOString().slice(0, 10)).trim();
const fetchLimit = Math.max(50, Number(args.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT);
const groupId = String(
  args.groupId
  || env.whatsappAllowedGroupIds[0]
  || '',
).trim();
const downloadOnly = ['1', 'true', 'yes', 'on'].includes(String(args.downloadOnly || '').trim().toLowerCase());

const sanitizeSegment = (value, fallback = 'item') => {
  const normalized = String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const buildPuppeteerOptions = () => {
  const browserArgs = env.whatsappBrowserArgs.length
    ? env.whatsappBrowserArgs.slice()
    : ['--no-sandbox', '--disable-setuid-sandbox'];

  const options = {
    headless: env.whatsappHeadless,
    args: browserArgs,
  };

  if (env.whatsappBrowserExecutablePath) {
    options.executablePath = env.whatsappBrowserExecutablePath;
  }

  return options;
};

const buildClient = () => new Client({
  authStrategy: new LocalAuth({
    clientId: env.whatsappClientId,
    dataPath: env.whatsappSessionDir,
  }),
  puppeteer: buildPuppeteerOptions(),
});

const getTargetDateParts = (dateString) => {
  const normalized = String(dateString || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error('Use --date=YYYY-MM-DD.');
  }

  const [year, month, day] = normalized.split('-').map((item) => Number(item));
  return { year, month, day };
};

const isMessageOnTargetDate = (messageTimestampSeconds, dateString) => {
  const timestamp = Number(messageTimestampSeconds || 0);
  if (!timestamp) return false;

  const date = new Date(timestamp * 1000);
  const parts = getTargetDateParts(dateString);

  return (
    date.getFullYear() === parts.year
    && (date.getMonth() + 1) === parts.month
    && date.getDate() === parts.day
  );
};

const guessExtensionFromMime = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('bmp')) return '.bmp';
  if (normalized.includes('tif')) return '.tif';
  return '.jpg';
};

const extractPhoneDigits = (value) => {
  const match = String(value || '').match(/^(\d+)(?:@|$)/);
  return match ? match[1] : null;
};

const resolveSenderLabel = async (message) => {
  try {
    if (typeof message.getContact === 'function') {
      const contact = await message.getContact();
      return (
        String(contact?.name || '').trim()
        || String(contact?.shortName || '').trim()
        || String(contact?.pushname || '').trim()
        || String(contact?.number || '').trim()
        || extractPhoneDigits(contact?.id?._serialized)
        || null
      );
    }
  } catch {
    return null;
  }

  return null;
};

const formatDateTime = (value) => {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return '';

  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

const toCandidateList = (analysis = {}) => {
  const candidates = Array.isArray(analysis.nfExtraction?.candidates)
    ? analysis.nfExtraction.candidates
    : [];

  return candidates.slice(0, 5).map((candidate) => ({
    nf: candidate.nf || null,
    confidence: Number(candidate.confidence || 0),
    origin: candidate.origin || null,
    supportCount: Number(candidate.supportCount || 0),
  }));
};

async function main() {
  if (!groupId) {
    throw new Error('Nenhum grupo configurado. Informe --groupId=... ou configure WHATSAPP_ALLOWED_GROUP_IDS.');
  }

  const recoveryRoot = path.join(env.outputsDir, 'recovery', targetDate);
  const rawDir = path.join(recoveryRoot, 'raw');
  const analysisDir = path.join(recoveryRoot, 'analysis');
  const reportsDir = path.join(recoveryRoot, 'reports');
  const manifestPath = path.join(reportsDir, 'manifest.json');
  const summaryPath = path.join(reportsDir, 'summary.json');

  await Promise.all([
    ensureDir(rawDir),
    ensureDir(analysisDir),
    ensureDir(reportsDir),
  ]);

  const client = buildClient();

  const resultPromise = new Promise((resolve, reject) => {
    const fail = async (error) => {
      try {
        await client.destroy();
      } catch {
        // noop
      }
      reject(error);
    };

    client.on('auth_failure', async (message) => {
      await fail(new Error(`Falha de autenticacao no WhatsApp: ${message}`));
    });

    client.on('ready', async () => {
      try {
        const chat = await client.getChatById(groupId);
        const messages = await chat.fetchMessages({ limit: fetchLimit });
        const todayMessages = messages
          .filter((message) => isMessageOnTargetDate(message.timestamp, targetDate))
          .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));

        const imageMessages = todayMessages.filter((message) => message.hasMedia);
        const manifest = [];

        for (const message of imageMessages) {
          const senderLabel = await resolveSenderLabel(message);
          const messageId = message.id && message.id._serialized
            ? message.id._serialized
            : String(message.id || '');
          const occurredAtMs = Number(message.timestamp || 0) * 1000;
          const occurredAtLabel = formatDateTime(occurredAtMs);

          let media = null;
          let downloadError = null;
          try {
            media = await message.downloadMedia();
          } catch (error) {
            downloadError = error;
          }

          if (!media || !String(media.mimetype || '').startsWith('image/')) {
            manifest.push({
              messageId,
              timestamp: occurredAtMs || null,
              occurredAt: occurredAtLabel || null,
              sender: senderLabel,
              hasMedia: !!message.hasMedia,
              mediaType: media ? media.mimetype : null,
              status: 'ignored_non_image_or_download_failed',
              error: downloadError ? downloadError.message : null,
            });
            continue;
          }

          const extension = guessExtensionFromMime(media.mimetype);
          const fileStem = `${String(message.timestamp || '0')}-${sanitizeSegment(messageId, 'msg')}`;
          const imagePath = path.join(rawDir, `${fileStem}${extension}`);
          await fs.promises.writeFile(imagePath, Buffer.from(media.data, 'base64'));

          const entry = {
            messageId,
            timestamp: occurredAtMs || null,
            occurredAt: occurredAtLabel || null,
            sender: senderLabel,
            filePath: imagePath,
            mediaType: media.mimetype,
            status: downloadOnly ? 'downloaded' : 'pending_analysis',
          };

          if (!downloadOnly) {
            try {
              const analysis = await receiptAnalysisService.analyzeImage({
                imagePath,
                outputDir: path.join(analysisDir, sanitizeSegment(fileStem, 'analysis')),
                profile: 'batch',
              });

              entry.status = 'analyzed';
              entry.analysis = {
                classification: analysis.classification?.classification || null,
                businessScore: Number(analysis.classification?.metrics?.businessScore || 0),
                invoiceNumber: analysis.nfExtraction?.nf || null,
                invoiceConfidence: Number(analysis.nfExtraction?.confidence || 0),
                invoiceOrigin: analysis.nfExtraction?.origin || null,
                invoiceLookupFound: !!analysis.invoiceLookup?.found,
                failedCheckpoints: analysis.diagnostics?.summary?.failedLabels || [],
                reasons: analysis.classification?.reasons || [],
                candidates: toCandidateList(analysis),
              };
            } catch (error) {
              entry.status = 'analysis_failed';
              entry.error = error.message;
            }
          }

          manifest.push(entry);
        }

        const summary = {
          targetDate,
          groupId,
          fetchedMessages: messages.length,
          todaysMessages: todayMessages.length,
          imageMessages: imageMessages.length,
          downloadedCount: manifest.filter((item) => item.status === 'downloaded' || item.status === 'analyzed' || item.status === 'analysis_failed').length,
          analyzedCount: manifest.filter((item) => item.status === 'analyzed').length,
          analysisFailedCount: manifest.filter((item) => item.status === 'analysis_failed').length,
          ignoredCount: manifest.filter((item) => item.status === 'ignored_non_image_or_download_failed').length,
          detectedInvoiceCount: manifest.filter((item) => item.analysis?.invoiceNumber).length,
          validCount: manifest.filter((item) => item.analysis?.classification === 'valid').length,
          reviewCount: manifest.filter((item) => item.analysis?.classification === 'review').length,
          invalidCount: manifest.filter((item) => item.analysis?.classification === 'invalid').length,
          manifestPath,
        };

        await writeJsonFile(manifestPath, manifest);
        await writeJsonFile(summaryPath, summary);

        await client.destroy();
        resolve({
          recoveryRoot,
          manifestPath,
          summaryPath,
          summary,
          manifest,
        });
      } catch (error) {
        await fail(error);
      }
    });

    client.on('qr', () => {
      reject(new Error('Sessao do WhatsApp nao esta autenticada nesta maquina.'));
    });
  });

  await client.initialize();
  const result = await resultPromise;

  console.log(`Grupo: ${groupId}`);
  console.log(`Data alvo: ${targetDate}`);
  console.log(`Mensagens do dia: ${result.summary.todaysMessages}`);
  console.log(`Midias do dia: ${result.summary.imageMessages}`);
  console.log(`Baixadas: ${result.summary.downloadedCount}`);
  console.log(`Analisadas: ${result.summary.analyzedCount}`);
  console.log(`NF detectada: ${result.summary.detectedInvoiceCount}`);
  console.log(`Validas: ${result.summary.validCount} | Revisao: ${result.summary.reviewCount} | Invalidas: ${result.summary.invalidCount}`);
  console.log(`Manifesto: ${result.manifestPath}`);
  console.log(`Resumo: ${result.summaryPath}`);

  const withInvoice = result.manifest.filter((item) => item.analysis?.invoiceNumber);
  if (withInvoice.length) {
    console.log('');
    console.log('Leituras com NF detectada');
    withInvoice.forEach((item) => {
      console.log(`- ${item.occurredAt || '-'} | ${item.sender || '-'} | NF ${item.analysis.invoiceNumber} | ${item.analysis.classification || '-'} | score ${item.analysis.businessScore}`);
    });
  }

  const withoutInvoice = result.manifest.filter((item) => item.status === 'analysis_failed' || (item.status === 'analyzed' && !item.analysis?.invoiceNumber));
  if (withoutInvoice.length) {
    console.log('');
    console.log('Itens sem NF fechada');
    withoutInvoice.forEach((item) => {
      const reason = item.error || (item.analysis?.reasons || []).join(' | ') || '-';
      console.log(`- ${item.occurredAt || '-'} | ${item.sender || '-'} | ${reason}`);
    });
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await apiService.shutdown().catch(() => undefined);
    await ocrService.shutdown().catch(() => undefined);
  });
