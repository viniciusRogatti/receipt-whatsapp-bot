const {
  digitsOnly,
  normalizeOcrNoise,
  splitNormalizedLines,
  stripAccents,
  toSearchableText,
  truncateText,
} = require('../utils/textNormalization');
const env = require('../config/env');
const { buildEvidenceDocuments } = require('./receiptPipeline/receiptEvidence.service');
const { BUSINESS_THRESHOLDS } = require('./receiptPipeline/receiptConstants');
const receiptNfOcrService = require('./receiptPipeline/receiptNfOcr.service');

const NF_MARKER_REGEX = /\b(?:nf\s*e|nfe|nota fiscal(?: eletronica)?)\b/gi;
const NUMBER_MARKER_REGEX = /\b(?:numero|n\s*o|nro|no)\b/gi;
const DIGIT_GROUP_REGEX = /\b\d{5,10}\b/g;
const FUZZY_DIGIT_SEQUENCE_REGEX = /[0-9A-Z!]+/gi;
const OCR_FUZZY_DIGIT_MAP = {
  B: '8',
  D: '0',
  G: '6',
  I: '1',
  L: '1',
  O: '0',
  Q: '0',
  S: '5',
  T: '7',
  Z: '2',
};

const isDigitLikeCharacter = (character) => (
  /\d/.test(character)
  || character === 'A'
  || character === 'N'
  || Object.prototype.hasOwnProperty.call(OCR_FUZZY_DIGIT_MAP, character)
);

const collectRegexMatches = (text, regex) => {
  const sourceText = String(text || '');
  const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const matches = [];
  let match = globalRegex.exec(sourceText);

  while (match) {
    matches.push({
      match: match[0],
      index: match.index,
      groups: match.slice(1),
    });
    match = globalRegex.exec(sourceText);
  }

  return matches;
};

const buildSearchableText = (value) => toSearchableText(stripAccents(normalizeOcrNoise(value)));

const buildLineWindows = (source) => {
  const rawLines = Array.isArray(source.lines) && source.lines.length
    ? source.lines
    : splitNormalizedLines(source.textRaw || source.textNormalized || '');
  const searchableLines = rawLines.map((line) => buildSearchableText(line));
  const windows = [];
  const seen = {};

  searchableLines.forEach((searchableLine, index) => {
    const candidates = [
      {
        rawText: rawLines[index],
        searchableText: searchableLine,
      },
      {
        rawText: [rawLines[index], rawLines[index + 1]].filter(Boolean).join(' '),
        searchableText: [searchableLines[index], searchableLines[index + 1]].filter(Boolean).join(' '),
      },
      {
        rawText: [rawLines[index - 1], rawLines[index]].filter(Boolean).join(' '),
        searchableText: [searchableLines[index - 1], searchableLines[index]].filter(Boolean).join(' '),
      },
      {
        rawText: [rawLines[index - 1], rawLines[index], rawLines[index + 1]].filter(Boolean).join(' '),
        searchableText: [
          searchableLines[index - 1],
          searchableLines[index],
          searchableLines[index + 1],
        ].filter(Boolean).join(' '),
      },
    ];

    candidates.forEach((candidate) => {
      const searchableText = String(candidate.searchableText || '').trim();
      const rawText = normalizeOcrNoise(candidate.rawText || '');
      const key = `${searchableText}::${rawText}`;
      if (!searchableText || !rawText || seen[key]) return;
      seen[key] = true;
      windows.push({
        rawText,
        searchableText,
      });
    });
  });

  const rawFullText = normalizeOcrNoise(source.textRaw || source.textNormalized || '');
  const fullText = buildSearchableText(source.textRaw || source.textNormalized || '');
  const fullKey = `${fullText}::${rawFullText}`;
  if (fullText && rawFullText && !seen[fullKey]) {
    windows.push({
      rawText: rawFullText,
      searchableText: fullText,
    });
  }
  return windows;
};

