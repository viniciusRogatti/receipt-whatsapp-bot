const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const env = require('../config/env');
const logger = require('../utils/logger');
const {
  normalizeOcrNoise,
  splitNormalizedLines,
  tokenizeSearchableText,
  toSearchableText,
  truncateText,
} = require('../utils/textNormalization');

const workerPools = {};
const DEFAULT_OCR_PARAMETERS = {
  preserve_interword_spaces: '1',
};
const TESSERACT_NOISE_PATTERNS = [
  /^Total count=/,
  /^Min=/,
  /^Lower quartile=/,
  /^Median=/,
  /^Upper quartile=/,
  /^Max=/,
  /^Range=/,
  /^Mean=/,
  /^SD=/,
  /^Bottom=/,
  /^Image too small to scale!!/,
  /^Line cannot be recognized!!/,
];

let consoleSuppressionDepth = 0;
let restoreConsoleWriters = null;

const shouldSuppressTesseractLine = (line) => {
  const normalized = String(line || '').trim();
  if (!normalized) return false;
  return TESSERACT_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
};

const patchConsoleWrite = (stream) => {
  const originalWrite = stream.write.bind(stream);
  let buffer = '';

  stream.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    const visible = lines.filter((line) => !shouldSuppressTesseractLine(line));

    if (visible.length) {
      return originalWrite(`${visible.join('\n')}\n`, encoding, callback);
    }

    if (typeof callback === 'function') callback();
    return true;
  };

  return () => {
    if (buffer && !shouldSuppressTesseractLine(buffer)) {
      originalWrite(buffer);
    }
    stream.write = originalWrite;
  };
};

const withSuppressedTesseractConsole = async (callback) => {
  if (!env.ocrSuppressConsoleNoise) {
    return callback();
  }

  if (!restoreConsoleWriters) {
    const restoreStdout = patchConsoleWrite(process.stdout);
    const restoreStderr = patchConsoleWrite(process.stderr);
    restoreConsoleWriters = () => {
      restoreStdout();
      restoreStderr();
      restoreConsoleWriters = null;
    };
  }

  consoleSuppressionDepth += 1;

  try {
    return await callback();
  } finally {
    consoleSuppressionDepth -= 1;
    if (consoleSuppressionDepth <= 0 && restoreConsoleWriters) {
      restoreConsoleWriters();
      consoleSuppressionDepth = 0;
    }
  }
};

const hasLocalTrainedData = (language) => {
  const langs = String(language || '')
    .split('+')
    .map((lang) => String(lang || '').trim())
    .filter(Boolean);

  if (!langs.length) return false;

  return langs.every((lang) => (
    fs.existsSync(path.join(env.ocrLangPath, `${lang}.traineddata`))
  ));
};

const createWorkerInstance = async (workerKey, workerIndex) => {
  const useLocalPlainTrainedData = hasLocalTrainedData(workerKey);
  logger.info('Inicializando OCR.', {
    language: workerKey,
    workerIndex,
    langPath: env.ocrLangPath,
    gzip: !useLocalPlainTrainedData,
  });

  const worker = await withSuppressedTesseractConsole(() => Tesseract.createWorker(workerKey, undefined, {
    langPath: env.ocrLangPath,
    gzip: !useLocalPlainTrainedData,
    logger: (event) => {
      if (event.status === 'recognizing text') {
        logger.debug('OCR em andamento.', {
          language: workerKey,
          workerIndex,
          progress: Number(event.progress || 0).toFixed(2),
        });
      }
    },
  }));
  await withSuppressedTesseractConsole(() => worker.setParameters(DEFAULT_OCR_PARAMETERS));
  return worker;
};

const getWorkerPool = async (language) => {
  const workerKey = String(language || env.ocrFullLang);
  if (workerPools[workerKey]) return workerPools[workerKey];

  workerPools[workerKey] = Promise.all(
    Array.from({ length: env.ocrWorkerPoolSize }).map((_, index) => (
      createWorkerInstance(workerKey, index)
    )),
  );

  return workerPools[workerKey];
};

const buildProbeInput = async (filePath, options = {}) => {
  const image = await Jimp.read(filePath);
  const maxEdge = Number(options.maxEdge || 0);
  const minEdge = Number(options.minEdge || 0);
  let longestEdge = Math.max(image.bitmap.width, image.bitmap.height);

  if (maxEdge && longestEdge > maxEdge) {
    image.scale(maxEdge / longestEdge);
    longestEdge = Math.max(image.bitmap.width, image.bitmap.height);
  }

  if (minEdge && longestEdge < minEdge) {
    image.scale(minEdge / longestEdge);
  }

  return image.getBufferAsync(Jimp.MIME_PNG);
};

