const receiptProfile = require('../../config/receiptProfile');

const RECEIPT_TEMPLATE = receiptProfile.template;
const TEMPLATE_ROI_DEFINITIONS = receiptProfile.templateRoiDefinitions;
const ANALYSIS_REGION_DEFINITIONS = receiptProfile.analysisRegionDefinitions;
const ORIENTATION_PROBE_REGION_DEFINITIONS = receiptProfile.orientationProbeRegionDefinitions;
const FIELD_SPECS = receiptProfile.fieldSpecs;

const ORIENTATION_PRIMARY_PROBE_PLAN = [
  {
    id: 'orientation_header',
    sourceProfileId: 'document_gray',
    regionId: 'roi_header',
    roiProfileId: 'label_gray_2x',
    sourceType: 'orientation_probe',
    targetRole: 'orientation_header',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
  {
    id: 'orientation_date',
    sourceProfileId: 'document_gray',
    regionId: 'roi_date_label',
    roiProfileId: 'label_gray_2x',
    sourceType: 'orientation_probe',
    targetRole: 'orientation_date',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
  {
    id: 'orientation_nf_block',
    sourceProfileId: 'document_binary',
    regionId: 'roi_nf_block',
    roiProfileId: 'nf_context_adaptive_3x',
    sourceType: 'orientation_probe',
    targetRole: 'orientation_nf_block',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'orientation_nf_block_clean',
    sourceProfileId: 'document_ink_clean',
    regionId: 'roi_nf_block',
    roiProfileId: 'nf_context_gray_2x',
    sourceType: 'orientation_probe',
    targetRole: 'orientation_nf_block_clean',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
];

const ORIENTATION_SECONDARY_PROBE_PLAN = [
  {
    id: 'orientation_nf_number',
    sourceProfileId: 'document_gray',
    regionId: 'roi_nf_number_line',
    roiProfileId: 'nf_digits_threshold_4x',
    sourceType: 'orientation_probe_secondary',
    targetRole: 'orientation_nf_number',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
];

const GLOBAL_OCR_PLAN = [
  {
    id: 'global_support',
    sourceProfileId: 'document_gray',
    sourceType: 'variant_full',
    targetRole: 'global_support',
    parameters: {
      tessedit_pageseg_mode: '11',
    },
  },
];

const REGION_OCR_PLAN = [
  {
    id: 'header_gray',
    sourceProfileId: 'document_gray',
    regionId: 'roi_header',
    roiProfileId: 'label_gray_2x',
    sourceType: 'field_region',
    targetRole: 'field_header',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
  {
    id: 'date_gray',
    sourceProfileId: 'document_gray',
    regionId: 'roi_date_label',
    roiProfileId: 'label_gray_2x',
    sourceType: 'field_region',
    targetRole: 'field_date_label',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
  {
    id: 'date_adaptive',
    sourceProfileId: 'document_gray',
    regionId: 'roi_date_label',
    roiProfileId: 'label_adaptive_3x',
    sourceType: 'field_region',
    targetRole: 'field_date_label_adaptive',
    parameters: {
      tessedit_pageseg_mode: '7',
    },
  },
  {
    id: 'nf_block_gray',
    sourceProfileId: 'document_gray',
    regionId: 'roi_nf_block',
    roiProfileId: 'nf_context_gray_2x',
    sourceType: 'field_region',
    targetRole: 'field_nf_block',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'nf_block_adaptive',
    sourceProfileId: 'document_binary',
    regionId: 'roi_nf_block',
    roiProfileId: 'nf_context_adaptive_3x',
    sourceType: 'field_region',
    targetRole: 'field_nf_block_adaptive',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
];

const NF_ROI_DEFINITIONS = receiptProfile.nfRoiDefinitions;

const NF_ROI_PRIMARY_PLAN = [
  {
    id: 'nf_block_context_gray',
    roiIds: ['nf_block'],
    roiProfileId: 'nf_context_gray_2x',
    sourceType: 'nf_roi',
    targetRole: 'nf_block_context',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'nf_block_context_low_gray',
    roiIds: ['nf_block'],
    roiProfileId: 'nf_context_gray_2x',
    sourceType: 'nf_roi',
    targetRole: 'nf_block_context_low',
    cropBox: { x: 0.0, y: 0.18, width: 1.0, height: 0.82 },
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'nf_block_context_adaptive',
    roiIds: ['nf_block', 'nf_number_line'],
    roiProfileId: 'nf_context_adaptive_3x',
    sourceType: 'nf_roi',
    targetRole: 'nf_block_context_adaptive',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'nf_number_line',
    roiIds: ['nf_number_line', 'nf_number_tight'],
    roiProfileId: 'nf_digits_line_3x',
    sourceType: 'nf_roi',
    targetRole: 'nf_digits_line',
    parameters: {
      tessedit_pageseg_mode: '7',
      classify_bln_numeric_mode: '1',
    },
  },
  {
    id: 'nf_number_isolated',
    roiIds: ['nf_number_tight'],
    roiProfileId: 'nf_digits_threshold_4x',
    sourceType: 'nf_roi',
    targetRole: 'nf_digits_isolated',
    parameters: {
      tessedit_pageseg_mode: '8',
      tessedit_char_whitelist: '0123456789',
      classify_bln_numeric_mode: '1',
    },
  },
];

const NF_ROI_FALLBACK_PLAN = [
  {
    id: 'nf_block_wide_context',
    roiIds: ['nf_block_wide', 'nf_block'],
    roiProfileId: 'nf_context_adaptive_3x',
    sourceType: 'nf_roi_fallback',
    targetRole: 'nf_block_wide_context',
    parameters: {
      tessedit_pageseg_mode: '6',
    },
  },
  {
    id: 'nf_number_line_fallback',
    roiIds: ['nf_number_line', 'nf_block_wide'],
    roiProfileId: 'nf_digits_line_3x',
    sourceType: 'nf_roi_fallback',
    targetRole: 'nf_digits_line_fallback',
    parameters: {
      tessedit_pageseg_mode: '7',
      classify_bln_numeric_mode: '1',
    },
  },
  {
    id: 'nf_number_isolated_fallback',
    roiIds: ['nf_number_tight', 'nf_number_line'],
    roiProfileId: 'nf_digits_threshold_4x',
    sourceType: 'nf_roi_fallback',
    targetRole: 'nf_digits_isolated_fallback',
    parameters: {
      tessedit_pageseg_mode: '8',
      tessedit_char_whitelist: '0123456789',
      classify_bln_numeric_mode: '1',
    },
  },
];

const NF_ROI_CONFIRM_PLAN = [
  {
    id: 'nf_number_line_confirm',
    roiIds: ['nf_number_line'],
    roiProfileId: 'nf_digits_line_3x',
    sourceType: 'nf_roi',
    targetRole: 'nf_digits_line_confirm',
    parameters: {
      tessedit_pageseg_mode: '7',
      classify_bln_numeric_mode: '1',
    },
  },
  {
    id: 'nf_number_isolated_confirm',
    roiIds: ['nf_number_tight'],
    roiProfileId: 'nf_digits_threshold_4x',
    sourceType: 'nf_roi',
    targetRole: 'nf_digits_isolated_confirm',
    parameters: {
      tessedit_pageseg_mode: '8',
      tessedit_char_whitelist: '0123456789',
      classify_bln_numeric_mode: '1',
    },
  },
];

const BUSINESS_THRESHOLDS = {
  validScore: 74,
  reviewScore: 46,
  validNfConfidence: 0.82,
  reviewNfConfidence: 0.58,
  fallbackFieldConfidence: 0.72,
  orientationRetryScore: 62,
  orientationTieGap: 6,
  minTemplateGeometryScore: 0.5,
  minAcceptedTemplateScore: 58,
  hardRejectGeometryScore: 0.4,
  strongNfConsensusSources: 3,
};

const REGION_DEFINITION_MAP = ANALYSIS_REGION_DEFINITIONS
  .concat(ORIENTATION_PROBE_REGION_DEFINITIONS)
  .concat(TEMPLATE_ROI_DEFINITIONS)
  .reduce((accumulator, definition) => {
    accumulator[definition.id] = definition;
    return accumulator;
  }, {});

module.exports = {
  ANALYSIS_REGION_DEFINITIONS,
  BUSINESS_THRESHOLDS,
  FIELD_SPECS,
  GLOBAL_OCR_PLAN,
  NF_ROI_CONFIRM_PLAN,
  NF_ROI_DEFINITIONS,
  NF_ROI_FALLBACK_PLAN,
  NF_ROI_PRIMARY_PLAN,
  ORIENTATION_PRIMARY_PROBE_PLAN,
  ORIENTATION_PROBE_REGION_DEFINITIONS,
  ORIENTATION_SECONDARY_PROBE_PLAN,
  RECEIPT_TEMPLATE,
  REGION_DEFINITION_MAP,
  REGION_OCR_PLAN,
  TEMPLATE_ROI_DEFINITIONS,
};