const inferContext = (text) => ({
  foundNfe: collectRegexMatches(text, NF_MARKER_REGEX).length > 0,
  foundNumeroMarker: collectRegexMatches(text, NUMBER_MARKER_REGEX).length > 0,
});

const computeDistanceBonus = (digitIndex, markers = [], nearBonus, midBonus) => {
  if (!markers.length) return 0;
  const distances = markers.map((marker) => Math.abs(digitIndex - marker.index));
  const nearest = Math.min.apply(null, distances);

  if (nearest <= 8) return nearBonus;
  if (nearest <= 20) return midBonus;
  if (nearest <= 36) return Math.max(0, midBonus / 2);
  return 0;
};

const hasImprobableDigits = (nf) => /^(\d)\1+$/.test(nf);
const isExpectedNfLength = (nf) => {
  const size = String(nf || '').length;
  return Array.isArray(env.ocrExpectedNfLengths) && env.ocrExpectedNfLengths.length
    ? env.ocrExpectedNfLengths.includes(size)
    : size >= 5 && size <= 8;
};

const normalizeFuzzyDigitSequence = (value) => {
  const normalized = normalizeOcrNoise(value).toUpperCase();
  let digits = '';
  let mappedCount = 0;
  let droppedCount = 0;
  let digitCount = 0;
  const characters = normalized.split('');

  characters.forEach((character, index) => {
    if (/\d/.test(character)) {
      digits += character;
      digitCount += 1;
      return;
    }

    if (character === 'A') {
      const isTerminal = index === characters.length - 1;
      digits += isTerminal ? '1' : '0';
      mappedCount += 1;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(OCR_FUZZY_DIGIT_MAP, character)) {
      digits += OCR_FUZZY_DIGIT_MAP[character];
      mappedCount += 1;
      return;
    }

    if (character === 'N') {
      const previousCharacter = characters[index - 1] || '';
      const nextCharacter = characters[index + 1] || '';
      if (isDigitLikeCharacter(previousCharacter) && isDigitLikeCharacter(nextCharacter)) {
        digits += '0';
        mappedCount += 1;
        return;
      }
      droppedCount += 1;
      return;
    }

    if (character === ' ' || character === '-' || character === '.' || character === ',' || character === ':') {
      return;
    }

    droppedCount += 1;
  });

  return {
    digits,
    mappedCount,
    droppedCount,
    digitCount,
  };
};

const extractFuzzyDigitCandidates = (value) => collectRegexMatches(
  normalizeOcrNoise(value).toUpperCase(),
  FUZZY_DIGIT_SEQUENCE_REGEX,
).map((match) => {
  const normalized = normalizeFuzzyDigitSequence(match.match);
  return Object.assign({}, match, normalized);
}).filter((match) => (
  isExpectedNfLength(match.digits)
  && match.digitCount >= 2
  && (match.digitCount >= 4 || match.mappedCount >= 2)
  && match.droppedCount <= 2
));

const buildSourceBonus = (source) => {
  let score = 0;
  const requestedRoiId = source.meta && source.meta.requestedRoiId ? source.meta.requestedRoiId : source.requestedRoiId;
  const targetRole = source.targetRole || (source.meta && source.meta.targetRole) || '';

  if (requestedRoiId === 'nf_number_tight') score += 0.36;
  else if (requestedRoiId === 'nf_number_line') score += 0.28;
  else if (requestedRoiId === 'nf_block') score += 0.18;
  else if (requestedRoiId === 'nf_block_wide') score += 0.1;
  else if (source.regionId === 'roi_nf_number_line') score += 0.18;
  else if (source.regionId === 'roi_nf_block') score += 0.1;

  if (targetRole.indexOf('isolated') >= 0 || targetRole.indexOf('tight') >= 0) score += 0.24;
  else if (targetRole.indexOf('line') >= 0) score += 0.17;
  else if (targetRole.indexOf('digits') >= 0) score += 0.12;
  else if (targetRole.indexOf('context') >= 0) score += 0.08;

  if (source.sourceType === 'nf_roi' || source.sourceType === 'nf_roi_fallback') {
    score += 0.12;
  }

  return score;
};

