const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const receiptProfile = require('../config/receiptProfile');
const {
  RECEIPT_FIELD_KEYS,
} = require('../config/receiptProfiles');
const imagePreprocessService = require('./imagePreprocess.service');
const receiptDetectorService = require('./receiptDetector.service');
const nfExtractorService = require('./nfExtractor.service');
const receiptClassifierService = require('./receiptClassifier.service');
const apiService = require('./api.service');
const ocrService = require('./ocr.service');
const receiptOrientationService = require('./receiptPipeline/receiptOrientation.service');
const receiptStructuredOcrService = require('./receiptPipeline/receiptStructuredOcr.service');
const receiptValidationService = require('./receiptPipeline/receiptValidation.service');
const receiptTemplateService = require('./receiptPipeline/receiptTemplate.service');
const {
  BUSINESS_THRESHOLDS,
  NF_ROI_DEFINITIONS,
  RECEIPT_TEMPLATE,
} = require('./receiptPipeline/receiptConstants');

const NF_BLOCK_DEFINITION = NF_ROI_DEFINITIONS.find((definition) => definition.id === 'nf_block') || null;
const issuerHeaderLabel = receiptProfile.fieldSpecs[RECEIPT_FIELD_KEYS.issuerHeader].label;
const companyName = receiptProfile.company.displayName;
const ORIENTATION_PROBE_FALLBACK_THRESHOLDS = {
  [RECEIPT_FIELD_KEYS.dataRecebimento]: 0.55,
  [RECEIPT_FIELD_KEYS.issuerHeader]: 0.58,
  [RECEIPT_FIELD_KEYS.nfe]: 0.64,
};
const NF_BLOCK_RESCUE_CROPS = [
  {
    id: 'nf_block_clean_rescue_full',
    label: 'Bloco NF-e limpo',
    cropBox: null,
  },
  {
    id: 'nf_block_clean_rescue_low',
    label: 'Bloco NF-e limpo recorte inferior',
    cropBox: { x: 0.0, y: 0.18, width: 1.0, height: 0.82 },
  },
];

const buildRescueCrop = (sourceImage, cropBox = null) => {
  if (!cropBox) return sourceImage.clone();

  const x = Math.max(0, Math.floor(sourceImage.bitmap.width * Number(cropBox.x || 0)));
  const y = Math.max(0, Math.floor(sourceImage.bitmap.height * Number(cropBox.y || 0)));
  const width = Math.max(2, Math.floor(sourceImage.bitmap.width * Number(cropBox.width || 1)));
  const height = Math.max(2, Math.floor(sourceImage.bitmap.height * Number(cropBox.height || 1)));

  return sourceImage.clone().crop(
    x,
    y,
    Math.min(width, sourceImage.bitmap.width - x),
    Math.min(height, sourceImage.bitmap.height - y),
  );
};

