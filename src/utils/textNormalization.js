const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const stripAccents = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

const normalizeOcrNoise = (value) => normalizeWhitespace(String(value || '')
  .replace(/[“”]/g, '"')
  .replace(/[‘’`´]/g, '\'')
  .replace(/[–—]/g, '-')
  .replace(/[\[\]{}]/g, '1')
  .replace(/[|¦]/g, 'I')
  .replace(/[•·]/g, '.')
  .replace(/[º°]/g, 'o'));

const toSearchableText = (value) => stripAccents(normalizeOcrNoise(value))
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const toUpperSearchableText = (value) => toSearchableText(value).toUpperCase();

const splitNormalizedLines = (value) => String(value || '')
  .split(/\r?\n/)
  .map((line) => normalizeOcrNoise(line))
  .filter(Boolean);

const tokenizeSearchableText = (value) => toSearchableText(value)
  .split(' ')
  .filter(Boolean);

const digitsOnly = (value) => String(value || '').replace(/\D+/g, '');

const truncateText = (value, maxLength = 240) => {
  const normalized = normalizeOcrNoise(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}...`;
};

module.exports = {
  digitsOnly,
  normalizeOcrNoise,
  normalizeWhitespace,
  stripAccents,
  splitNormalizedLines,
  tokenizeSearchableText,
  toUpperSearchableText,
  truncateText,
  toSearchableText,
};