const DIRECT_PATTERNS = [
  {
    id: 'nf_context_number',
    regex: /\b(?:nf\s*e|nfe|nota fiscal(?: eletronica)?)\b[\s\S]{0,28}?(?:\b(?:numero|n\s*o|nro|no)\b[\s\S]{0,8}?)?(\d{5,8})\b/gi,
  },
  {
    id: 'number_context_nf',
    regex: /\b(?:numero|n\s*o|nro|no)\b[\s\S]{0,8}?(\d{5,8})\b/gi,
    requiresNfeContext: true,
  },
];

const buildCandidate = ({
  nf,
  source,
  evidence,
  method,
  windowText,
  searchableWindowText,
  directPattern = false,
  fuzzyPattern = false,
  fuzzyMeta = null,
}) => {
  const digits = digitsOnly(nf);
  const searchableWindow = String(
    searchableWindowText
    || buildSearchableText(windowText || evidence || ''),
  );
  const nfMarkers = collectRegexMatches(searchableWindow, NF_MARKER_REGEX);
  const numberMarkers = collectRegexMatches(searchableWindow, NUMBER_MARKER_REGEX);
  const digitMatches = collectRegexMatches(searchableWindow, DIGIT_GROUP_REGEX);
  const digitMatch = digitMatches.find((item) => digitsOnly(item.match) === digits) || digitMatches[0] || { index: 0 };
  const context = inferContext(searchableWindow);
  const lineShort = searchableWindow.length <= 44;
  let confidence = (Number(source.confidence || 0) / 100) * 0.22;
  const reasons = [];

  confidence += buildSourceBonus(source);
  if (context.foundNfe) {
    confidence += 0.14;
    reasons.push('contexto_nfe');
  }
  if (context.foundNumeroMarker) {
    confidence += 0.12;
    reasons.push('marcador_numero');
  }
  if (lineShort) {
    confidence += 0.08;
    reasons.push('linha_curta');
  }

  confidence += computeDistanceBonus(digitMatch.index, nfMarkers, 0.14, 0.08);
  confidence += computeDistanceBonus(digitMatch.index, numberMarkers, 0.1, 0.06);

  if (digits.length === 8) confidence += 0.08;
  else if (digits.length === 7) confidence += 0.08;
  else if (digits.length === 6) confidence += 0.04;
  else if (digits.length === 5) confidence += 0.01;
  if (isExpectedNfLength(digits)) {
    confidence += 0.04;
    reasons.push('comprimento_esperado');
  } else {
    confidence -= 0.2;
    reasons.push('comprimento_fora_do_padrao');
  }

  if (directPattern) {
    confidence += 0.12;
    reasons.push('padrao_direto');
  }

  if (fuzzyPattern) {
    confidence -= 0.04;
    reasons.push('sequencia_ocr_fuzzy');
  }

  if (fuzzyMeta && fuzzyMeta.mappedCount) {
    confidence -= Math.min(0.08, fuzzyMeta.mappedCount * 0.02);
  }

  if (fuzzyMeta && fuzzyMeta.droppedCount) {
    confidence -= Math.min(0.06, fuzzyMeta.droppedCount * 0.02);
  }

  if (hasImprobableDigits(digits)) {
    confidence -= 0.25;
    reasons.push('digitos_improvaveis');
  }

  confidence = Number(Math.max(0, Math.min(0.99, confidence)).toFixed(2));

  return {
    nf: digits,
    method,
    sourceId: source.id,
    sourceLabel: source.label,
    sourceType: source.sourceType,
    sourceConfidence: Number(source.confidence || 0),
    regionId: source.regionId,
    targetRole: source.targetRole,
    confidence,
    context,
    evidence: truncateText(evidence || windowText || searchableWindow, 180),
    reasons,
    requestedRoiId: source.meta && source.meta.requestedRoiId ? source.meta.requestedRoiId : null,
    roiId: source.meta && source.meta.roiId ? source.meta.roiId : null,
    sourceVariantId: source.sourceVariantId || (source.meta && source.meta.sourceVariantId) || null,
    transformId: source.meta && source.meta.transformId ? source.meta.transformId : null,
    phase: source.meta && source.meta.phase ? source.meta.phase : null,
  };
};