const buildNfRescueDocuments = async ({
  imagePath,
  preprocess,
  orientationProbe,
  outputDir,
  fastMode = false,
}) => {
  if (!NF_BLOCK_DEFINITION) return [];

  const baseImage = await Jimp.read(imagePath);
  if (preprocess.orientation && preprocess.orientation.rotation) {
    baseImage.rotate(preprocess.orientation.rotation);
  }
  const rankedOrientationIds = Array.isArray(orientationProbe.results) && orientationProbe.results.length
    ? orientationProbe.results.map((item) => item.orientationId)
    : (preprocess.orientationCandidates || []).map((item) => item.id);
  const uniqueOrientationIds = rankedOrientationIds.filter((orientationId, index, array) => (
    orientationId && array.indexOf(orientationId) === index
  )).slice(0, fastMode ? 2 : 3);
  const rescueOutputDir = path.join(outputDir, 'nf-rescue');
  fs.mkdirSync(rescueOutputDir, { recursive: true });
  const targets = [];

  for (const orientationId of uniqueOrientationIds) {
    const orientationCandidate = (preprocess.orientationCandidates || []).find((candidate) => candidate.id === orientationId);
    if (!orientationCandidate) continue;

    const orientedImage = baseImage.clone();
    if (orientationCandidate.rotation) {
      orientedImage.rotate(orientationCandidate.rotation);
    }

    const alignment = receiptTemplateService.alignReceiptToTemplate(orientedImage);
    const cleanedAligned = imagePreprocessService
      .removeColoredInk(alignment.alignedImage.clone())
      .greyscale()
      .normalize()
      .contrast(0.3);
    const nfBlockBox = receiptTemplateService.buildPixelBox(cleanedAligned, NF_BLOCK_DEFINITION.box);
    const nfBlockImage = cleanedAligned.clone().crop(
      nfBlockBox.x,
      nfBlockBox.y,
      nfBlockBox.width,
      nfBlockBox.height,
    );

    for (const rescueCrop of NF_BLOCK_RESCUE_CROPS) {
      const crop = buildRescueCrop(nfBlockImage, rescueCrop.cropBox);
      const preparedCrop = crop.clone().scale(fastMode ? 3 : 4);
      const preparedTargets = [
        {
          suffix: '',
          image: preparedCrop.clone(),
          variantProfileId: 'document_ink_clean_rescue',
          targetRole: rescueCrop.id,
        },
        {
          suffix: '__sharp',
          image: imagePreprocessService.sharpenLight(preparedCrop.clone().contrast(0.2)),
          variantProfileId: 'document_ink_clean_rescue_sharp',
          targetRole: `${rescueCrop.id}_sharp`,
        },
      ];

      for (const preparedTarget of preparedTargets) {
        const filePath = path.join(rescueOutputDir, `${orientationId}__${rescueCrop.id}${preparedTarget.suffix}.png`);
        await preparedTarget.image.getBufferAsync(Jimp.MIME_PNG).then((buffer) => fs.promises.writeFile(filePath, buffer));
        targets.push({
          id: `${orientationId}__${rescueCrop.id}${preparedTarget.suffix}`,
          label: `${rescueCrop.label} [${orientationId}]${preparedTarget.suffix ? ' [nitido]' : ''}`,
          filePath,
          sourceType: 'nf_roi',
          parameters: {
            tessedit_pageseg_mode: '6',
            classify_bln_numeric_mode: '1',
          },
          meta: {
            orientationId,
            regionId: 'nf_block',
            regionLabel: rescueCrop.label,
            fieldKeys: ['nfe'],
            sourceVariantId: `${orientationId}__ink_clean_rescue`,
            variantProfileId: preparedTarget.variantProfileId,
            targetRole: preparedTarget.targetRole,
            roiProfileId: 'nf_context_gray_2x',
            requestedRoiId: 'nf_block',
            roiId: 'nf_block',
            roiWidth: preparedTarget.image.bitmap.width,
            roiHeight: preparedTarget.image.bitmap.height,
            roiBox: NF_BLOCK_DEFINITION.box,
            layoutStrategy: 'template_fixed_rescue',
            usedFallback: false,
            fallbackChain: ['nf_block'],
            rescueKind: rescueCrop.id,
            psm: '6',
          },
        });
      }
    }
  }

  if (!targets.length) return [];

  const results = [];
  for (const target of targets) {
    const recognition = await ocrService.recognizeTargets([target], {
      language: 'por',
      maxEdge: fastMode ? 1800 : 2200,
      minEdge: fastMode ? 1100 : 1400,
    });
    if (recognition.results && recognition.results[0]) {
      results.push(recognition.results[0]);
    }
  }

  return results;
};

const hydrateNfExtractionFromCandidate = (baseExtraction = {}, candidate = null) => {
  if (!candidate) return baseExtraction;

  const bestEvidence = Array.isArray(candidate.evidence) ? candidate.evidence[0] : null;

  return Object.assign({}, baseExtraction, {
    nf: candidate.nf,
    confidence: candidate.confidence,
    method: candidate.method,
    matchedPattern: candidate.method,
    context: candidate.context || {
      foundNfe: false,
      foundNumeroMarker: false,
    },
    supportCount: candidate.supportCount || 0,
    roiSupportCount: candidate.roiSupportCount || 0,
    variantSupportCount: candidate.variantSupportCount || 0,
    sourceTypes: candidate.sourceTypes || [],
    sourceRegion: bestEvidence ? bestEvidence.requestedRoiId || bestEvidence.regionId : null,
    sourceRegionId: bestEvidence ? bestEvidence.regionId : null,
    rawText: bestEvidence ? bestEvidence.evidence : null,
    supportingTexts: candidate.supportingTexts || [],
    supportingRois: candidate.supportingRois || [],
    supportingVariants: candidate.supportingVariants || [],
    decisionReason: candidate.decisionReason || [],
    origin: candidate.origin || null,
    usedFallback: !!candidate.usedFallback,
  });
};

const buildTightFuzzyDbNeighbors = (candidate) => {
  const digits = String(candidate && candidate.nf || '').trim();
  const neighbors = new Set();

  digits.split('').forEach((digit, index) => {
    if (digit === '8') {
      neighbors.add(digits.slice(0, index) + '5' + digits.slice(index + 1));
    } else if (digit === '5') {
      neighbors.add(digits.slice(0, index) + '8' + digits.slice(index + 1));
    }
  });

  const candidateConfidence = Number(candidate && candidate.confidence || 0);
  const hasContext = !!(
    candidate
    && candidate.context
    && (candidate.context.foundNfe || candidate.context.foundNumeroMarker)
  );

  // OCR fraco em ROI curta costuma inverter dois digitos adjacentes.
  if (digits.length >= 2 && candidateConfidence < BUSINESS_THRESHOLDS.validNfConfidence && !hasContext) {
    for (let index = 0; index < digits.length - 1; index += 1) {
      if (digits[index] === digits[index + 1]) continue;
      neighbors.add(
        digits.slice(0, index)
        + digits[index + 1]
        + digits[index]
        + digits.slice(index + 2),
      );
    }
  }

  return Array.from(neighbors);
};

