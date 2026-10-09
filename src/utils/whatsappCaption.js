// A legenda precisa ser pesquisável no grupo exatamente pelo número da NF.
const parseWhatsappCaption = (value) => {
  const text = String(value || '').trim();
  if (/^\d{1,9}$/.test(text)) return { valid: true, invoiceNumber: text.replace(/^0+(?=\d)/, '') };
  const malformedNumber = /^[\d\s.,/\\-]+$/.test(text) && /\d/.test(text);
  return { valid: false, malformedNumber, invoiceNumber: null };
};
module.exports = { parseWhatsappCaption };
