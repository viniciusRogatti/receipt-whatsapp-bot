const {
  EXTRACTION_FIELD_KEYS,
  REQUIRED_EXTRACTION_FIELDS,
} = require('../../config/profiles');

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));

const hasConfidentField = (field = {}, threshold = 0.78) => (
  !!field.found && clamp01(field.confidence) >= Number(threshold || 0.78)
);

const buildMissingFieldReasons = (fields = {}, documentProfile) => {
  const fieldDefinitions = documentProfile.fieldDefinitions || {};

  return REQUIRED_EXTRACTION_FIELDS
    .filter((fieldKey) => {
      if (fieldKey === EXTRACTION_FIELD_KEYS.issuerHeader && documentProfile.validation.allowApproveWithoutHeader) {
        return false;
      }

      return !(fields[fieldKey] && fields[fieldKey].found);
    })
    .map((fieldKey) => {
      const fieldDefinition = fieldDefinitions[fieldKey] || {};
      return `Campo obrigatorio ausente: ${fieldDefinition.label || fieldKey}.`;
    });
};

const shouldTriggerFallback = ({
  parsedDocument,
  documentProfile,
  providerId,
}) => {
  const fallbackPolicy = documentProfile.fallbackPolicy || {};
  if (!fallbackPolicy.enabled) return false;

  const primaryProvider = documentProfile.extractionStrategy.primaryProvider;
  if (providerId !== primaryProvider) return false;

  const missingFieldKeys = parsedDocument.summary.missingFieldKeys || [];
  const missingTriggerFields = Array.isArray(fallbackPolicy.triggerWhenMissingFields)
    ? fallbackPolicy.triggerWhenMissingFields
    : [];

  if (missingFieldKeys.some((fieldKey) => missingTriggerFields.includes(fieldKey))) {
    return true;
  }

  return Number(parsedDocument.summary.averageConfidence || 0) < Number(
    fallbackPolicy.triggerBelowConfidence || 0,
  );
};

const shouldSoftApproveWithSingleMissingField = ({
  fields = {},
  missingFieldKeys = [],
  averageConfidence = 0,
  validation = {},
}) => {
  if (!validation.allowApproveWithSingleNonInvoiceFieldMissing) return false;
  if (missingFieldKeys.length !== 1) return false;

  const [missingFieldKey] = missingFieldKeys;
  if (missingFieldKey === EXTRACTION_FIELD_KEYS.invoiceNumber) return false;

  const minimumAverageConfidence = Number(
    validation.singleMissingFieldAverageConfidenceThreshold || 0.74,
  );
  if (averageConfidence < minimumAverageConfidence) return false;

  const minimumFieldConfidence = Number(
    validation.singleMissingFieldConfidenceThreshold || 0.78,
  );

  return hasConfidentField(fields[EXTRACTION_FIELD_KEYS.invoiceNumber], minimumFieldConfidence)
    && hasConfidentField(
      fields[
        missingFieldKey === EXTRACTION_FIELD_KEYS.receiptDate
          ? EXTRACTION_FIELD_KEYS.issuerHeader
          : EXTRACTION_FIELD_KEYS.receiptDate
      ],
      minimumFieldConfidence,
    );
};

module.exports = {
  buildOperationalDecision({
    parsedDocument,
    documentProfile,
    companyProfile,
    sourceProfile,
    providerId,
    providerAttempts = [],
  }) {
    const fields = parsedDocument.fields || {};
    const validation = documentProfile.validation || {};
    const reasons = [];
    const missingFieldReasons = buildMissingFieldReasons(fields, documentProfile);
    reasons.push(...missingFieldReasons);

    const averageConfidence = clamp01(parsedDocument.summary.averageConfidence || 0);
    const missingRequiredCount = missingFieldReasons.length;
    const headerMissing = !(fields[EXTRACTION_FIELD_KEYS.issuerHeader] && fields[EXTRACTION_FIELD_KEYS.issuerHeader].found);
    const missingFieldKeys = parsedDocument.summary && Array.isArray(parsedDocument.summary.missingFieldKeys)
      ? parsedDocument.summary.missingFieldKeys.filter(Boolean)
      : [];
    const softApprovedWithSingleMissingField = shouldSoftApproveWithSingleMissingField({
      fields,
      missingFieldKeys,
      averageConfidence,
      validation,
    });

    let classification = 'review';
    if (
      (
        (
          missingRequiredCount === 0
          && averageConfidence >= Number(validation.validConfidenceThreshold || 0.82)
          && (!headerMissing || validation.allowApproveWithoutHeader)
        )
        || softApprovedWithSingleMissingField
      )
    ) {
      classification = 'valid';
    } else if (missingRequiredCount >= Number(validation.invalidMissingRequiredAbove || 2)) {
      classification = 'invalid';
    } else if (averageConfidence < Number(validation.reviewConfidenceThreshold || 0.58)) {
      classification = 'review';
      reasons.push('Confianca media abaixo do minimo para aprovacao automatica.');
    }

    if (headerMissing && validation.allowApproveWithoutHeader) {
      reasons.push('Cabecalho ausente, mas permitido pela politica do documento.');
    }

    if (softApprovedWithSingleMissingField) {
      reasons.push('Aprovado com um unico campo textual ausente porque os demais campos vieram fortes na imagem.');
    }

    if (providerId !== documentProfile.extractionStrategy.primaryProvider) {
      reasons.push(`Resultado consolidado por ${providerId}.`);
    }

    const operationalMessage = classification === 'valid'
      ? documentProfile.operationalResponse.valid
      : classification === 'invalid'
        ? documentProfile.operationalResponse.invalid
        : documentProfile.operationalResponse.review;

    return {
      classification,
      accepted: classification === 'valid',
      reasons,
      metrics: {
        averageConfidence,
        missingRequiredCount,
        providerAttempts: providerAttempts.map((attempt) => ({
          providerId: attempt.providerId,
          status: attempt.status,
          reason: attempt.reason || null,
        })),
      },
      actions: {
        message: operationalMessage,
        shouldReply: classification !== 'valid'
          && Array.isArray(companyProfile.operationalPolicy.autoReplySources)
          && companyProfile.operationalPolicy.autoReplySources.includes(sourceProfile.id),
      },
      shouldTriggerFallback: shouldTriggerFallback({
        parsedDocument,
        documentProfile,
        providerId,
      }),
    };
  },
};
