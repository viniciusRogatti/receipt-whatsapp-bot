const { findBestTargetMatch } = require('../../utils/matching');
const { splitNormalizedLines, toSearchableText } = require('../../utils/textNormalization');
const { EXTRACTION_FIELD_KEYS } = require('../../config/profiles');

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));

const normalizeConfidence = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clamp01(fallback);
  if (numeric > 1) return clamp01(numeric / 100);
  return clamp01(numeric);
};

const collectLines = (ocrDocument = {}) => {
  if (Array.isArray(ocrDocument.lines) && ocrDocument.lines.length) {
    return ocrDocument.lines.map((line) => ({
      text: String(line.text || '').trim(),
      confidence: normalizeConfidence(line.confidence, ocrDocument.baseConfidence),
      boundingPoly: line.boundingPoly || null,
    })).filter((line) => line.text);
  }

  return splitNormalizedLines(ocrDocument.fullText || '').map((line) => ({
    text: line,
    confidence: normalizeConfidence(ocrDocument.baseConfidence, 0.45),
    boundingPoly: null,
  }));
};

const runRegexExtraction = ({ lines, fullText, fieldDefinition, providerConfidence }) => {
  const patterns = Array.isArray(fieldDefinition.valuePatterns) ? fieldDefinition.valuePatterns : [];
  const aliases = Array.isArray(fieldDefinition.aliases) ? fieldDefinition.aliases : [];
  let best = {
    value: null,
    confidence: 0,
    source: 'none',
    matchedAlias: null,
  };

  const evaluateCandidate = (text, source, lineConfidence) => {
    const aliasMatch = aliases.length
      ? findBestTargetMatch({
        rawText: text,
        targets: aliases,
        minConfidence: 0,
      })
      : {
        confidence: 0,
        matchedTarget: null,
      };

    patterns.forEach((pattern) => {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const matcher = new RegExp(pattern.source, flags);
      const matches = Array.from(String(text || '').matchAll(matcher));

      matches.forEach((match) => {
        const rawValue = String(match && match[0] ? match[0] : '').trim();
        if (!rawValue) return;

        const confidence = clamp01(
          (normalizeConfidence(lineConfidence, providerConfidence) * 0.58)
          + (normalizeConfidence(providerConfidence, 0.45) * 0.22)
          + (clamp01(aliasMatch.confidence) * 0.2),
        );

        if (confidence > best.confidence) {
          best = {
            value: rawValue,
            confidence: Number(confidence.toFixed(2)),
            source,
            matchedAlias: aliasMatch.matchedTarget || null,
          };
        }
      });
    });
  };

  lines.forEach((line) => evaluateCandidate(line.text, 'line', line.confidence));
  evaluateCandidate(fullText, 'document', providerConfidence);

  return Object.assign({}, best, {
    found: !!best.value,
  });
};

const buildHeaderField = ({ fullText, fieldDefinition, providerConfidence, hints = {} }) => {
  const aliases = Array.isArray(fieldDefinition.aliases) ? fieldDefinition.aliases : [];
  const match = aliases.length
    ? findBestTargetMatch({
      rawText: fullText,
      targets: aliases,
      minConfidence: 0,
    })
    : {
      confidence: 0,
      matchedText: '',
      matchedTarget: null,
    };

  const hinted = !!hints.headerDetected;
  const confidence = Math.max(
    clamp01((clamp01(match.confidence) * 0.78) + (normalizeConfidence(providerConfidence, 0.4) * 0.22)),
    hinted ? 0.68 : 0,
  );

  return {
    key: EXTRACTION_FIELD_KEYS.issuerHeader,
    label: fieldDefinition.label,
    found: confidence >= 0.62,
    value: hinted
      ? String(hints.headerValue || match.matchedText || fieldDefinition.label || '').trim() || null
      : (match.matchedText || null),
    confidence: Number(confidence.toFixed(2)),
    source: hinted ? 'hint' : 'ocr_alias',
  };
};

const buildValueField = ({
  fieldKey,
  fieldDefinition,
  lines,
  fullText,
  providerConfidence,
  hints = {},
}) => {
  const extraction = runRegexExtraction({
    lines,
    fullText,
    fieldDefinition,
    providerConfidence,
  });
  const hintedValue = hints.value ? String(hints.value).trim() : null;
  const hintedConfidence = normalizeConfidence(hints.confidence, 0.65);
  const hasHint = !!hintedValue || !!hints.detected;

  let value = extraction.value;
  let confidence = extraction.confidence;
  let source = extraction.source;
  let found = extraction.found;

  if (hasHint && (!found || hintedConfidence >= confidence)) {
    value = hintedValue || value;
    confidence = Math.max(confidence, hintedConfidence);
    source = 'hint';
    found = !!(value || hints.detected);
  }

  return {
    key: fieldKey,
    label: fieldDefinition.label,
    found,
    value: value || null,
    confidence: Number(clamp01(confidence).toFixed(2)),
    source,
  };
};

module.exports = {
  parseStructuredDocument({
    ocrDocument = {},
    documentProfile,
    providerId,
  }) {
    const fieldDefinitions = documentProfile.fieldDefinitions || {};
    const providerConfidence = normalizeConfidence(
      ocrDocument.providerConfidence,
      ocrDocument.baseConfidence,
    );
    const lines = collectLines(ocrDocument);
    const fullText = String(ocrDocument.fullText || '').trim();
    const hints = ocrDocument.hints || {};

    const fields = {};
    fields[EXTRACTION_FIELD_KEYS.invoiceNumber] = buildValueField({
      fieldKey: EXTRACTION_FIELD_KEYS.invoiceNumber,
      fieldDefinition: fieldDefinitions[EXTRACTION_FIELD_KEYS.invoiceNumber],
      lines,
      fullText,
      providerConfidence,
      hints: hints[EXTRACTION_FIELD_KEYS.invoiceNumber] || {},
    });
    fields[EXTRACTION_FIELD_KEYS.receiptDate] = buildValueField({
      fieldKey: EXTRACTION_FIELD_KEYS.receiptDate,
      fieldDefinition: fieldDefinitions[EXTRACTION_FIELD_KEYS.receiptDate],
      lines,
      fullText,
      providerConfidence,
      hints: hints[EXTRACTION_FIELD_KEYS.receiptDate] || {},
    });
    fields[EXTRACTION_FIELD_KEYS.issuerHeader] = buildHeaderField({
      fullText,
      fieldDefinition: fieldDefinitions[EXTRACTION_FIELD_KEYS.issuerHeader],
      providerConfidence,
      hints: hints[EXTRACTION_FIELD_KEYS.issuerHeader] || {},
    });

    const fieldValues = Object.values(fields);
    const foundFields = fieldValues.filter((field) => field.found);
    const averageConfidence = foundFields.length
      ? Number((foundFields.reduce((sum, field) => sum + Number(field.confidence || 0), 0) / foundFields.length).toFixed(2))
      : 0;

    return {
      providerId,
      fullText,
      lines,
      fields,
      summary: {
        foundFieldCount: foundFields.length,
        missingFieldKeys: fieldValues.filter((field) => !field.found).map((field) => field.key),
        averageConfidence,
      },
      raw: ocrDocument.raw || null,
    };
  },
};