const extractCandidatesFromTextSource = (source) => {
  const windows = buildLineWindows(source);
  const candidates = [];
  const seen = {};

  windows.forEach(({ rawText, searchableText }) => {
    const windowContext = inferContext(searchableText);

    DIRECT_PATTERNS.forEach((pattern) => {
      if (pattern.requiresNfeContext && !windowContext.foundNfe && source.sourceType.indexOf('nf_roi') < 0) return;

      collectRegexMatches(searchableText, pattern.regex).forEach((match) => {
        const nf = digitsOnly(match.groups[0]);
        if (!isExpectedNfLength(nf)) return;

        const key = `${source.id}:${pattern.id}:${nf}`;
        if (seen[key]) return;
        seen[key] = true;
        candidates.push(buildCandidate({
          nf,
          source,
          evidence: match.match,
          method: pattern.id,
          windowText: rawText,
          searchableWindowText: searchableText,
          directPattern: true,
        }));
      });
    });

    collectRegexMatches(searchableText, DIGIT_GROUP_REGEX).forEach((match) => {
      const nf = digitsOnly(match.match);
      if (!isExpectedNfLength(nf)) return;
      if (!windowContext.foundNfe && !windowContext.foundNumeroMarker && source.sourceType.indexOf('nf_roi') < 0) return;

      const key = `${source.id}:window:${nf}:${match.index}`;
      if (seen[key]) return;
      seen[key] = true;
      candidates.push(buildCandidate({
        nf,
        source,
        evidence: match.match,
        method: 'window_context',
        windowText: rawText,
        searchableWindowText: searchableText,
      }));
    });

    if (windowContext.foundNfe || windowContext.foundNumeroMarker || source.sourceType.indexOf('nf_roi') >= 0) {
      extractFuzzyDigitCandidates(rawText).forEach((match) => {
        const key = `${source.id}:fuzzy:${match.digits}:${match.index}`;
        if (seen[key]) return;
        seen[key] = true;
        candidates.push(buildCandidate({
          nf: match.digits,
          source,
          evidence: match.match,
          method: 'window_context_fuzzy',
          windowText: rawText,
          searchableWindowText: searchableText,
          fuzzyPattern: true,
          fuzzyMeta: {
            mappedCount: match.mappedCount,
            droppedCount: match.droppedCount,
          },
        }));
      });
    }
  });

  return candidates;
};

