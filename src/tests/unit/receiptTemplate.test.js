const assert = require('assert');
const Jimp = require('jimp');
const receiptTemplateService = require('../../services/receiptPipeline/receiptTemplate.service');

const drawBox = (image, x, y, width, height, color) => {
  for (let px = x; px < x + width; px += 1) {
    image.setPixelColor(color, px, y);
    image.setPixelColor(color, px, y + height - 1);
  }

  for (let py = y; py < y + height; py += 1) {
    image.setPixelColor(color, x, py);
    image.setPixelColor(color, x + width - 1, py);
  }
};

const fillBox = (image, x, y, width, height, color) => {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      image.setPixelColor(color, px, py);
    }
  }
};

const drawStroke = (image, x0, y0, x1, y1, color) => {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);

  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const x = Math.round(x0 + ((x1 - x0) * progress));
    const y = Math.round(y0 + ((y1 - y0) * progress));

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const px = x + offsetX;
        const py = y + offsetY;
        if (px >= 0 && px < image.bitmap.width && py >= 0 && py < image.bitmap.height) {
          image.setPixelColor(color, px, py);
        }
      }
    }
  }
};

const hasNonWhitePixel = (image, box) => {
  for (let py = box.y; py < box.y + box.height; py += 1) {
    for (let px = box.x; px < box.x + box.width; px += 1) {
      if (image.getPixelColor(px, py) !== Jimp.rgbaToInt(255, 255, 255, 255)) {
        return true;
      }
    }
  }

  return false;
};

const buildSyntheticReceipt = async () => {
  const white = Jimp.rgbaToInt(255, 255, 255, 255);
  const black = Jimp.rgbaToInt(0, 0, 0, 255);
  const image = new Jimp(1800, 900, white);

  drawBox(image, 130, 280, 1540, 170, black);
  drawBox(image, 130, 280, 1540, 42, black);
  drawBox(image, 130, 322, 190, 128, black);
  drawBox(image, 1410, 280, 260, 170, black);
  fillBox(image, 520, 340, 600, 70, black);
  fillBox(image, 220, 350, 80, 18, black);
  fillBox(image, 1450, 305, 110, 16, black);
  fillBox(image, 1460, 350, 120, 20, black);

  return image;
};

module.exports = () => ([
  {
    name: 'receiptTemplate detecta e normaliza o canhoto horizontal sintetico',
    run: async () => {
      const image = await buildSyntheticReceipt();
      const contour = receiptTemplateService.detectReceiptContour(image);
      const aligned = receiptTemplateService.alignReceiptToTemplate(image);
      const rois = receiptTemplateService.buildTemplateRois(aligned.alignedImage);

      assert.strictEqual(contour.contourDetected, true);
      assert.strictEqual(contour.quadDetected, true);
      assert.ok(contour.geometryScore > 0.5);
      assert.strictEqual(aligned.normalized.width, 1800);
      assert.strictEqual(aligned.normalized.height, Math.round(1800 / 8.9));
      assert.strictEqual(aligned.warp.applied, true);
      assert.strictEqual(aligned.nfAnchor.detected, true);
      assert.ok(rois.some((roi) => roi.id === 'roi_header'));
      assert.ok(rois.some((roi) => roi.id === 'roi_signature'));
    },
  },
  {
    name: 'receiptTemplate mascara a assinatura sem apagar o bloco da NF',
    run: async () => {
      const image = await buildSyntheticReceipt();
      const aligned = receiptTemplateService.alignReceiptToTemplate(image);
      const masked = receiptTemplateService.maskSignatureRegion(aligned.alignedImage.clone());
      const rois = receiptTemplateService.buildTemplateRois(masked);
      const signatureBox = rois.find((roi) => roi.id === 'roi_signature').pixelBox;
      const nfBox = rois.find((roi) => roi.id === 'roi_nf_block').pixelBox;

      const signaturePixel = masked.getPixelColor(signatureBox.x + 10, signatureBox.y + 10);

      assert.strictEqual(signaturePixel, Jimp.rgbaToInt(255, 255, 255, 255));
      assert.strictEqual(hasNonWhitePixel(masked, nfBox), true);
    },
  },
  {
    name: 'receiptTemplate detecta indicio de assinatura no quadro central',
    run: async () => {
      const image = new Jimp(1800, Math.round(1800 / 8.9), Jimp.rgbaToInt(255, 255, 255, 255));
      const rois = receiptTemplateService.buildTemplateRois(image);
      const signatureBox = rois.find((roi) => roi.id === 'roi_signature').pixelBox;
      const black = Jimp.rgbaToInt(0, 0, 0, 255);
      drawStroke(
        image,
        signatureBox.x + 60,
        signatureBox.y + 34,
        signatureBox.x + 280,
        signatureBox.y + 92,
        black,
      );
      drawStroke(
        image,
        signatureBox.x + 280,
        signatureBox.y + 92,
        signatureBox.x + 500,
        signatureBox.y + 42,
        black,
      );
      drawStroke(
        image,
        signatureBox.x + 500,
        signatureBox.y + 42,
        signatureBox.x + 650,
        signatureBox.y + 98,
        black,
      );

      const signature = receiptTemplateService.assessSignaturePresence(image);

      assert.strictEqual(signature.evaluated, true);
      assert.strictEqual(signature.present, true);
      assert.ok(signature.score >= 0.12);
    },
  },
]);
