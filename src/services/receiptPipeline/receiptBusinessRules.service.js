const { BUSINESS_THRESHOLDS } = require('./receiptConstants');
const receiptProfile = require('../../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
  REQUIRED_FIELD_ORDER,
} = require('../../config/receiptProfiles');

const FIELD_WEIGHTS = {
  [RECEIPT_FIELD_KEYS.dataRecebimento]: 22,
  [RECEIPT_FIELD_KEYS.issuerHeader]: 12,
  [RECEIPT_FIELD_KEYS.nfe]: 24,
};

const issuerHeaderLabel = receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.issuerHeader].label;
const companyName = receiptProfile.company.displayName;

const toUnitConfidence = (value) => {
  const numeric = Number(value || 0);
  if (numeric <= 0) return 0;
  if (numeric > 1) return Math.min(1, numeric / 100);
  return Math.min(1, numeric);
};

const buildConsistencyScore = ({ requiredFields = {}, nfExtraction = {} }) => {
  let score = 0;

  if (requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] && requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].found) score += 2;
  if (requiredFields[RECEIPT_FIELD_KEYS.nfe] && requiredFields[RECEIPT_FIELD_KEYS.nfe].found) score += 2;
  if (
    requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento]
    && requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].found
    && requiredFields[RECEIPT_FIELD_KEYS.nfe]
    && requiredFields[RECEIPT_FIELD_KEYS.nfe].found
  ) {
    score += 2;
  }

  if (
    requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento]
    && requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].found
    && requiredFields[RECEIPT_FIELD_KEYS.issuerHeader]
    && requiredFields[RECEIPT_FIELD_KEYS.issuerHeader].found
    && requiredFields[RECEIPT_FIELD_KEYS.nfe]
    && requiredFields[RECEIPT_FIELD_KEYS.nfe].found
  ) {
    score += 3;
  }

  if (nfExtraction && nfExtraction.nf && Number(nfExtraction.supportCount || 0) >= 2) score += 2;
  if (
    nfExtraction
    && Array.isArray(nfExtraction.sourceTypes)
    && nfExtraction.sourceTypes.some((sourceType) => sourceType === 'field_region' || sourceType === 'region')
  ) {
    score += 1;
  }

  return Math.min(12, score);
};