const aggregateCandidates = (candidates = []) => Object.keys(
  candidates.reduce((accumulator, candidate) => {
    if (!accumulator[candidate.nf]) accumulator[candidate.nf] = [];
    accumulator[candidate.nf].push(candidate);
    return accumulator;
  }, {}),
).map((nf) => {
  const evidence = candidates.filter((candidate) => candidate.nf === nf);
  const uniqueSourceIds = evidence
    .map((item) => item.sourceId)
    .filter((value, index, array) => array.indexOf(value) === index);
  const uniqueRois = evidence
    .map((item) => item.requestedRoiId)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  const uniqueVariants = evidence
    .map((item) => item.sourceVariantId)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  const maxConfidence = evidence.reduce((maxValue, item) => Math.max(maxValue, item.confidence), 0);
  const sourceTypes = evidence
    .map((item) => item.sourceType)
    .filter((value, index, array) => array.indexOf(value) === index);
  const precisionScore = evidence.some((item) => (
    String(item.targetRole || '').indexOf('isolated') >= 0
    || String(item.targetRole || '').indexOf('tight') >= 0
    || String(item.targetRole || '').indexOf('confirm') >= 0
  ))
    ? 1
    : 0;
  const contexts = {
    foundNfe: evidence.some((item) => item.context.foundNfe),
    foundNumeroMarker: evidence.some((item) => item.context.foundNumeroMarker),
  };
  const supportBonus = Math.min(0.15, Math.max(0, uniqueSourceIds.length - 1) * 0.05);
  const roiBonus = Math.min(0.15, Math.max(0, uniqueRois.length - 1) * 0.05);
  const variantBonus = Math.min(0.12, Math.max(0, uniqueVariants.length - 1) * 0.04);
  const supportsPreciseTemplate = uniqueRois.includes('nf_number_tight') || uniqueRois.includes('nf_number_line');
  const strongTightConsensus = (
    uniqueSourceIds.length >= BUSINESS_THRESHOLDS.strongNfConsensusSources
    && uniqueRois.length >= 2
    && uniqueRois.includes('nf_number_tight')
  );
  const strongLineConsensus = (
    uniqueSourceIds.length >= BUSINESS_THRESHOLDS.strongNfConsensusSources
    && uniqueRois.length >= 2
    && uniqueRois.includes('nf_number_line')
  );
  const contextBonus = contexts.foundNfe && contexts.foundNumeroMarker ? 0.06 : contexts.foundNfe ? 0.03 : 0;
  const contextlessPenalty = contexts.foundNfe || contexts.foundNumeroMarker
    ? 0
    : strongTightConsensus || strongLineConsensus
      ? 0
      : supportsPreciseTemplate
      ? 0.05
      : 0.28;
  const lengthPenalty = nf.length <= 6 && !contexts.foundNfe && !contexts.foundNumeroMarker ? 0.06 : 0;
  const preciseTemplateBonus = supportsPreciseTemplate ? 0.08 : 0;
  let confidence = Number(Math.max(0, Math.min(
    0.99,
    maxConfidence
      + supportBonus
      + roiBonus
      + variantBonus
      + contextBonus
      + preciseTemplateBonus
      - contextlessPenalty
      - lengthPenalty,
  )).toFixed(2));
  if (strongTightConsensus) {
    confidence = Math.max(confidence, 0.99);
  } else if (strongLineConsensus) {
    confidence = Math.max(confidence, 0.96);
  }
  const sortedEvidence = evidence.slice().sort((left, right) => right.confidence - left.confidence);
  const bestEvidence = sortedEvidence[0] || null;

  return {
    nf,
    confidence,
    method: bestEvidence ? bestEvidence.method : 'not_found',
    supportCount: uniqueSourceIds.length,
    roiSupportCount: uniqueRois.length,
    variantSupportCount: uniqueVariants.length,
    precisionScore,
    sourceTypes,
    context: contexts,
    decisionReason: bestEvidence ? bestEvidence.reasons.slice() : [],
    supportingTexts: sortedEvidence.map((item) => item.evidence).slice(0, 6),
    supportingRois: uniqueRois,
    supportingVariants: uniqueVariants,
    usedFallback: sortedEvidence.some((item) => item.phase === 'fallback'),
    origin: sourceTypes.some((sourceType) => sourceType.indexOf('nf_roi') >= 0) ? 'roi' : 'support',
    evidence: sortedEvidence,
  };
}).sort((left, right) => {
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    if (right.precisionScore !== left.precisionScore) return right.precisionScore - left.precisionScore;
    if (right.roiSupportCount !== left.roiSupportCount) return right.roiSupportCount - left.roiSupportCount;
    if (right.supportCount !== left.supportCount) return right.supportCount - left.supportCount;
    return String(left.nf).localeCompare(String(right.nf));
  });

const shouldRunFallbackPhase = (validation, candidate) => {
  if (!validation || !validation.canRunNfFallback) return false;
  if (!candidate) return true;
  return Number(candidate.confidence || 0) < BUSINESS_THRESHOLDS.validNfConfidence;
};

const shouldRetryPrimaryPhase = (candidate) => {
  if (!candidate) return true;
  if (Number(candidate.confidence || 0) < BUSINESS_THRESHOLDS.validNfConfidence) return true;
  if (!candidate.context || (!candidate.context.foundNfe && !candidate.context.foundNumeroMarker)) return true;
  return false;
};