const buildRecognitionResult = (target, data, error) => {
  const rawText = data ? String(data.text || '') : '';
  const normalizedText = normalizeOcrNoise(rawText);
  const searchableText = toSearchableText(rawText);
  const confidence = Number(data && data.confidence ? data.confidence : 0);
  const lines = splitNormalizedLines(rawText);
  const score = error ? 0 : Number(confidence.toFixed(2));

  return {
    targetId: target.id || null,
    label: target.label || null,
    filePath: target.filePath || null,
    sourceType: target.sourceType || 'image',
    confidence: Number(confidence.toFixed(2)),
    score,
    textRaw: rawText,
    textNormalized: normalizedText,
    searchableText,
    textPreview: truncateText(normalizedText, 320),
    lineCount: lines.length,
    wordCount: tokenizeSearchableText(rawText).length,
    characterCount: searchableText.replace(/\s/g, '').length,
    meta: target.meta || null,
    error: error ? error.message : null,
  };
};

const rankResults = (results) => results
  .slice()
  .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

const serializeParameters = (parameters = {}) => JSON.stringify(
  Object.keys(parameters)
    .sort()
    .reduce((accumulator, key) => {
      accumulator[key] = String(parameters[key]);
      return accumulator;
    }, {}),
);

module.exports = {
  async recognizeTargets(targets = [], options = {}) {
    if (!targets.length) {
      return {
        attempted: false,
        language: options.language || env.ocrFullLang,
        totalTargets: 0,
        results: [],
        bestTargetId: null,
        bestConfidence: null,
        bestScore: null,
        bestResult: null,
        bestTextRaw: '',
        bestTextNormalized: '',
      };
    }

    const language = options.language || env.ocrFullLang;
    const maxEdge = Number(options.maxEdge || env.ocrFullMaxEdge || 0);
    const workers = await getWorkerPool(language);
    const baseParameters = Object.assign({}, DEFAULT_OCR_PARAMETERS, options.parameters || {});
    const indexedTargets = targets.map((target, index) => ({ target, index }));
    const results = new Array(targets.length);
    const workerStates = workers.map(() => ({
      currentParameters: null,
    }));

    await Promise.all(workers.map(async (worker, workerIndex) => {
      while (indexedTargets.length) {
        const item = indexedTargets.shift();
        if (!item) break;

        const { target, index } = item;
        const targetParameters = Object.assign({}, baseParameters, target.parameters || {});
        const parameterSignature = serializeParameters(targetParameters);

        if (parameterSignature !== workerStates[workerIndex].currentParameters) {
          await worker.setParameters(targetParameters);
          workerStates[workerIndex].currentParameters = parameterSignature;
        }

        try {
          const probeInput = await buildProbeInput(target.filePath, {
            maxEdge,
            minEdge: options.minEdge,
          });
          const recognition = await withSuppressedTesseractConsole(() => worker.recognize(probeInput));
          const data = recognition && recognition.data ? recognition.data : {};
          results[index] = buildRecognitionResult(target, data, null);
        } catch (error) {
          logger.warn('Falha ao executar OCR em um alvo.', {
            targetId: target.id || null,
            filePath: target.filePath || null,
            error: error.message,
          });

          results[index] = buildRecognitionResult(target, null, error);
        }
      }
    }));

    const ranked = rankResults(results);
    const best = ranked[0] || null;

    return {
      attempted: true,
      language,
      totalTargets: targets.length,
      results,
      bestTargetId: best ? best.targetId : null,
      bestConfidence: best ? best.confidence : null,
      bestScore: best ? best.score : null,
      bestResult: best,
      bestTextRaw: best ? best.textRaw : '',
      bestTextNormalized: best ? best.textNormalized : '',
    };
  },

  async probeVariants(variants = []) {
    return this.recognizeTargets(
      (variants || []).map((variant) => ({
        id: variant.id,
        label: variant.label,
        filePath: variant.filePath,
        sourceType: 'variant_probe',
      })),
      {
        language: env.ocrRegionLang,
        maxEdge: env.ocrRegionMaxEdge,
      },
    );
  },

  async runFullOcr({ variants = [] }) {
    return this.recognizeTargets(
      (variants || []).map((variant) => ({
        id: variant.id,
        label: variant.label,
        filePath: variant.filePath,
        sourceType: 'variant_full',
      })),
      {
        language: env.ocrFullLang,
        maxEdge: env.ocrFullMaxEdge,
      },
    );
  },

  async shutdown() {
    const workerKeys = Object.keys(workerPools);

    for (const workerKey of workerKeys) {
      const workers = await workerPools[workerKey];
      await Promise.all(workers.map((worker) => worker.terminate()));
      delete workerPools[workerKey];
    }
  },
};
