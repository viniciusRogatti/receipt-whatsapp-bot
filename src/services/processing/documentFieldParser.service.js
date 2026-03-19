const { findBestTargetMatch } = require('../../utils/matching');
const { splitNormalizedLines, toSearchableText } = require('../../utils/textNormalization');
const { EXTRACTION_FIELD_KEYS } = require('../../config/profiles');
const receiptProfile = require('../../config/receiptProfile');

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));
const INVOICE_REGION_IDS = ['roi_nf_header', 'roi_nf_number_line', 'roi_nf_block'];
const TEMPLATE_REGION_MAP = (receiptProfile.templateRoiDefinitions || []).reduce((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {});
const INVOICE_REGION_BOXES = INVOICE_REGION_IDS
  .map((regionId) => TEMPLATE_REGION_MAP[regionId])
  .filter(Boolean)
  .map((region) => region.box);

const normalizeConfidence = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clamp01(fallback);
  if (numeric > 1) return clamp01(numeric / 100);
  return clamp01(numeric);
};

const toBoundingVertices = (boundingPoly) => {
  if (!boundingPoly) return [];
  if (Array.isArray(boundingPoly.vertices)) return boundingPoly.vertices;
  if (Array.isArray(boundingPoly.normalizedVertices)) return boundingPoly.normalizedVertices;
  if (Array.isArray(boundingPoly)) return boundingPoly;
  return [];
};

const buildBoundingBox = (boundingPoly) => {
  const vertices = toBoundingVertices(boundingPoly)
    .map((vertex) => ({
      x: Number(vertex && vertex.x),
      y: Number(vertex && vertex.y),
    }))
    .filter((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));

  if (!vertices.length) return null;

  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
};

const resolvePageMetrics = (ocrDocument = {}, lines = []) => {
  const explicitWidth = Number(ocrDocument.pageWidth || 0);
  const explicitHeight = Number(ocrDocument.pageHeight || 0);

  if (explicitWidth > 0 && explicitHeight > 0) {
    return {
      width: explicitWidth,
      height: explicitHeight,
    };
  }

  const boxes = lines
    .map((line) => line.boundingBox)
    .filter(Boolean);
  const inferredWidth = boxes.reduce((maxValue, box) => Math.max(maxValue, Number(box.x || 0) + Number(box.width || 0)), 0);
  const inferredHeight = boxes.reduce((maxValue, box) => Math.max(maxValue, Number(box.y || 0) + Number(box.height || 0)), 0);

  return {
    width: inferredWidth > 0 ? inferredWidth : 1,
    height: inferredHeight > 0 ? inferredHeight : 1,
  };
};

const normalizeBox = (box, pageMetrics) => {
  if (!box || !pageMetrics.width || !pageMetrics.height) return null;

  return {
    x: clamp01(Number(box.x || 0) / pageMetrics.width),
    y: clamp01(Number(box.y || 0) / pageMetrics.height),
    width: clamp01(Number(box.width || 0) / pageMetrics.width),
    height: clamp01(Number(box.height || 0) / pageMetrics.height),
  };
};

const expandNormalizedBox = (box, paddingX = 0.02, paddingY = 0.03) => ({
  x: Math.max(0, box.x - paddingX),
  y: Math.max(0, box.y - paddingY),
  width: Math.min(1, box.width + (paddingX * 2)),
  height: Math.min(1, box.height + (paddingY * 2)),
});

const computeAxisOverlap = (startA, endA, startB, endB) => {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  return Math.max(0, end - start);
};

const computeIntersectionRatio = (left, right) => {
  if (!left || !right) return 0;

  const intersectionWidth = computeAxisOverlap(left.x, left.x + left.width, right.x, right.x + right.width);
  const intersectionHeight = computeAxisOverlap(left.y, left.y + left.height, right.y, right.y + right.height);
  const intersectionArea = intersectionWidth * intersectionHeight;
  const leftArea = Math.max(0.0001, left.width * left.height);

  return clamp01(intersectionArea / leftArea);
};

