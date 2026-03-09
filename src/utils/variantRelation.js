const toUniqueList = (items = []) => items.filter((item, index) => item && items.indexOf(item) === index);

const getDocumentFocusVariantId = (variantId) => {
  const normalized = String(variantId || '').trim();
  if (!normalized) return null;
  if (normalized.includes('document_focus')) return normalized;
  if (normalized.startsWith('rotate_left_')) return 'rotate_left_document_focus';
  if (normalized.startsWith('rotate_right_')) return 'rotate_right_document_focus';
  return 'document_focus_grayscale';
};

const expandVariantIdsForDocumentFocus = ({ variantIds = [], availableVariantIds = [] }) => {
  const available = new Set(availableVariantIds || []);
  const expanded = [];

  const pushIfAvailable = (variantId) => {
    if (!variantId || !available.has(variantId) || expanded.includes(variantId)) return;
    expanded.push(variantId);
  };

  toUniqueList(variantIds).forEach((variantId) => {
    pushIfAvailable(variantId);
    pushIfAvailable(getDocumentFocusVariantId(variantId));
  });

  return expanded;
};

module.exports = {
  expandVariantIdsForDocumentFocus,
  getDocumentFocusVariantId,
};
