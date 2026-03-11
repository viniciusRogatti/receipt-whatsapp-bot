const marERioProfile = require('./profiles/mar_e_rio.profile');
const {
  RECEIPT_FIELD_KEYS,
  REQUIRED_FIELD_ORDER,
} = require('./shared');

const RECEIPT_PROFILES = {
  [marERioProfile.id]: marERioProfile,
};

const DEFAULT_RECEIPT_PROFILE_ID = marERioProfile.id;

const getReceiptProfileById = (profileId) => {
  const normalizedId = String(profileId || '').trim();
  return RECEIPT_PROFILES[normalizedId] || null;
};

module.exports = {
  DEFAULT_RECEIPT_PROFILE_ID,
  RECEIPT_FIELD_KEYS,
  RECEIPT_PROFILES,
  REQUIRED_FIELD_ORDER,
  getReceiptProfileById,
};
