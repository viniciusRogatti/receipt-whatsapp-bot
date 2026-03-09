const path = require('path');
const Jimp = require('jimp');
const imagePreprocessService = require('./imagePreprocess.service');
const {
  ANALYSIS_REGION_DEFINITIONS,
} = require('./receiptPipeline/receiptConstants');
const {
  copyFile,
  ensureDir,
} = require('../utils/file');

const CONTRAST_LEVEL = 0.45;
const BINARY_THRESHOLD = 180;
const REGION_COLOR_PALETTE = {
  roi_header: { fill: [59, 130, 246, 32], stroke: [37, 99, 235, 255] },
  roi_date_label: { fill: [52, 211, 153, 34], stroke: [5, 150, 105, 255] },
  roi_nf_block: { fill: [248, 113, 113, 38], stroke: [220, 38, 38, 255] },
  roi_nf_number_line: { fill: [251, 191, 36, 34], stroke: [217, 119, 6, 255] },
  nf_block: { fill: [248, 113, 113, 38], stroke: [220, 38, 38, 255] },
  nf_number_line: { fill: [251, 191, 36, 34], stroke: [217, 119, 6, 255] },
  nf_number_tight: { fill: [34, 197, 94, 30], stroke: [22, 163, 74, 255] },
  nf_block_wide: { fill: [148, 163, 184, 28], stroke: [71, 85, 105, 255] },
  roi_signature: { fill: [99, 102, 241, 18], stroke: [79, 70, 229, 255] },
  best: { fill: [34, 197, 94, 54], stroke: [21, 128, 61, 255] },
};

const persistImage = async (image, filePath) => {
  await ensureDir(path.dirname(filePath));
  await image.writeAsync(filePath);
  return filePath;
};

const setPixelSafe = (image, x, y, rgba) => {
  if (x < 0 || y < 0 || x >= image.bitmap.width || y >= image.bitmap.height) return;
  image.setPixelColor(Jimp.rgbaToInt(rgba[0], rgba[1], rgba[2], rgba[3]), x, y);
};

const drawFilledBorderBox = (image, box, color, thickness = 4) => {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.bitmap.width - 1, Math.floor(box.x + box.width));
  const y1 = Math.min(image.bitmap.height - 1, Math.floor(box.y + box.height));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const isBorder = (
        x - x0 < thickness
        || x1 - x < thickness
        || y - y0 < thickness
        || y1 - y < thickness
      );

      if (isBorder) {
        setPixelSafe(image, x, y, color.stroke);
      } else if (color.fill) {
        setPixelSafe(image, x, y, color.fill);
      }
    }
  }
};

