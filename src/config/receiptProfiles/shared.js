const RECEIPT_FIELD_KEYS = {
  dataRecebimento: 'dataRecebimento',
  issuerHeader: 'issuerHeader',
  nfe: 'nfe',
};

const REQUIRED_FIELD_ORDER = [
  RECEIPT_FIELD_KEYS.dataRecebimento,
  RECEIPT_FIELD_KEYS.issuerHeader,
  RECEIPT_FIELD_KEYS.nfe,
];

module.exports = {
  RECEIPT_FIELD_KEYS,
  REQUIRED_FIELD_ORDER,
};
