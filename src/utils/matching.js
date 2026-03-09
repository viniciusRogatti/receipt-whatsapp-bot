const {
  splitNormalizedLines,
  tokenizeSearchableText,
  toSearchableText,
} = require('./textNormalization');

const levenshteinDistance = (left, right) => {
  const a = String(left || '');
  const b = String(right || '');

  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = [];

  for (let row = 0; row <= b.length; row += 1) {
    matrix[row] = [row];
  }

  for (let column = 0; column <= a.length; column += 1) {
    matrix[0][column] = column;
  }

  for (let row = 1; row <= b.length; row += 1) {
    for (let column = 1; column <= a.length; column += 1) {
      const cost = a[column - 1] === b[row - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
    }
  }

  return matrix[b.length][a.length];
};

const similarity = (left, right) => {
  const a = toSearchableText(left);
  const b = toSearchableText(right);
  const maxLength = Math.max(a.length, b.length);

  if (!maxLength) return 1;
  return Number((1 - (levenshteinDistance(a, b) / maxLength)).toFixed(4));
};

const buildTokenWindows = (tokens, targetTokenCount) => {
  const windows = [];
  const minSize = Math.max(1, targetTokenCount - 1);
  const maxSize = Math.min(tokens.length, targetTokenCount + 2);

  for (let size = minSize; size <= maxSize; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      windows.push(tokens.slice(index, index + size).join(' '));
    }
  }

  return windows;
};

const computeTokenCoverage = (candidate, targetTokens) => {
  const candidateTokens = tokenizeSearchableText(candidate);
  if (!candidateTokens.length || !targetTokens.length) return 0;

  let matchedTokens = 0;

  for (const targetToken of targetTokens) {
    const matched = candidateTokens.some((candidateToken) => (
      candidateToken === targetToken || similarity(candidateToken, targetToken) >= 0.72
    ));

    if (matched) matchedTokens += 1;
  }

  return Number((matchedTokens / targetTokens.length).toFixed(4));
};

const findBestTargetMatch = ({
  rawText,
  targets,
  minConfidence = 0.68,
  fuzzyWeights = null,
}) => {
  const sourceText = String(rawText || '');
  const searchableText = toSearchableText(sourceText);
  const tokenWeight = Number(fuzzyWeights && fuzzyWeights.tokenWeight);
  const stringWeight = Number(fuzzyWeights && fuzzyWeights.stringWeight);
  const normalizedTokenWeight = Number.isFinite(tokenWeight) ? tokenWeight : 0.82;
  const normalizedStringWeight = Number.isFinite(stringWeight) ? stringWeight : 0.18;
  const totalWeight = Math.max(0.01, normalizedTokenWeight + normalizedStringWeight);

  if (!searchableText) {
    return {
      found: false,
      confidence: 0,
      method: 'empty_text',
      matchedTarget: null,
      matchedText: '',
    };
  }

  const normalizedTargets = (targets || []).map((target) => toSearchableText(target)).filter(Boolean);

  for (const target of normalizedTargets) {
    if (searchableText.indexOf(target) >= 0) {
      return {
        found: true,
        confidence: 1,
        method: 'exact_inclusion',
        matchedTarget: target,
        matchedText: target,
      };
    }
  }

  const candidates = [];
  const lines = splitNormalizedLines(sourceText);
  const allTokens = tokenizeSearchableText(sourceText);

  candidates.push(searchableText);
  candidates.push.apply(candidates, lines.map((line) => toSearchableText(line)).filter(Boolean));

  for (const target of normalizedTargets) {
    const targetTokens = tokenizeSearchableText(target);
    candidates.push.apply(candidates, buildTokenWindows(allTokens, targetTokens.length));
  }

  let best = {
    found: false,
    confidence: 0,
    method: 'no_match',
    matchedTarget: null,
    matchedText: '',
  };

  for (const target of normalizedTargets) {
    const targetTokens = tokenizeSearchableText(target);

    for (const candidate of candidates) {
      if (!candidate) continue;
      const fuzzyScore = similarity(candidate, target);
      const tokenCoverage = computeTokenCoverage(candidate, targetTokens);
      const confidence = Number(Math.max(
        fuzzyScore,
        Math.min(
          1,
          (
            (tokenCoverage * normalizedTokenWeight)
            + (fuzzyScore * normalizedStringWeight)
          ) / totalWeight,
        ),
      ).toFixed(4));

      if (confidence > best.confidence) {
        best = {
          found: confidence >= minConfidence,
          confidence,
          method: confidence >= fuzzyScore ? 'token_fuzzy' : 'string_fuzzy',
          matchedTarget: target,
          matchedText: candidate,
        };
      }
    }
  }

  return best;
};

module.exports = {
  computeTokenCoverage,
  findBestTargetMatch,
  levenshteinDistance,
  similarity,
};