const hasRescueFriendlyVariant = (candidate) => (
  Array.isArray(candidate && candidate.supportingVariants)
  && candidate.supportingVariants.some((variantId) => (
    String(variantId).indexOf('ink_clean_rescue') >= 0
    || String(variantId).indexOf('document_ink_clean') >= 0
  ))
);

const isEligibleForFuzzyDbRescue = (candidate, bestConfidence = 0) => {
  const confidence = Number(candidate && candidate.confidence || 0);
  if (confidence < Math.max(0.35, bestConfidence - 0.15)) return false;

  const sourceTypes = Array.isArray(candidate && candidate.sourceTypes)
    ? candidate.sourceTypes
    : [];
  const isRoiCandidate = (
    (candidate && candidate.origin === 'roi')
    || sourceTypes.some((sourceType) => String(sourceType).indexOf('nf_roi') >= 0)
  );
  if (!isRoiCandidate) return false;

  if (hasRescueFriendlyVariant(candidate)) return true;

  const context = candidate && candidate.context ? candidate.context : null;
  return !!(context && !context.foundNfe && !context.foundNumeroMarker);
};

const hasCompetingStrongCandidate = (nfExtraction = {}) => {
  const candidates = Array.isArray(nfExtraction.candidates)
    ? nfExtraction.candidates
    : [];
  if (candidates.length < 2 || !nfExtraction.nf) return false;

  const currentConfidence = Number(nfExtraction.confidence || 0);

  return candidates.some((candidate) => (
    candidate.nf
    && candidate.nf !== nfExtraction.nf
    && Number(candidate.confidence || 0) >= currentConfidence - 0.05
  ));
};

const hasStrongConfirmedCandidateEvidence = (candidate = null) => {
  if (!candidate) return false;

  const confidence = Number(candidate.confidence || 0);
  const supportCount = Number(candidate.supportCount || 0);
  const roiSupportCount = Number(candidate.roiSupportCount || 0);
  const precisionScore = Number(candidate.precisionScore || 0);
  const hasContext = !!(
    candidate.context
    && (candidate.context.foundNfe || candidate.context.foundNumeroMarker)
  );

  return (
    confidence >= 0.55
    || supportCount >= 2
    || roiSupportCount >= 2
    || precisionScore > 0
    || hasContext
  );
};

const canPromoteConfirmedCandidate = ({
  currentExtraction = {},
  confirmedCandidate = null,
}) => {
  if (!confirmedCandidate) return false;

  const currentNf = String(currentExtraction && currentExtraction.nf || '').trim();
  const currentConfidence = Number(currentExtraction && currentExtraction.confidence || 0);
  const confirmedConfidence = Number(confirmedCandidate.confidence || 0);

  if (!currentNf) return true;
  if (confirmedCandidate.nf === currentNf) return true;
  if (confirmedConfidence >= currentConfidence - 0.08) return true;

  return (
    confirmedConfidence >= currentConfidence - 0.16
    && hasStrongConfirmedCandidateEvidence(confirmedCandidate)
  );
};

const resolveFuzzyDbRescue = async (candidates = []) => {
  const bestConfidence = candidates.reduce((maxValue, candidate) => (
    Math.max(maxValue, Number(candidate && candidate.confidence || 0))
  ), 0);
  const fuzzyRescueCandidates = candidates.filter((candidate) => (
    isEligibleForFuzzyDbRescue(candidate, bestConfidence)
  ));
  const fuzzyLookups = [];
  const seenNeighbor = new Set();

  for (const candidate of fuzzyRescueCandidates) {
    for (const neighbor of buildTightFuzzyDbNeighbors(candidate)) {
      if (seenNeighbor.has(neighbor)) continue;
      seenNeighbor.add(neighbor);
      const lookup = await apiService.findInvoiceByNumber(neighbor);
      if (lookup && lookup.found) {
        fuzzyLookups.push({
          candidate,
          nf: neighbor,
          lookup,
        });
      }
    }
  }

  if (fuzzyLookups.length !== 1) return null;

  const rescued = fuzzyLookups[0];
  return {
    candidate: Object.assign({}, rescued.candidate, {
      nf: rescued.nf,
      confidence: Math.max(0.45, Number(rescued.candidate.confidence || 0) - 0.04),
      method: 'db_fuzzy_rescue',
      decisionReason: (rescued.candidate.decisionReason || []).concat(['fuzzy_rescue_confirmado_no_banco']),
    }),
    lookup: rescued.lookup,
  };
};

