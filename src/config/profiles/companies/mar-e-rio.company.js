const {
  DOCUMENT_TYPES,
  PROCESSING_ENGINE_IDS,
  SOURCE_IDS,
} = require('../shared');

module.exports = {
  id: 'mar-e-rio',
  code: 'mar_e_rio',
  displayName: 'MAR E RIO',
  enabledSources: [
    SOURCE_IDS.whatsapp,
    SOURCE_IDS.api,
    SOURCE_IDS.manualUpload,
    SOURCE_IDS.webPanel,
    SOURCE_IDS.mobileApp,
  ],
  defaultDocumentType: DOCUMENT_TYPES.deliveryReceipt,
  documentBindings: {
    [DOCUMENT_TYPES.deliveryReceipt]: {
      documentProfileId: DOCUMENT_TYPES.deliveryReceipt,
      legacyReceiptProfileId: 'mar_e_rio',
      invoiceLookup: {
        companyCode: 'mar_e_rio',
      },
      extractionStrategy: {
        primaryProvider: PROCESSING_ENGINE_IDS.googleVision,
        fallbackProviders: [PROCESSING_ENGINE_IDS.openAiRescue],
        migrationProviders: [PROCESSING_ENGINE_IDS.legacyReceiptAnalysis],
        allowLegacyOnFailure: true,
      },
      fieldOverrides: {
        issuerHeader: {
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
        },
      },
      validationOverrides: {
        allowApproveWithoutHeader: false,
      },
      operationalResponseOverrides: {
        invalid: 'A imagem nao trouxe DATA DE RECEBIMENTO, RECEBEMOS DE MAR E RIO e NF-e visiveis.',
      },
    },
  },
  operationalPolicy: {
    autoReplySources: [SOURCE_IDS.whatsapp],
    reviewQueue: 'ops_receipt_review',
  },
};
