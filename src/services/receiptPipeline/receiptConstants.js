const RECEIPT_TEMPLATE = {
  id: 'mar_e_rio_receipt_v1',
  label: 'Canhoto padrao MAR E RIO',
  standardWidth: 1800,
  aspectRatio: 8.9,
  minAspectRatio: 5.2,
  maxAspectRatio: 13.5,
  minTemplateScore: 58,
};

const TEMPLATE_ROI_DEFINITIONS = [
  {
    id: 'roi_document_support',
    label: 'Documento alinhado mascarado',
    role: 'document_support',
    box: { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
  },
  {
    id: 'roi_header',
    label: 'Cabecalho RECEBEMOS DE MAR E RIO',
    role: 'header',
    // Texto fixo centralizado na faixa superior do canhoto.
    box: { x: 0.12, y: 0.04, width: 0.71, height: 0.31 },
  },
  {
    id: 'roi_date_label',
    label: 'DATA DE RECEBIMENTO',
    role: 'date_label',
    box: { x: 0.005, y: 0.35, width: 0.17, height: 0.34 },
  },
  {
    id: 'roi_nf_block',
    label: 'Bloco NF-e',
    role: 'nf_block',
    box: { x: 0.84, y: 0.02, width: 0.155, height: 0.92 },
  },
  {
    id: 'roi_nf_header',
    label: 'Topo do bloco NF-e',
    role: 'nf_header',
    box: { x: 0.855, y: 0.03, width: 0.13, height: 0.22 },
  },
  {
    id: 'roi_nf_number_line',
    label: 'Linha do numero da NF-e',
    role: 'nf_number_line',
    box: { x: 0.855, y: 0.22, width: 0.13, height: 0.24 },
  },
  {
    id: 'roi_nf_number_tight',
    label: 'Numero da NF-e apertado',
    role: 'nf_number_tight',
    box: { x: 0.89, y: 0.22, width: 0.1, height: 0.2 },
  },
  {
    id: 'roi_nf_series_line',
    label: 'Linha de serie do bloco NF-e',
    role: 'nf_series',
    box: { x: 0.855, y: 0.47, width: 0.13, height: 0.2 },
  },
  {
    id: 'roi_signature',
    label: 'Area de assinatura e identificacao',
    role: 'signature',
    ignoreForOcr: true,
    box: { x: 0.18, y: 0.35, width: 0.66, height: 0.46 },
  },
];

const ANALYSIS_REGION_DEFINITIONS = [
  {
    id: 'roi_header',
    label: 'Cabecalho RECEBEMOS DE MAR E RIO',
    box: { x: 0.12, y: 0.04, width: 0.71, height: 0.31 },
    fieldKeys: ['recebemosDeMarERio'],
  },
  {
    id: 'roi_date_label',
    label: 'Campo DATA DE RECEBIMENTO',
    box: { x: 0.005, y: 0.35, width: 0.17, height: 0.34 },
    fieldKeys: ['dataRecebimento'],
  },
  {
    id: 'roi_nf_block',
    label: 'Bloco NF-e',
    box: { x: 0.84, y: 0.02, width: 0.155, height: 0.92 },
    fieldKeys: ['nfe'],
  },
  {
    id: 'roi_nf_number_line',
    label: 'Linha do numero da NF',
    box: { x: 0.855, y: 0.22, width: 0.13, height: 0.24 },
    fieldKeys: ['nfe'],
  },
];

const ORIENTATION_PROBE_REGION_DEFINITIONS = [
  {
    id: 'roi_header',
    label: 'Cabecalho RECEBEMOS DE MAR E RIO',
    box: { x: 0.12, y: 0.04, width: 0.71, height: 0.31 },
    fieldKeys: ['recebemosDeMarERio'],
  },
  {
    id: 'roi_date_label',
    label: 'Campo DATA DE RECEBIMENTO',
    box: { x: 0.005, y: 0.35, width: 0.17, height: 0.34 },
    fieldKeys: ['dataRecebimento'],
  },
  {
    id: 'roi_nf_block',
    label: 'Bloco NF-e',
    box: { x: 0.84, y: 0.02, width: 0.155, height: 0.92 },
    fieldKeys: ['nfe'],
  },
];

const FIELD_SPECS = {
  dataRecebimento: {
    key: 'dataRecebimento',
    label: 'DATA DE RECEBIMENTO',
    aliases: [
      'data de recebimento',
      'data recebimento',
      'data do recebimento',
      'dt recebimento',
    ],
    expectedRegionIds: ['roi_date_label', 'roi_document_support', 'global_support'],
    acceptanceThreshold: 0.66,
  },
  recebemosDeMarERio: {
    key: 'recebemosDeMarERio',
    label: 'RECEBEMOS DE MAR E RIO',
    aliases: [
      'recebemos de mar e rio',
      'recebemos da mar e rio',
      'recebemos mar e rio',
      'mar e rio pescados',
      'mar e rio pescados ind imp exp',
      'marerio pescados',
      'recebemos de marerio',
      'recebemos da marerio',
    ],
    expectedRegionIds: ['roi_header', 'roi_document_support', 'global_support'],
    acceptanceThreshold: 0.62,
  },
  nfe: {
    key: 'nfe',
    label: 'NF-e',
    aliases: [
      'nf e',
      'nf-e',
      'nfe',
      'nota fiscal',
      'nota fiscal eletronica',
      'serie',
      'numero',
    ],
    expectedRegionIds: ['roi_nf_block', 'roi_nf_number_line', 'global_support'],
    acceptanceThreshold: 0.68,
  },
};

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

const NF_ROI_DEFINITIONS = [
  {
    id: 'nf_block',
    label: 'Bloco NF-e',
    box: { x: 0.84, y: 0.02, width: 0.155, height: 0.92 },
    phase: 'primary',
    minWidth: 140,
    minHeight: 60,
    fallbackRoiId: 'nf_block_wide',
  },
  {
    id: 'nf_number_line',
    label: 'Linha do numero da NF',
    box: { x: 0.855, y: 0.22, width: 0.13, height: 0.24 },
    phase: 'primary',
    minWidth: 110,
    minHeight: 36,
    fallbackRoiId: 'nf_block',
  },
  {
    id: 'nf_number_tight',
    label: 'Numero da NF apertado',
    box: { x: 0.89, y: 0.22, width: 0.1, height: 0.2 },
    phase: 'primary',
    minWidth: 84,
    minHeight: 28,
    fallbackRoiId: 'nf_number_line',
  },
  {
    id: 'nf_header',
    label: 'Cabecalho do bloco NF-e',
    box: { x: 0.855, y: 0.03, width: 0.13, height: 0.22 },
    phase: 'primary',
    minWidth: 110,
    minHeight: 36,
    fallbackRoiId: 'nf_block',
  },
  {
    id: 'nf_block_wide',
    label: 'Bloco NF-e expandido',
    box: { x: 0.8, y: 0.0, width: 0.2, height: 0.98 },
    phase: 'fallback',
    minWidth: 180,
    minHeight: 60,
    fallbackRoiId: null,
  },
];

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