const computeInvoiceRegionScore = (line, pageMetrics) => {
  if (!line || !line.boundingBox) return 0;

  const normalizedLineBox = normalizeBox(line.boundingBox, pageMetrics);
  if (!normalizedLineBox) return 0;

  const centerX = normalizedLineBox.x + (normalizedLineBox.width / 2);
  const centerY = normalizedLineBox.y + (normalizedLineBox.height / 2);

  return INVOICE_REGION_BOXES.reduce((bestScore, regionBox) => {
    const expandedRegion = expandNormalizedBox(regionBox);
    const overlapScore = computeIntersectionRatio(normalizedLineBox, expandedRegion);
    const centerInside = (
      centerX >= expandedRegion.x
      && centerX <= expandedRegion.x + expandedRegion.width
      && centerY >= expandedRegion.y
      && centerY <= expandedRegion.y + expandedRegion.height
    );

    return Math.max(bestScore, centerInside ? Math.max(overlapScore, 0.72) : overlapScore);
  }, 0);
};

const computeNearbyAliasConfidence = ({
  line,
  lines,
  fieldDefinition,
  pageMetrics,
}) => {
  if (!line || !line.boundingBox) return 0;

  const aliases = Array.isArray(fieldDefinition.aliases) ? fieldDefinition.aliases : [];
  if (!aliases.length) return 0;

  const normalizedLineBox = normalizeBox(line.boundingBox, pageMetrics);
  if (!normalizedLineBox) return 0;

  return lines.reduce((bestConfidence, otherLine) => {
    if (!otherLine || otherLine === line || !otherLine.boundingBox || !otherLine.text) return bestConfidence;

    const otherNormalizedBox = normalizeBox(otherLine.boundingBox, pageMetrics);
    if (!otherNormalizedBox) return bestConfidence;

    const verticalGap = Math.abs(otherNormalizedBox.y - normalizedLineBox.y);
    const horizontalOverlap = computeAxisOverlap(
      normalizedLineBox.x,
      normalizedLineBox.x + normalizedLineBox.width,
      otherNormalizedBox.x,
      otherNormalizedBox.x + otherNormalizedBox.width,
    );
    const horizontalCoverage = horizontalOverlap / Math.max(
      0.0001,
      Math.min(normalizedLineBox.width, otherNormalizedBox.width),
    );

    if (verticalGap > 0.18 || horizontalCoverage < 0.35) {
      return bestConfidence;
    }

    const match = findBestTargetMatch({
      rawText: otherLine.text,
      targets: aliases,
      minConfidence: 0,
    });

    return Math.max(bestConfidence, clamp01(match.confidence));
  }, 0);
};

const buildPatternCandidates = ({ text, patterns = [] }) => patterns.flatMap((pattern) => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return Array.from(String(text || '').matchAll(matcher))
    .map((match) => String(match && match[0] ? match[0] : '').trim())
    .filter(Boolean);
});

const collectLines = (ocrDocument = {}) => {
  if (Array.isArray(ocrDocument.lines) && ocrDocument.lines.length) {
    return ocrDocument.lines.map((line) => ({
      text: String(line.text || '').trim(),
      confidence: normalizeConfidence(line.confidence, ocrDocument.baseConfidence),
      boundingPoly: line.boundingPoly || null,
      boundingBox: buildBoundingBox(line.boundingPoly || null),
    })).filter((line) => line.text);
  }

  return splitNormalizedLines(ocrDocument.fullText || '').map((line) => ({
    text: line,
    confidence: normalizeConfidence(ocrDocument.baseConfidence, 0.45),
    boundingPoly: null,
    boundingBox: null,
  }));
};