const resolveCandidateByInvoiceLookup = async ({
  nfExtraction,
  currentLookup,
}) => {
  const candidates = Array.isArray(nfExtraction.candidates)
    ? nfExtraction.candidates.slice(0, 6)
    : [];
  if (!candidates.length) {
    return {
      nfExtraction,
      invoiceLookup: currentLookup,
      reranked: false,
    };
  }

  const competingStrongCandidate = hasCompetingStrongCandidate(nfExtraction);

  if (currentLookup.found && Number(nfExtraction.confidence || 0) >= 0.9 && !competingStrongCandidate) {
    return {
      nfExtraction,
      invoiceLookup: currentLookup,
      reranked: false,
    };
  }

  const lookups = [];
  for (const candidate of candidates) {
    const lookup = await apiService.findInvoiceByNumber(candidate.nf);
    lookups.push({ candidate, lookup });
  }

  const confirmed = lookups
    .filter((item) => item.lookup && item.lookup.found)
    .sort((left, right) => {
      const leftCleanPriority = Array.isArray(left.candidate.supportingVariants)
        && left.candidate.supportingVariants.some((variantId) => (
          String(variantId).indexOf('ink_clean_rescue') >= 0
          || String(variantId).indexOf('document_ink_clean') >= 0
        ));
      const rightCleanPriority = Array.isArray(right.candidate.supportingVariants)
        && right.candidate.supportingVariants.some((variantId) => (
          String(variantId).indexOf('ink_clean_rescue') >= 0
          || String(variantId).indexOf('document_ink_clean') >= 0
        ));
      if (rightCleanPriority !== leftCleanPriority) return rightCleanPriority ? 1 : -1;
      if (Number(right.candidate.confidence || 0) !== Number(left.candidate.confidence || 0)) {
        return Number(right.candidate.confidence || 0) - Number(left.candidate.confidence || 0);
      }
      if (Number(right.candidate.supportCount || 0) !== Number(left.candidate.supportCount || 0)) {
        return Number(right.candidate.supportCount || 0) - Number(left.candidate.supportCount || 0);
      }
      if (Number(right.candidate.roiSupportCount || 0) !== Number(left.candidate.roiSupportCount || 0)) {
        return Number(right.candidate.roiSupportCount || 0) - Number(left.candidate.roiSupportCount || 0);
      }
      return String(left.candidate.nf).localeCompare(String(right.candidate.nf));
    });

  if (!confirmed.length) {
    const rescued = await resolveFuzzyDbRescue(candidates);
    if (rescued) {
      return {
        nfExtraction: hydrateNfExtractionFromCandidate(nfExtraction, rescued.candidate),
        invoiceLookup: rescued.lookup,
        reranked: true,
      };
    }

    return {
      nfExtraction,
      invoiceLookup: currentLookup,
      reranked: false,
    };
  }

  const chosen = confirmed[0];
  const rescued = await resolveFuzzyDbRescue(candidates);
  if (
    rescued
    && Number(chosen.candidate.confidence || 0) < 0.5
    && Number(rescued.candidate.confidence || 0) >= Number(chosen.candidate.confidence || 0) + 0.04
  ) {
    return {
      nfExtraction: hydrateNfExtractionFromCandidate(nfExtraction, rescued.candidate),
      invoiceLookup: rescued.lookup,
      reranked: true,
    };
  }
  const sameCandidate = chosen.candidate.nf === nfExtraction.nf;
  const shouldReplace = !sameCandidate && (
    currentLookup.found
      ? Number(chosen.candidate.confidence || 0) >= Number(nfExtraction.confidence || 0) - 0.04
      : canPromoteConfirmedCandidate({
        currentExtraction: nfExtraction,
        confirmedCandidate: chosen.candidate,
      })
  );

  if (!shouldReplace) {
    return {
      nfExtraction,
      invoiceLookup: currentLookup,
      reranked: false,
    };
  }

  return {
    nfExtraction: hydrateNfExtractionFromCandidate(nfExtraction, chosen.candidate),
    invoiceLookup: chosen.lookup,
    reranked: true,
  };
};

const toCheckpointStatus = (condition, fallbackCondition = false) => {
  if (condition) return 'passed';
  if (fallbackCondition) return 'fallback';
  return 'failed';
};

const mergeOrientationProbeFallbackFields = ({
  requiredFields = {},
  orientationProbe = {},
}) => {
  const merged = Object.assign({}, requiredFields);
  const bestOrientation = Array.isArray(orientationProbe.results)
    ? orientationProbe.results.find((result) => result.orientationId === orientationProbe.bestOrientationId)
      || orientationProbe.results[0]
      || null
    : null;
  const probeFields = bestOrientation && bestOrientation.requiredFields
    ? bestOrientation.requiredFields
    : {};
  let mergedCount = 0;

  Object.keys(ORIENTATION_PROBE_FALLBACK_THRESHOLDS).forEach((fieldKey) => {
    const currentField = merged[fieldKey] || {};
    if (currentField.found) return;

    const probeField = probeFields[fieldKey];
    if (!probeField) return;

    const fallbackThreshold = ORIENTATION_PROBE_FALLBACK_THRESHOLDS[fieldKey];
    const canFallback = !!(
      probeField.found
      || (
        Number(probeField.confidence || 0) >= fallbackThreshold
        && Array.isArray(probeField.reasons)
        && probeField.reasons.includes('regiao_esperada')
      )
    );

    if (!canFallback) return;

    merged[fieldKey] = Object.assign({}, probeField, {
      found: true,
      method: `${probeField.method || 'orientation_probe'}__fallback`,
      sourceType: 'orientation_probe_fallback',
      reasons: Array.isArray(probeField.reasons)
        ? probeField.reasons.concat(['fallback_probe_orientacao'])
        : ['fallback_probe_orientacao'],
    });
    mergedCount += 1;
  });

  return {
    requiredFields: merged,
    mergedCount,
    bestOrientationId: bestOrientation ? bestOrientation.orientationId : null,
  };
};

