const imagePreprocessService = require('./imagePreprocess.service');
const receiptDetectorService = require('./receiptDetector.service');
const nfExtractorService = require('./nfExtractor.service');
const receiptClassifierService = require('./receiptClassifier.service');
const apiService = require('./api.service');
const receiptOrientationService = require('./receiptPipeline/receiptOrientation.service');
const receiptStructuredOcrService = require('./receiptPipeline/receiptStructuredOcr.service');
const receiptValidationService = require('./receiptPipeline/receiptValidation.service');
const { RECEIPT_TEMPLATE } = require('./receiptPipeline/receiptConstants');

const toCheckpointStatus = (condition, fallbackCondition = false) => {
  if (condition) return 'passed';
  if (fallbackCondition) return 'fallback';
  return 'failed';
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
  const headerFallbackByDb = !requiredFields.recebemosDeMarERio?.found && !!invoiceLookup.found;
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
      label: 'RECEBEMOS DE MAR E RIO',
      status: toCheckpointStatus(!!requiredFields.recebemosDeMarERio?.found, headerFallbackByDb),
      detail: requiredFields.recebemosDeMarERio?.found
        ? `Cabecalho reconhecido com confianca ${requiredFields.recebemosDeMarERio.confidence}.`
        : headerFallbackByDb
          ? 'Cabecalho coberto ou fraco, mas a NF confirmou a origem MAR E RIO no banco.'
          : 'O cabecalho MAR E RIO nao ficou legivel o bastante para fechamento por OCR.',
      blocksAutomaticApproval: !headerFallbackByDb,
      metrics: requiredFields.recebemosDeMarERio || null,
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
    const afterPreprocess = Date.now();
    emitProgress({
      step: 'preprocess',
      status: 'completed',
      message: `${preprocess.totalVariants} variantes orientadas e preprocessadas foram geradas.`,
      data: {
        totalVariants: preprocess.totalVariants,
      },
    });

    emitProgress({
      step: 'orientation',
      status: 'running',
      message: 'Detectando a melhor orientacao do documento com base nos campos estruturais.',
    });
    const ocrProbe = await receiptOrientationService.selectBestOrientation({
      preprocess,
      fastMode,
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
    const globalOcrResult = await receiptStructuredOcrService.runGlobalSupportOcr({
      preprocess,
      orientationProbe: ocrProbe,
      fastMode,
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
      fastMode,
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
      message: 'Localizando DATA DE RECEBIMENTO, RECEBEMOS DA MAR E RIO e o campo NF-e.',
    });
    const detection = await receiptDetectorService.detectRequiredFields({
      documents: structuredOcr.documents,
      fullOcr: structuredOcr.fullOcr,
      regionOcr: structuredOcr.regionOcr,
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
    const nfExtraction = await nfExtractorService.extractInvoiceNumber({
      preprocess,
      orientationProbe: ocrProbe,
      validation,
      documents: structuredOcr.documents,
      fullOcr: structuredOcr.fullOcr,
      regionOcr: structuredOcr.regionOcr,
      fastMode,
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
        ? 'Conferindo se a NF extraida existe no banco da MAR E RIO.'
        : 'Pulando consulta ao banco porque nenhuma NF foi extraida.',
    });
    const invoiceLookup = await apiService.findInvoiceByNumber(nfExtraction.nf);
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
        headerDetected: !!(detection.requiredFields.recebemosDeMarERio && detection.requiredFields.recebemosDeMarERio.found),
        dateFieldDetected: !!(detection.requiredFields.dataRecebimento && detection.requiredFields.dataRecebimento.found),
        nfBlockDetected: !!(detection.requiredFields.nfe && detection.requiredFields.nfe.found),
        signatureLikelyPresent: diagnostics.summary.signatureLikelyPresent,
        invoiceConfirmedInDb: diagnostics.summary.invoiceConfirmedInDb,
      },
      reasons: classification.reasons.slice(),
      diagnostics: diagnostics.summary,
      debug: {
        selectedVariant: ocrProbe.bestVariantId,
        selectedOrientationId: ocrProbe.bestOrientationId,
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