const runRegexExtraction = ({
  fieldKey,
  lines,
  fullText,
  fieldDefinition,
  providerConfidence,
  pageMetrics,
}) => {
  const patterns = Array.isArray(fieldDefinition.valuePatterns) ? fieldDefinition.valuePatterns : [];
  const aliases = Array.isArray(fieldDefinition.aliases) ? fieldDefinition.aliases : [];
  const candidates = [];
  const isInvoiceField = fieldKey === EXTRACTION_FIELD_KEYS.invoiceNumber;

  const evaluateCandidate = (text, source, lineConfidence, line = null) => {
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

    const rawValues = buildPatternCandidates({
      text,
      patterns,
    });

    rawValues.forEach((rawValue) => {
      const contextualAliasConfidence = isInvoiceField
        ? Math.max(
          clamp01(aliasMatch.confidence),
          computeNearbyAliasConfidence({
            line,
            lines,
            fieldDefinition,
            pageMetrics,
          }),
        )
        : clamp01(aliasMatch.confidence);
      const invoiceRegionScore = isInvoiceField
        ? computeInvoiceRegionScore(line, pageMetrics)
        : 0;

      let confidence = clamp01(
        (normalizeConfidence(lineConfidence, providerConfidence) * (isInvoiceField ? 0.46 : 0.58))
        + (normalizeConfidence(providerConfidence, 0.45) * (isInvoiceField ? 0.14 : 0.22))
        + (contextualAliasConfidence * (isInvoiceField ? 0.22 : 0.2))
        + (invoiceRegionScore * (isInvoiceField ? 0.18 : 0)),
      );

      if (isInvoiceField && source === 'document') {
        confidence *= contextualAliasConfidence >= 0.45 ? 0.55 : 0.28;
      } else if (isInvoiceField && invoiceRegionScore < 0.08 && contextualAliasConfidence < 0.3) {
        confidence *= 0.52;
      } else if (isInvoiceField && (invoiceRegionScore >= 0.2 || contextualAliasConfidence >= 0.6)) {
        confidence = clamp01(confidence + 0.08);
      }

      candidates.push({
        value: rawValue,
        confidence: Number(confidence.toFixed(2)),
        source,
        matchedAlias: aliasMatch.matchedTarget || null,
        invoiceRegionScore: Number(invoiceRegionScore.toFixed(2)),
        contextualAliasConfidence: Number(contextualAliasConfidence.toFixed(2)),
      });
    });
  };

  lines.forEach((line) => evaluateCandidate(line.text, 'line', line.confidence, line));

  if (!isInvoiceField || !candidates.length) {
    evaluateCandidate(fullText, 'document', providerConfidence, null);
  }

  const relevantCandidates = isInvoiceField && candidates.some((candidate) => candidate.source === 'line')
    ? candidates.filter((candidate) => candidate.source === 'line')
    : candidates;
  const best = relevantCandidates
    .slice()
    .sort((left, right) => {
      if (Number(right.confidence || 0) !== Number(left.confidence || 0)) {
        return Number(right.confidence || 0) - Number(left.confidence || 0);
      }

      if (Number(right.invoiceRegionScore || 0) !== Number(left.invoiceRegionScore || 0)) {
        return Number(right.invoiceRegionScore || 0) - Number(left.invoiceRegionScore || 0);
      }

      return Number(right.contextualAliasConfidence || 0) - Number(left.contextualAliasConfidence || 0);
    })[0] || null;

  return {
    value: best ? best.value : null,
    confidence: best ? best.confidence : 0,
    source: best ? best.source : 'none',
    matchedAlias: best ? best.matchedAlias : null,
    found: !!(best && best.value),
  };
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
  pageMetrics,
}) => {
  const extraction = runRegexExtraction({
    fieldKey,
    lines,
    fullText,
    fieldDefinition,
    providerConfidence,
    pageMetrics,
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
    const pageMetrics = resolvePageMetrics(ocrDocument, lines);
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
      pageMetrics,
    });
    fields[EXTRACTION_FIELD_KEYS.receiptDate] = buildValueField({
      fieldKey: EXTRACTION_FIELD_KEYS.receiptDate,
      fieldDefinition: fieldDefinitions[EXTRACTION_FIELD_KEYS.receiptDate],
      lines,
      fullText,
      providerConfidence,
      hints: hints[EXTRACTION_FIELD_KEYS.receiptDate] || {},
      pageMetrics,
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