const buildFailureDiagnostics = ({
  template = {},
  validation = {},
  detection = {},
  nfExtraction = {},
  classification = {},
  invoiceLookup = {},
}) => {
  const requiredFields = detection.requiredFields || {};
  const signatureCheck = template.signatureCheck || null;
  const signaturePresent = signatureCheck && signatureCheck.evaluated
    ? !!signatureCheck.present
    : null;
  const headerFallbackByDb = !requiredFields[RECEIPT_FIELD_KEYS.issuerHeader]?.found && !!invoiceLookup.found;
  const checkpoints = [
    {
      key: 'geometry',
      label: 'Geometria do canhoto',
      status: validation.metrics && validation.metrics.geometryHardReject
        ? 'failed'
        : (template.templateMatched || Number(template.geometryScore || 0) >= 0.5 ? 'passed' : 'warning'),
      detail: validation.metrics && validation.metrics.geometryHardReject
        ? 'O canhoto nao ficou separado do fundo com confianca suficiente.'
        : template.templateMatched
          ? 'O template do canhoto foi confirmado.'
          : 'A geometria ficou parcial; ainda foi possivel seguir com OCR.',
      blocksAutomaticApproval: true,
    },
    {
      key: 'signature',
      label: 'Assinatura',
      status: signaturePresent === null ? 'warning' : signaturePresent ? 'passed' : 'failed',
      detail: signaturePresent === null
        ? 'A area de assinatura ainda nao foi medida nesta imagem.'
        : signaturePresent
          ? `Ha indicio de assinatura no quadro central (score ${signatureCheck.score}).`
          : `Nao encontrei traco suficiente na area de assinatura (score ${signatureCheck.score}).`,
      blocksAutomaticApproval: false,
      metrics: signatureCheck,
    },
    {
      key: 'date',
      label: 'DATA DE RECEBIMENTO',
      status: toCheckpointStatus(!!requiredFields.dataRecebimento?.found),
      detail: requiredFields.dataRecebimento?.found
        ? `Campo lido com confianca ${requiredFields.dataRecebimento.confidence}.`
        : 'O campo DATA DE RECEBIMENTO nao foi localizado com seguranca.',
      blocksAutomaticApproval: true,
      metrics: requiredFields.dataRecebimento || null,
    },
    {
      key: 'header',
      label: issuerHeaderLabel,
      status: toCheckpointStatus(!!requiredFields[RECEIPT_FIELD_KEYS.issuerHeader]?.found, headerFallbackByDb),
      detail: requiredFields[RECEIPT_FIELD_KEYS.issuerHeader]?.found
        ? `Cabecalho reconhecido com confianca ${requiredFields[RECEIPT_FIELD_KEYS.issuerHeader].confidence}.`
        : headerFallbackByDb
          ? `Cabecalho coberto ou fraco, mas a NF confirmou a origem ${companyName} no banco.`
          : `O cabecalho ${issuerHeaderLabel} nao ficou legivel o bastante para fechamento por OCR.`,
      blocksAutomaticApproval: !headerFallbackByDb,
      metrics: requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] || null,
    },
    {
      key: 'nf_block',
      label: 'Bloco NF-e',
      status: toCheckpointStatus(!!requiredFields.nfe?.found),
      detail: requiredFields.nfe?.found
        ? `O bloco NF-e apareceu com confianca ${requiredFields.nfe.confidence}.`
        : 'O bloco NF-e nao foi localizado na regiao esperada.',
      blocksAutomaticApproval: true,
      metrics: requiredFields.nfe || null,
    },
    {
      key: 'nf_number',
      label: 'Numero da NF',
      status: toCheckpointStatus(!!nfExtraction.nf),
      detail: nfExtraction.nf
        ? `NF ${nfExtraction.nf} extraida com confianca ${nfExtraction.confidence}.`
        : 'Nenhuma NF consistente foi extraida dos recortes analisados.',
      blocksAutomaticApproval: true,
      metrics: {
        nf: nfExtraction.nf || null,
        confidence: nfExtraction.confidence || 0,
        supportCount: nfExtraction.supportCount || 0,
        origin: nfExtraction.origin || null,
      },
    },
    {
      key: 'invoice_lookup',
      label: 'Conferencia da NF no banco',
      status: !nfExtraction.nf
        ? 'skipped'
        : invoiceLookup.found
          ? 'passed'
          : invoiceLookup.reason === 'lookup_disabled'
            ? 'warning'
            : 'failed',
      detail: !nfExtraction.nf
        ? 'A consulta ao banco foi pulada porque nenhuma NF foi consolidada.'
        : invoiceLookup.found
          ? `A NF ${nfExtraction.nf} existe na base consultada (${invoiceLookup.mode}).`
          : invoiceLookup.reason === 'lookup_disabled'
            ? 'A consulta da NF no banco esta desativada.'
            : invoiceLookup.reason === 'lookup_error'
              ? `A consulta da NF no banco falhou: ${invoiceLookup.error}.`
              : `A NF ${nfExtraction.nf} nao foi encontrada na base consultada.`,
      blocksAutomaticApproval: false,
      metrics: invoiceLookup || null,
    },
  ];
  const failedCheckpoints = checkpoints.filter((checkpoint) => checkpoint.status === 'failed');
  const blockingFailures = failedCheckpoints.filter((checkpoint) => checkpoint.blocksAutomaticApproval);
  let approvalBasis = 'reprovado_ou_revisao';

  if (classification.classification === 'valid') {
    if (classification.metrics && classification.metrics.databaseFallbackApplied) {
      approvalBasis = 'nf_confirmada_no_banco';
    } else if (classification.metrics && classification.metrics.fallbackApplied) {
      approvalBasis = 'fallback_ocr_sem_cabecalho';
    } else {
      approvalBasis = 'todos_os_campos_ocr';
    }
  }

  return {
    approvalBasis,
    checkpoints,
    failedCheckpoints,
    blockingFailures,
    summary: {
      classification: classification.classification || 'unknown',
      failedKeys: failedCheckpoints.map((checkpoint) => checkpoint.key),
      failedLabels: failedCheckpoints.map((checkpoint) => checkpoint.label),
      blockingFailedKeys: blockingFailures.map((checkpoint) => checkpoint.key),
      signatureLikelyPresent: signaturePresent,
      headerFallbackByDb,
      invoiceConfirmedInDb: !!invoiceLookup.found,
    },
  };
};

