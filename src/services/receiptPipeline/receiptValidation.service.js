const { BUSINESS_THRESHOLDS } = require('./receiptConstants');
const receiptProfile = require('../../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
} = require('../../config/receiptProfiles');

const issuerHeaderLabel = receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.issuerHeader].label;

module.exports = {
  validateReceiptStructure({
    requiredFields = {},
    fullOcr = {},
    template = {},
    orientationProbe = {},
  }) {
    const dataField = requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] || {};
    const issuerHeaderField = requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] || {};
    const nfeField = requiredFields[RECEIPT_FIELD_KEYS.nfe] || {};
    const detectedFieldCount = Object.keys(requiredFields)
      .filter((fieldKey) => requiredFields[fieldKey].found)
      .length;
    const bestGlobalConfidence = Number(fullOcr.bestConfidence || 0);
    const templateMatched = !!(
      template.templateMatched
      || orientationProbe.templateMatched
      || Number(template.score || 0) >= BUSINESS_THRESHOLDS.minAcceptedTemplateScore
    );
    const geometryScore = Number(template.geometryScore || 0);
    const geometryHardReject = geometryScore < BUSINESS_THRESHOLDS.hardRejectGeometryScore;
    const hasMinimalFrame = templateMatched || geometryScore >= BUSINESS_THRESHOLDS.minTemplateGeometryScore || detectedFieldCount >= 1;
    const hasOperationalStructure = (
      (dataField.found && nfeField.found)
      || detectedFieldCount >= 2
      || (templateMatched && nfeField.found)
    );
    const reasons = [];
    let status = 'invalid';

    if (geometryHardReject) {
      reasons.push('Fundo muito claro. Por favor, coloque o canhoto sobre uma superficie escura.');
      reasons.push('A geometria minima do canhoto nao foi confirmada apos o preprocessamento.');
    } else if (hasOperationalStructure) {
      status = 'usable';
      reasons.push('A estrutura principal do template do canhoto ficou visivel e pode seguir para a leitura da NF.');
    } else if (hasMinimalFrame || bestGlobalConfidence >= 28) {
      status = 'review';
      reasons.push('O canhoto parece presente, mas a estrutura fixa ainda esta parcialmente ambigua.');
    } else {
      reasons.push('Nao houve evidencias suficientes de enquadramento minimo do canhoto.');
    }

    if (!templateMatched) {
      reasons.push(`O layout esperado do template ${receiptProfile.template.label} nao bateu com seguranca suficiente.`);
    }

    if (!dataField.found) {
      reasons.push('DATA DE RECEBIMENTO nao ficou legivel na ROI esquerda inferior.');
    }

    if (!nfeField.found) {
      reasons.push('O bloco da NF-e nao ficou legivel na ROI direita do template.');
    }

    if (!issuerHeaderField.found) {
      reasons.push(`${issuerHeaderLabel} nao ficou estavel no cabecalho do template.`);
    }

    return {
      status,
      canRunNfFallback: !geometryHardReject && (status !== 'invalid' || (templateMatched && dataField.found)),
      templateMatched,
      reasons,
      metrics: {
        detectedFieldCount,
        bestGlobalConfidence,
        hasOperationalStructure,
        hasMinimalFrame,
        geometryScore,
        geometryHardReject,
      },
    };
  },
};