const REGION_DEFINITION_MAP = ANALYSIS_REGION_DEFINITIONS.reduce((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {});

const buildPixelBox = (variant, fractionalBox) => ({
  x: Math.floor(variant.width * fractionalBox.x),
  y: Math.floor(variant.height * fractionalBox.y),
  width: Math.max(2, Math.floor(variant.width * fractionalBox.width)),
  height: Math.max(2, Math.floor(variant.height * fractionalBox.height)),
});

const buildVisualStep = (id, label, description, filePath, image) => ({
  id,
  label,
  description,
  filePath,
  width: image.bitmap.width,
  height: image.bitmap.height,
});

module.exports = {
  async buildArtifacts({ sessionDir, sourceImagePath, preprocess, structuredOcr, nfExtraction }) {
    const debugDir = path.join(sessionDir, 'debug');
    const stepsDir = path.join(debugDir, 'steps');
    const regionsDir = path.join(debugDir, 'regions');

    await Promise.all([
      ensureDir(stepsDir),
      ensureDir(regionsDir),
    ]);

    const sourceExtension = path.extname(sourceImagePath) || '.png';
    const originalStepPath = path.join(stepsDir, `step_original${sourceExtension}`);
    await copyFile(sourceImagePath, originalStepPath);

    const originalImage = await Jimp.read(sourceImagePath);
    const { image: rotatedBaseImage, orientation } = await imagePreprocessService.prepareBaseImage(sourceImagePath);
    const grayscaleImage = rotatedBaseImage.clone().greyscale();
    const contrastImage = rotatedBaseImage.clone().greyscale().normalize().contrast(CONTRAST_LEVEL);
    const binaryImage = imagePreprocessService
      .thresholdImage(contrastImage.clone(), BINARY_THRESHOLD);
    const focusedImage = imagePreprocessService
      .focusDocument(rotatedBaseImage.clone())
      .greyscale()
      .normalize()
      .contrast(CONTRAST_LEVEL);
    const selectedOrientation = preprocess
      && Array.isArray(preprocess.orientationCandidates)
      ? preprocess.orientationCandidates.find((candidate) => candidate.id === (structuredOcr && structuredOcr.orientationId))
      : null;
    const alignedImage = selectedOrientation && selectedOrientation.alignedFilePath
      ? await Jimp.read(selectedOrientation.alignedFilePath)
      : focusedImage.clone();
    const maskedSignatureImage = selectedOrientation && selectedOrientation.maskedFilePath
      ? await Jimp.read(selectedOrientation.maskedFilePath)
      : alignedImage.clone();

    const rotatedStepPath = path.join(stepsDir, 'step_rotated.png');
    const grayscaleStepPath = path.join(stepsDir, 'step_grayscale.png');
    const contrastStepPath = path.join(stepsDir, 'step_contrast.png');
    const binaryStepPath = path.join(stepsDir, 'step_binary.png');
    const focusedStepPath = path.join(stepsDir, 'step_document_focus.png');
    const alignedStepPath = path.join(stepsDir, 'step_aligned.png');
    const maskedSignatureStepPath = path.join(stepsDir, 'step_masked_signature.png');

    await Promise.all([
      persistImage(rotatedBaseImage.clone(), rotatedStepPath),
      persistImage(grayscaleImage.clone(), grayscaleStepPath),
      persistImage(contrastImage.clone(), contrastStepPath),
      persistImage(binaryImage.clone(), binaryStepPath),
      persistImage(focusedImage.clone(), focusedStepPath),
      persistImage(alignedImage.clone(), alignedStepPath),
      persistImage(maskedSignatureImage.clone(), maskedSignatureStepPath),
    ]);

    const visualSteps = [
      buildVisualStep(
        'original',
        'Imagem original',
        'Arquivo original enviado para analise.',
        originalStepPath,
        originalImage,
      ),
      buildVisualStep(
        'rotated',
        'Imagem rotacionada',
        orientation.rotation
          ? `Rotacao aplicada via EXIF: ${orientation.rotation} graus.`
          : 'Sem rotacao adicional necessaria.',
        rotatedStepPath,
        rotatedBaseImage,
      ),
      buildVisualStep(
        'grayscale',
        'Escala de cinza',
        'Remocao de cor para melhorar a leitura dos blocos de texto.',
        grayscaleStepPath,
        grayscaleImage,
      ),
      buildVisualStep(
        'contrast',
        'Contraste ajustado',
        'Realce de contraste usado como base para varias tentativas de OCR.',
        contrastStepPath,
        contrastImage,
      ),
      buildVisualStep(
        'binary',
        'Binarizacao',
        'Versao em preto e branco para testar textos com baixo contraste.',
        binaryStepPath,
        binaryImage,
      ),
      buildVisualStep(
        'document_focus',
        'Foco no documento',
        'Recorte aproximado do canhoto para reduzir fundo e ruido.',
        focusedStepPath,
        focusedImage,
      ),
      buildVisualStep(
        'aligned',
        'Template alinhado',
        'Canhoto recortado e deskewado para encaixar no template fixo da MAR E RIO.',
        alignedStepPath,
        alignedImage,
      ),
      buildVisualStep(
        'masked_signature',
        'Assinatura mascarada',
        'Area central de assinatura removida da imagem de apoio para nao contaminar o OCR principal.',
        maskedSignatureStepPath,
        maskedSignatureImage,
      ),
    ];

    const variantMap = (preprocess.variants || []).reduce((accumulator, variant) => {
      accumulator[variant.id] = variant;
      return accumulator;
    }, {});
    const regionOcrResults = structuredOcr
      && structuredOcr.regionOcr
      && Array.isArray(structuredOcr.regionOcr.results)
      ? structuredOcr.regionOcr.results
      : [];
    const nfRoiResults = nfExtraction
      && nfExtraction.roiOcr
      && Array.isArray(nfExtraction.roiOcr.results)
      ? nfExtraction.roiOcr.results
      : [];
    const groupedByVariant = {};

    regionOcrResults.concat(nfRoiResults).forEach((result) => {
      const sourceVariantId = result.meta && result.meta.sourceVariantId;
      if (!sourceVariantId || !variantMap[sourceVariantId]) return;
      if (!groupedByVariant[sourceVariantId]) groupedByVariant[sourceVariantId] = [];
      groupedByVariant[sourceVariantId].push(result);
    });

    const regionHighlights = [];

    for (const sourceVariantId of Object.keys(groupedByVariant)) {
      const sourceVariant = variantMap[sourceVariantId];
      const sourceImage = await Jimp.read(sourceVariant.filePath);
      const boxes = groupedByVariant[sourceVariantId].map((result) => {
        const regionId = result.meta && (result.meta.requestedRoiId || result.meta.regionId);
        const definition = result.meta && result.meta.regionId ? REGION_DEFINITION_MAP[result.meta.regionId] : null;
        const roiBox = result.meta && result.meta.roiBox ? result.meta.roiBox : null;
        const pixelBox = definition
          ? buildPixelBox(sourceVariant, definition.box)
          : roiBox
            ? buildPixelBox(sourceVariant, roiBox)
            : null;
        return {
          targetId: result.targetId,
          label: result.label,
          regionId,
          sourceVariantId,
          confidence: result.confidence,
          score: result.score,
          textPreview: result.textPreview,
          psm: result.meta && result.meta.psm,
          roiWidth: result.meta && result.meta.roiWidth,
          roiHeight: result.meta && result.meta.roiHeight,
          isBestTarget: nfExtraction
            && nfExtraction.regionOcr
            && result.targetId === nfExtraction.regionOcr.bestTargetId,
          pixelBox,
          filePath: result.filePath,
        };
      }).filter((box) => box.pixelBox);

      boxes.forEach((box) => {
        const palette = box.isBestTarget
          ? REGION_COLOR_PALETTE.best
          : REGION_COLOR_PALETTE[box.regionId] || REGION_COLOR_PALETTE.nfe_box_context;
        drawFilledBorderBox(sourceImage, box.pixelBox, palette, box.isBestTarget ? 6 : 4);
      });

      const annotatedPath = path.join(regionsDir, `${sourceVariantId}__highlight.png`);
      await persistImage(sourceImage, annotatedPath);

      regionHighlights.push({
        sourceVariantId,
        sourceVariantLabel: sourceVariant.label,
        filePath: annotatedPath,
        width: sourceVariant.width,
        height: sourceVariant.height,
        boxes,
      });
    }

    return {
      orientation,
      visualSteps,
      regionHighlights,
    };
  },
};