module.exports = {
  __testables: {
    buildTightFuzzyDbNeighbors,
    canPromoteConfirmedCandidate,
    hasStrongConfirmedCandidateEvidence,
    isEligibleForFuzzyDbRescue,
    resolveCandidateByInvoiceLookup,
    resolveFuzzyDbRescue,
    mergeOrientationProbeFallbackFields,
  },

  async analyzeImage({ imagePath, outputDir, onProgress = null, profile = 'batch' }) {
    const emitProgress = (payload) => {
      if (!onProgress) return;
      onProgress(Object.assign({
        at: new Date().toISOString(),
      }, payload));
    };
    const startedAt = Date.now();
    const fastMode = profile === 'local_fast';

    emitProgress({
      step: 'preprocess',
      status: 'running',
      message: 'Carregando e normalizando a foto do canhoto.',
    });
    const preprocess = await imagePreprocessService.preprocessImage({
      imagePath,
      outputDir,
      profile,
    });
    const shouldForceFastMode = !!(
      preprocess.captureProfile
      && preprocess.captureProfile.id === 'receipt_strip'
    );
    const effectiveFastMode = fastMode || (
      shouldForceFastMode
    );
    const afterPreprocess = Date.now();
    emitProgress({
      step: 'preprocess',
      status: 'completed',
      message: `${preprocess.totalVariants} variantes orientadas e preprocessadas foram geradas.`,
      data: {
        totalVariants: preprocess.totalVariants,
        captureProfile: preprocess.captureProfile ? preprocess.captureProfile.id : null,
        fastMode: effectiveFastMode,
      },
    });

    emitProgress({
      step: 'orientation',
      status: 'running',
      message: 'Detectando a melhor orientacao do documento com base nos campos estruturais.',
    });
    const ocrProbe = await receiptOrientationService.selectBestOrientation({
      preprocess,
      fastMode: effectiveFastMode,
    });
    const selectedOrientation = (preprocess.orientationCandidates || []).find(
      (candidate) => candidate.id === ocrProbe.bestOrientationId,
    ) || null;
    const afterOrientation = Date.now();
    emitProgress({
      step: 'orientation',
      status: 'completed',
      message: `Orientacao escolhida: ${ocrProbe.bestOrientationId || 'indefinida'} (${ocrProbe.bestVariantId || 'sem variante'}).`,
      data: {
        bestOrientationId: ocrProbe.bestOrientationId,
        bestVariantId: ocrProbe.bestVariantId,
        bestScore: ocrProbe.bestScore,
      },
    });

    emitProgress({
      step: 'global_ocr',
      status: 'running',
      message: 'Executando OCR global apenas como apoio contextual.',
    });
    const shouldRunGlobalSupportOcr = !effectiveFastMode || shouldForceFastMode;
    const globalOcrResult = await receiptStructuredOcrService.runGlobalSupportOcr({
      preprocess,
      orientationProbe: ocrProbe,
      fastMode: !shouldRunGlobalSupportOcr,
    });
    emitProgress({
      step: 'global_ocr',
      status: 'completed',
      message: 'OCR global de apoio concluido.',
      data: {
        bestTargetId: globalOcrResult.fullOcr.bestTargetId,
        bestConfidence: globalOcrResult.fullOcr.bestConfidence,
      },
    });
    emitProgress({
      step: 'region_ocr',
      status: 'running',
      message: 'Executando OCR por regioes do cabecalho e da caixa da NF-e.',
    });
    const regionOcrResult = await receiptStructuredOcrService.runRegionOcr({
      preprocess,
      orientationProbe: ocrProbe,
      fastMode: effectiveFastMode,
    });
    const structuredOcr = receiptStructuredOcrService.buildStructuredOcrResult({
      preprocess,
      orientationProbe: ocrProbe,
      fullOcr: globalOcrResult.fullOcr,
      regionOcr: regionOcrResult.regionOcr,
      analyzedRegions: regionOcrResult.analyzedRegions,
    });
    const afterStructuredOcr = Date.now();
    emitProgress({
      step: 'region_ocr',
      status: 'completed',
      message: `${structuredOcr.regionOcr.totalTargets || 0} regioes candidatas foram analisadas.`,
      data: {
        totalTargets: structuredOcr.regionOcr.totalTargets || 0,
      },
    });

    emitProgress({
      step: 'field_detection',
      status: 'running',
      message: `Localizando DATA DE RECEBIMENTO, ${issuerHeaderLabel} e o campo NF-e.`,
    });
    const detection = await receiptDetectorService.detectRequiredFields({
      documents: structuredOcr.documents,
      fullOcr: structuredOcr.fullOcr,
      regionOcr: structuredOcr.regionOcr,
    });
    const orientationFallback = mergeOrientationProbeFallbackFields({
      requiredFields: detection.requiredFields,
      orientationProbe: ocrProbe,
    });
    detection.requiredFields = orientationFallback.requiredFields;
    detection.summary = Object.assign({}, detection.summary, {
      detectedCount: Object.keys(detection.requiredFields)
        .filter((fieldKey) => detection.requiredFields[fieldKey].found)
        .length,
      missingFields: Object.keys(detection.requiredFields)
        .filter((fieldKey) => !detection.requiredFields[fieldKey].found),
      orientationProbeFallbackCount: orientationFallback.mergedCount,
      orientationProbeFallbackOrientationId: orientationFallback.bestOrientationId,
    });
    const template = {
      templateId: RECEIPT_TEMPLATE.id,
      label: RECEIPT_TEMPLATE.label,
      orientationId: ocrProbe.bestOrientationId || null,
      rotation: selectedOrientation ? selectedOrientation.rotation : 0,
      templateMatched: !!ocrProbe.templateMatched,
      score: ocrProbe.bestScore || 0,
      geometryScore: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.geometryScore
        : 0,
      contourDetected: !!(selectedOrientation && selectedOrientation.alignment && selectedOrientation.alignment.contourDetected),
      contourBounds: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.contourBounds
        : null,
      contourCorners: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.contourCorners || null
        : null,
      deskewAngle: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.deskewAngle
        : 0,
      warpApplied: !!(selectedOrientation && selectedOrientation.alignment && selectedOrientation.alignment.warpApplied),
      warpCandidateKind: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.warpCandidateKind || null
        : null,
      warpCandidateQuality: selectedOrientation && selectedOrientation.alignment
        ? Number(selectedOrientation.alignment.warpCandidateQuality || 0)
        : 0,
      suspiciousWarp: !!(selectedOrientation && selectedOrientation.alignment && selectedOrientation.alignment.suspiciousWarp),
      nfAnchor: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.nfAnchor || null
        : null,
      signatureCheck: selectedOrientation && selectedOrientation.alignment
        ? selectedOrientation.alignment.signatureCheck || null
        : null,
      alignedFilePath: selectedOrientation ? selectedOrientation.alignedFilePath : null,
      maskedFilePath: selectedOrientation ? selectedOrientation.maskedFilePath : null,
    };
    const validation = receiptValidationService.validateReceiptStructure({
      requiredFields: detection.requiredFields,
      fullOcr: structuredOcr.fullOcr,
      regionOcr: structuredOcr.regionOcr,
      template,
      orientationProbe: ocrProbe,
    });
    const afterDetection = Date.now();
    emitProgress({
      step: 'field_detection',
      status: 'completed',
      message: `${detection.summary.detectedCount} dos 3 campos estruturais foram localizados (${validation.status}).`,
      data: Object.assign({}, detection.summary, {
        validationStatus: validation.status,
      }),
    });

    emitProgress({
      step: 'nf_extraction',
      status: 'running',
      message: 'Avaliando candidatos de NF com contexto e posicao do campo.',
    });
    const nfRescueDocuments = await buildNfRescueDocuments({
      imagePath,
      preprocess,
      orientationProbe: ocrProbe,
      outputDir,
      fastMode: effectiveFastMode,
    });
    let nfExtraction = await nfExtractorService.extractInvoiceNumber({
      preprocess,
      orientationProbe: ocrProbe,
      validation,
      documents: structuredOcr.documents.concat(nfRescueDocuments),
      fullOcr: structuredOcr.fullOcr,
      regionOcr: structuredOcr.regionOcr,
      fastMode: effectiveFastMode,
    });
    const afterNfExtraction = Date.now();
    emitProgress({
      step: 'nf_extraction',
      status: 'completed',
      message: nfExtraction.nf
        ? `NF escolhida: ${nfExtraction.nf} (confianca ${nfExtraction.confidence}).`
        : 'Nenhum candidato de NF atingiu confianca suficiente.',
      data: {
        nf: nfExtraction.nf,
        confidence: nfExtraction.confidence,
      },
    });

    emitProgress({
      step: 'invoice_lookup',
      status: 'running',
      message: nfExtraction.nf
        ? `Conferindo se a NF extraida existe no banco de ${companyName}.`
        : 'Pulando consulta ao banco porque nenhuma NF foi extraida.',
    });
    let invoiceLookup = await apiService.findInvoiceByNumber(nfExtraction.nf);
    const rerankedCandidate = await resolveCandidateByInvoiceLookup({
      nfExtraction,
      currentLookup: invoiceLookup,
    });
    nfExtraction = rerankedCandidate.nfExtraction;
    invoiceLookup = rerankedCandidate.invoiceLookup;
    emitProgress({
      step: 'invoice_lookup',
      status: 'completed',
      message: !nfExtraction.nf
        ? 'Consulta ao banco nao executada por falta de NF.'
        : invoiceLookup.found
          ? `NF ${nfExtraction.nf} encontrada no banco (${invoiceLookup.mode}).`
          : `NF ${nfExtraction.nf} nao encontrada no banco (${invoiceLookup.mode}).`,
      data: {
        found: invoiceLookup.found,
        mode: invoiceLookup.mode,
        reason: invoiceLookup.reason,
      },
    });

    emitProgress({
      step: 'classification',
      status: 'running',
      message: 'Aplicando a regra de negocio final do canhoto.',
    });
    const classification = receiptClassifierService.classifyReceiptAnalysis({
      validation,
      requiredFields: detection.requiredFields,
      nfExtraction,
      fullOcr: structuredOcr.fullOcr,
      invoiceLookup,
    });
    const diagnostics = buildFailureDiagnostics({
      template,
      validation,
      detection,
      nfExtraction,
      classification,
      invoiceLookup,
    });
    const result = {
      accepted: classification.classification === 'valid',
      nf: nfExtraction.nf,
      confidence: nfExtraction.confidence,
      orientation: selectedOrientation ? selectedOrientation.rotation : 0,
      templateMatched: validation.templateMatched,
      fields: {
        headerDetected: !!(detection.requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] && detection.requiredFields[RECEIPT_FIELD_KEYS.issuerHeader].found),
        dateFieldDetected: !!(detection.requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] && detection.requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].found),
        nfBlockDetected: !!(detection.requiredFields[RECEIPT_FIELD_KEYS.nfe] && detection.requiredFields[RECEIPT_FIELD_KEYS.nfe].found),
        signatureLikelyPresent: diagnostics.summary.signatureLikelyPresent,
        invoiceConfirmedInDb: diagnostics.summary.invoiceConfirmedInDb,
      },
      reasons: classification.reasons.slice(),
      diagnostics: diagnostics.summary,
      debug: {
        selectedVariant: ocrProbe.bestVariantId,
        selectedOrientationId: ocrProbe.bestOrientationId,
        captureProfile: preprocess.captureProfile ? preprocess.captureProfile.id : null,
        fastMode: effectiveFastMode,
        savedImages: [
          template.alignedFilePath,
          template.maskedFilePath,
        ].filter(Boolean),
      },
    };
    const finishedAt = Date.now();
    emitProgress({
      step: 'classification',
      status: 'completed',
      message: `Canhoto classificado como ${classification.classification}.`,
      data: {
        classification: classification.classification,
        businessScore: classification.metrics.businessScore,
      },
    });

    return {
      status: 'stage_10_completed',
      receiptProfile: {
        id: receiptProfile.id,
        company: receiptProfile.company,
      },
      preprocess,
      ocrProbe,
      fullOcr: structuredOcr.fullOcr,
      structuredOcr,
      template,
      validation,
      detection,
      nfExtraction,
      invoiceLookup,
      classification,
      diagnostics,
      result,
      timings: {
        preprocessMs: afterPreprocess - startedAt,
        orientationMs: afterOrientation - afterPreprocess,
        globalAndRegionOcrMs: afterStructuredOcr - afterOrientation,
        detectionMs: afterDetection - afterStructuredOcr,
        nfExtractionMs: afterNfExtraction - afterDetection,
        classificationMs: finishedAt - afterNfExtraction,
        totalMs: finishedAt - startedAt,
      },
    };
  },
};