module.exports = {
  computeBusinessScore({ requiredFields = {}, nfExtraction = {}, validation = {}, invoiceLookup = {} }) {
    const fieldBreakdown = Object.keys(FIELD_WEIGHTS).reduce((accumulator, fieldKey) => {
      const field = requiredFields[fieldKey] || {};
      const confidence = toUnitConfidence(field.confidence);
      accumulator[fieldKey] = Number((FIELD_WEIGHTS[fieldKey] * confidence).toFixed(2));
      return accumulator;
    }, {});

    const nfConfidence = toUnitConfidence(nfExtraction.confidence);
    const invoiceNumber = nfExtraction && nfExtraction.nf
      ? Number((34 * nfConfidence).toFixed(2))
      : Number((10 * Math.min(nfConfidence, 0.45)).toFixed(2));
    const templateStructure = validation && validation.templateMatched
      ? 8
      : Number((Math.min(1, Number(validation.metrics && validation.metrics.geometryScore) || 0) * 8).toFixed(2));
    const consistency = buildConsistencyScore({ requiredFields, nfExtraction });
    const total = Number((
      fieldBreakdown[RECEIPT_FIELD_KEYS.dataRecebimento]
      + fieldBreakdown[RECEIPT_FIELD_KEYS.issuerHeader]
      + fieldBreakdown[RECEIPT_FIELD_KEYS.nfe]
      + invoiceNumber
      + templateStructure
      + consistency
    ).toFixed(2));

    const dataField = requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] || {};
    const issuerHeaderField = requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] || {};
    const nfeField = requiredFields[RECEIPT_FIELD_KEYS.nfe] || {};
    const geometryScore = Number(validation && validation.metrics && validation.metrics.geometryScore) || 0;
    const invoiceConfirmedInDb = !!(invoiceLookup && invoiceLookup.found);
    const fallbackEligible = (
      !!dataField.found
      && !!nfeField.found
      && !!(validation && validation.templateMatched)
      && toUnitConfidence(dataField.confidence) >= BUSINESS_THRESHOLDS.fallbackFieldConfidence
      && toUnitConfidence(nfeField.confidence) >= BUSINESS_THRESHOLDS.fallbackFieldConfidence
      && !!(nfExtraction && nfExtraction.nf)
      && nfConfidence >= BUSINESS_THRESHOLDS.validNfConfidence
    );
    const databaseFallbackEligible = (
      !!dataField.found
      && !!nfeField.found
      && geometryScore >= BUSINESS_THRESHOLDS.minTemplateGeometryScore
      && !!(nfExtraction && nfExtraction.nf)
      && nfConfidence >= BUSINESS_THRESHOLDS.validNfConfidence
      && Number(nfExtraction.supportCount || 0) >= 2
      && invoiceConfirmedInDb
    );
    const allCoreFieldsDetected = !!dataField.found && !!issuerHeaderField.found && !!nfeField.found;

    return {
      total,
      fallbackEligible,
      databaseFallbackEligible,
      allCoreFieldsDetected,
      hasStrongNf: !!(nfExtraction && nfExtraction.nf) && nfConfidence >= BUSINESS_THRESHOLDS.validNfConfidence,
      scoreBreakdown: {
        [RECEIPT_FIELD_KEYS.dataRecebimento]: fieldBreakdown[RECEIPT_FIELD_KEYS.dataRecebimento],
        [RECEIPT_FIELD_KEYS.issuerHeader]: fieldBreakdown[RECEIPT_FIELD_KEYS.issuerHeader],
        [RECEIPT_FIELD_KEYS.nfe]: fieldBreakdown[RECEIPT_FIELD_KEYS.nfe],
        invoiceNumber,
        templateStructure,
        consistency,
        total,
      },
      metrics: {
        detectedFieldCount: REQUIRED_FIELD_ORDER.filter((fieldKey) => requiredFields[fieldKey] && requiredFields[fieldKey].found).length,
        nfConfidence,
        supportCount: Number(nfExtraction.supportCount || 0),
        invoiceConfirmedInDb,
      },
    };
  },

  classifyStructuredReceipt({
    validation = {},
    requiredFields = {},
    nfExtraction = {},
    fullOcr = {},
    invoiceLookup = {},
  }) {
    const score = this.computeBusinessScore({
      requiredFields,
      nfExtraction,
      validation,
      invoiceLookup,
    });
    const reasons = [];
    const suggestedActions = [];
    const averageFieldConfidence = score.metrics.detectedFieldCount
      ? Number((
        REQUIRED_FIELD_ORDER
          .map((fieldKey) => toUnitConfidence((requiredFields[fieldKey] || {}).confidence))
          .reduce((sum, value) => sum + value, 0)
        / REQUIRED_FIELD_ORDER.length
      ).toFixed(2))
      : 0;
    const validationStatus = validation.status || (
      score.metrics.detectedFieldCount === 0
      && !nfExtraction.nf
      && Number(fullOcr.bestConfidence || 0) < 20
        ? 'invalid'
        : 'review'
    );
    const geometryHardReject = !!(validation.metrics && validation.metrics.geometryHardReject);
    const databaseLookupUsedForOrigin = !!(invoiceLookup && invoiceLookup.found && !validation.templateMatched);
    let classification = 'invalid';

    if (geometryHardReject) {
      classification = 'invalid';
      reasons.push('Fundo muito claro. Por favor, coloque o canhoto sobre uma superficie escura.');
      reasons.push('A geometria do canhoto ficou abaixo do minimo para seguir com OCR confiavel.');
      suggestedActions.push('solicitar_fundo_escuro');
      suggestedActions.push('responder_no_whatsapp');
    } else if (
      validation.templateMatched
      && score.hasStrongNf
      && (score.allCoreFieldsDetected || score.fallbackEligible)
      && score.total >= BUSINESS_THRESHOLDS.validScore
      && validationStatus !== 'invalid'
    ) {
      classification = 'valid';

      if (score.allCoreFieldsDetected) {
        reasons.push('Os tres campos estruturais foram localizados e a NF foi extraida com confianca suficiente.');
      } else {
        reasons.push('Fallback aplicado: DATA DE RECEBIMENTO e NF-e estavam legiveis, com NF extraida de forma confiavel.');
        reasons.push(`${issuerHeaderLabel} ficou parcial ou encoberto, mas a estrutura restante sustentou a aprovacao.`);
      }

      suggestedActions.push('seguir_para_integracao_api');
    } else if (
      score.databaseFallbackEligible
      && score.hasStrongNf
      && score.total >= BUSINESS_THRESHOLDS.validScore
      && validationStatus !== 'invalid'
    ) {
      classification = 'valid';
      reasons.push(`${issuerHeaderLabel} ficou parcial ou encoberto, mas a NF extraida existe na base de ${companyName}.`);
      reasons.push('A origem do canhoto foi confirmada pela consulta da NF no banco, mantendo DATA DE RECEBIMENTO e NF-e como ancoras estruturais.');
      suggestedActions.push('seguir_para_integracao_api');
    } else if (
      validationStatus !== 'invalid'
      || score.total >= BUSINESS_THRESHOLDS.reviewScore
      || validation.templateMatched
      || score.metrics.detectedFieldCount >= 1
      || (nfExtraction && nfExtraction.nf)
      || Number(fullOcr.bestConfidence || 0) >= 35
    ) {
      classification = 'review';

      if (!nfExtraction || !nfExtraction.nf) {
        reasons.push('A estrutura do canhoto apareceu parcialmente, mas a NF nao foi extraida com seguranca suficiente.');
      } else if (score.allCoreFieldsDetected || score.fallbackEligible) {
        reasons.push('A NF foi localizada, mas ainda ha ambiguidade residual na leitura estrutural da imagem.');
      } else {
        reasons.push('Ha indicios estruturais bons, mas falta confianca para aprovar automaticamente o canhoto.');
      }

      if (!(requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] && requiredFields[RECEIPT_FIELD_KEYS.issuerHeader].found)) {
        reasons.push(`O campo ${issuerHeaderLabel} nao ficou legivel o bastante para fechar a aprovacao automatica.`);
      }

      suggestedActions.push('revisar_manual');
      suggestedActions.push('avaliar_nova_foto');
    } else {
      reasons.push('A foto nao apresentou estrutura suficiente do canhoto para leitura confiavel.');
      reasons.push('Os campos principais e a NF nao atingiram o minimo de confianca exigido.');
      suggestedActions.push('solicitar_novo_envio');
      suggestedActions.push('responder_no_whatsapp');
    }

    if (!(requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] && requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].found)) {
      reasons.push('DATA DE RECEBIMENTO nao foi localizada com seguranca.');
    }

    if (!(requiredFields[RECEIPT_FIELD_KEYS.nfe] && requiredFields[RECEIPT_FIELD_KEYS.nfe].found)) {
      reasons.push('Campo NF-e nao foi localizado com seguranca.');
    }

    if (!validation.templateMatched) {
      reasons.push('O template fixo do canhoto nao foi confirmado com seguranca suficiente.');
    }

    if (!nfExtraction || !nfExtraction.nf) {
      reasons.push('A rotina de extracao da NF nao encontrou um numero plausivel e consistente.');
    } else if (toUnitConfidence(nfExtraction.confidence) < BUSINESS_THRESHOLDS.validNfConfidence) {
      reasons.push('A NF encontrada ainda esta abaixo da confianca desejada para aprovacao automatica.');
    }

    if (databaseLookupUsedForOrigin) {
      reasons.push(`A consulta no banco confirmou que a NF pertence a ${companyName}, mesmo com o cabecalho parcialmente coberto.`);
    } else if (invoiceLookup && invoiceLookup.reason === 'invoice_not_found' && nfExtraction && nfExtraction.nf) {
      reasons.push(`A NF extraida nao foi encontrada na base de ${companyName} para servir como confirmacao adicional.`);
    }

    return {
      classification,
      reasons,
      suggestedActions,
      shouldReplyToWhatsapp: classification !== 'valid',
      metrics: {
        averageFieldConfidence,
        businessScore: score.total,
        detectedFieldCount: score.metrics.detectedFieldCount,
        nfConfidence: score.metrics.nfConfidence,
        fallbackApplied: classification === 'valid' && score.fallbackEligible && !score.allCoreFieldsDetected,
        databaseFallbackApplied: classification === 'valid' && score.databaseFallbackEligible,
        validationStatus,
        geometryHardReject,
        invoiceConfirmedInDb: score.metrics.invoiceConfirmedInDb,
      },
      scoreBreakdown: score.scoreBreakdown,
      fallbackApplied: score.fallbackEligible && !score.allCoreFieldsDetected,
      databaseFallbackApplied: classification === 'valid' && score.databaseFallbackEligible,
      allCoreFieldsDetected: score.allCoreFieldsDetected,
    };
  },
};