const shouldRunPrecisionConfirmation = (candidates = []) => {
  const best = candidates[0] || null;
  if (!best) return true;
  return Number(best.precisionScore || 0) === 0;
};

module.exports = {
  aggregateCandidates,
  extractCandidatesFromTextSource,

  async extractInvoiceNumber(payload = {}) {
    const baseDocuments = buildEvidenceDocuments({
      documents: payload.documents,
      fullOcr: payload.fullOcr,
      regionOcr: payload.regionOcr,
    });
    const fastMode = !!payload.fastMode;
    const canRunRoiOcr = !!(payload.preprocess && payload.orientationProbe);
    const primaryPhase = canRunRoiOcr
      ? await receiptNfOcrService.runNfRoiOcrPhase({
        preprocess: payload.preprocess,
        orientationProbe: payload.orientationProbe,
        phase: 'primary',
        fastMode,
      })
      : {
        attempted: false,
        phase: 'primary',
        totalRois: 0,
        totalTargets: 0,
        rois: [],
        results: [],
      };
    let mergedRoiOcr = canRunRoiOcr
      ? receiptNfOcrService.mergePhaseResults(primaryPhase, null)
      : {
        attempted: false,
        phases: [],
        totalRois: 0,
        totalTargets: 0,
        rois: [],
        results: [],
        bestTargetId: null,
        bestConfidence: null,
      };
    let documents = buildEvidenceDocuments({
      documents: baseDocuments.concat((mergedRoiOcr.results || []).map((result) => ({
        id: result.targetId,
        label: result.label,
        confidence: result.confidence,
        sourceType: result.meta && result.meta.phase === 'fallback' ? 'nf_roi_fallback' : 'nf_roi',
        textRaw: result.textRaw || result.textPreview || '',
        textNormalized: result.textNormalized || result.textRaw || result.textPreview || '',
        filePath: result.filePath,
        meta: result.meta,
      }))),
    });
    let rawCandidates = [];

    documents.forEach((document) => {
      rawCandidates.push.apply(rawCandidates, extractCandidatesFromTextSource(document));
    });

    let candidates = aggregateCandidates(rawCandidates);
    let best = candidates[0] || null;

    if (!fastMode && canRunRoiOcr && shouldRetryPrimaryPhase(best)) {
      const retryPrimaryPhase = await receiptNfOcrService.runNfRoiOcrPhase({
        preprocess: payload.preprocess,
        orientationProbe: payload.orientationProbe,
        phase: 'primary',
        fastMode,
      });
      mergedRoiOcr = receiptNfOcrService.mergePhaseResults(primaryPhase, retryPrimaryPhase);
      documents = buildEvidenceDocuments({
        documents: baseDocuments.concat((mergedRoiOcr.results || []).map((result) => ({
          id: result.targetId,
          label: result.label,
          confidence: result.confidence,
          sourceType: result.meta && result.meta.phase === 'fallback' ? 'nf_roi_fallback' : 'nf_roi',
          textRaw: result.textRaw || result.textPreview || '',
          textNormalized: result.textNormalized || result.textRaw || result.textPreview || '',
          filePath: result.filePath,
          meta: result.meta,
        }))),
      });
      rawCandidates = [];
      documents.forEach((document) => {
        rawCandidates.push.apply(rawCandidates, extractCandidatesFromTextSource(document));
      });
      candidates = aggregateCandidates(rawCandidates);
      best = candidates[0] || null;
    }

    if (!fastMode && canRunRoiOcr && shouldRunPrecisionConfirmation(candidates)) {
      const bestEvidence = best && Array.isArray(best.evidence) ? best.evidence[0] : null;
      const confirmPhase = await receiptNfOcrService.runNfPrecisionConfirmPhase({
        preprocess: payload.preprocess,
        orientationProbe: payload.orientationProbe,
        phase: 'primary',
        sourceVariantIds: bestEvidence && bestEvidence.sourceVariantId
          ? [bestEvidence.sourceVariantId]
          : [],
        fastMode,
      });
      mergedRoiOcr = receiptNfOcrService.mergePhaseResults(mergedRoiOcr, confirmPhase);
      documents = buildEvidenceDocuments({
        documents: baseDocuments.concat((mergedRoiOcr.results || []).map((result) => ({
          id: result.targetId,
          label: result.label,
          confidence: result.confidence,
          sourceType: result.meta && result.meta.phase === 'fallback' ? 'nf_roi_fallback' : 'nf_roi',
          textRaw: result.textRaw || result.textPreview || '',
          textNormalized: result.textNormalized || result.textRaw || result.textPreview || '',
          filePath: result.filePath,
          meta: result.meta,
        }))),
      });
      rawCandidates = [];
      documents.forEach((document) => {
        rawCandidates.push.apply(rawCandidates, extractCandidatesFromTextSource(document));
      });
      candidates = aggregateCandidates(rawCandidates);
      best = candidates[0] || null;
    }

    const shouldRunFallback = fastMode
      ? (!best || !best.nf)
      : shouldRunFallbackPhase(payload.validation, best);

    if (canRunRoiOcr && shouldRunFallback) {
      const fallbackPhase = await receiptNfOcrService.runNfRoiOcrPhase({
        preprocess: payload.preprocess,
        orientationProbe: payload.orientationProbe,
        phase: 'fallback',
        fastMode,
      });
      mergedRoiOcr = receiptNfOcrService.mergePhaseResults(mergedRoiOcr, fallbackPhase);
      documents = buildEvidenceDocuments({
        documents: baseDocuments.concat((mergedRoiOcr.results || []).map((result) => ({
          id: result.targetId,
          label: result.label,
          confidence: result.confidence,
          sourceType: result.meta && result.meta.phase === 'fallback' ? 'nf_roi_fallback' : 'nf_roi',
          textRaw: result.textRaw || result.textPreview || '',
          textNormalized: result.textNormalized || result.textRaw || result.textPreview || '',
          filePath: result.filePath,
          meta: result.meta,
        }))),
      });
      rawCandidates = [];
      documents.forEach((document) => {
        rawCandidates.push.apply(rawCandidates, extractCandidatesFromTextSource(document));
      });
      candidates = aggregateCandidates(rawCandidates);
      best = candidates[0] || null;
    }

    return {
      nf: best ? best.nf : null,
      confidence: best ? best.confidence : 0,
      method: best ? best.method : 'not_found',
      matchedPattern: best ? best.method : null,
      context: best ? best.context : {
        foundNfe: false,
        foundNumeroMarker: false,
      },
      supportCount: best ? best.supportCount : 0,
      roiSupportCount: best ? best.roiSupportCount : 0,
      variantSupportCount: best ? best.variantSupportCount : 0,
      sourceTypes: best ? best.sourceTypes : [],
      sourceRegion: best && best.evidence[0] ? best.evidence[0].requestedRoiId || best.evidence[0].regionId : null,
      sourceRegionId: best && best.evidence[0] ? best.evidence[0].regionId : null,
      rawText: best && best.evidence[0] ? best.evidence[0].evidence : null,
      supportingTexts: best ? best.supportingTexts : [],
      supportingRois: best ? best.supportingRois : [],
      supportingVariants: best ? best.supportingVariants : [],
      decisionReason: best ? best.decisionReason : [],
      origin: best ? best.origin : null,
      usedFallback: best ? best.usedFallback : false,
      candidates,
      roiOcr: mergedRoiOcr,
      regionOcr: {
        attempted: mergedRoiOcr.attempted,
        totalTargets: mergedRoiOcr.totalTargets,
        bestTargetId: best && best.evidence[0] ? best.evidence[0].sourceId : mergedRoiOcr.bestTargetId,
        bestConfidence: best && best.evidence[0] ? best.evidence[0].sourceConfidence : mergedRoiOcr.bestConfidence,
        results: mergedRoiOcr.results || [],
        phases: mergedRoiOcr.phases || [],
      },
    };
  },
};
