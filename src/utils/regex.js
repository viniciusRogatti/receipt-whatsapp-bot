const env = require('../config/env');
const receiptProfile = require('../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
} = require('../config/receiptProfiles');

const NF_LABEL_FRAGMENT = 'N\\s*F(?:[\\s.\\-_/]*[EEC])?';
const NFE_MARKER_REGEX = new RegExp(`\\b${NF_LABEL_FRAGMENT}\\b|\\bNFE\\b`, 'gi');
const NUMERO_MARKER_REGEX = /\bN[\s.\-_/]*[O0º°]?\s*[:#-]?\s*/gi;
const SERIE_1_REGEX = /\bSER[I1][E3]?\s*[:#-]?\s*1\b/gi;
const EXPECTED_DIGIT_FRAGMENT = (
  (Array.isArray(env.ocrExpectedNfLengths) && env.ocrExpectedNfLengths.length
    ? env.ocrExpectedNfLengths
    : [7]
  )
    .map((size) => `\\d{${size}}`)
    .join('|')
);
const DIGIT_GROUP_REGEX = new RegExp(`\\b(?:${EXPECTED_DIGIT_FRAGMENT})\\b`, 'g');

const REQUIRED_FIELD_TARGETS = {
  [RECEIPT_FIELD_KEYS.dataRecebimento]: receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.dataRecebimento].aliases.slice(),
  [RECEIPT_FIELD_KEYS.issuerHeader]: receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.issuerHeader].aliases.slice(),
  [RECEIPT_FIELD_KEYS.nfe]: receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.nfe].aliases.slice(),
};

const INVOICE_CONTEXT_PATTERNS = [
  {
    id: 'nfe_numero_serie',
    regex: new RegExp(`${NF_LABEL_FRAGMENT}[\\s\\S]{0,80}?N[\\s.\\-_/]*[O0º°]?\\s*[:#-]?\\s*(?<!\\d)((?:${EXPECTED_DIGIT_FRAGMENT}))(?!\\d)[\\s\\S]{0,80}?SER[I1][E3]?\\s*[:#-]?\\s*1`, 'gi'),
    context: {
      foundNfe: true,
      foundNumeroMarker: true,
      foundSerie1: true,
    },
  },
  {
    id: 'numero_serie',
    regex: new RegExp(`N[\\s.\\-_/]*[O0º°]?\\s*[:#-]?\\s*(?<!\\d)((?:${EXPECTED_DIGIT_FRAGMENT}))(?!\\d)[\\s\\S]{0,50}?SER[I1][E3]?\\s*[:#-]?\\s*1`, 'gi'),
    context: {
      foundNfe: false,
      foundNumeroMarker: true,
      foundSerie1: true,
    },
  },
  {
    id: 'nfe_numero',
    regex: new RegExp(`${NF_LABEL_FRAGMENT}[\\s\\S]{0,50}?N[\\s.\\-_/]*[O0º°]?\\s*[:#-]?\\s*(?<!\\d)((?:${EXPECTED_DIGIT_FRAGMENT}))(?!\\d)`, 'gi'),
    context: {
      foundNfe: true,
      foundNumeroMarker: true,
      foundSerie1: false,
    },
  },
];

const toGlobalRegex = (regex) => new RegExp(
  regex.source,
  regex.flags.indexOf('g') >= 0 ? regex.flags : `${regex.flags}g`,
);

const collectRegexMatches = (text, regex) => {
  const sourceText = String(text || '');
  const matches = [];
  const globalRegex = toGlobalRegex(regex);
  let match = globalRegex.exec(sourceText);

  while (match) {
    matches.push({
      match: match[0],
      groups: match.slice(1),
      index: match.index,
    });
    match = globalRegex.exec(sourceText);
  }

  return matches;
};

module.exports = {
  DIGIT_GROUP_REGEX,
  INVOICE_CONTEXT_PATTERNS,
  NFE_MARKER_REGEX,
  NUMERO_MARKER_REGEX,
  REQUIRED_FIELD_TARGETS,
  SERIE_1_REGEX,
  collectRegexMatches,
};
