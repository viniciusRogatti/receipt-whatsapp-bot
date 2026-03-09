const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const ExifParser = require('exif-parser');
const logger = require('../utils/logger');
const { ensureDir } = require('../utils/file');
const receiptTemplateService = require('./receiptPipeline/receiptTemplate.service');

const MIN_LONGEST_EDGE = 1400;
const MAX_LONGEST_EDGE = 1800;
const FAST_MIN_LONGEST_EDGE = 700;
const FAST_MAX_LONGEST_EDGE = 1000;
const PNG_MIME = Jimp.MIME_PNG;
const RECEIPT_COMPONENT_MAX_EDGE = 720;
const RECEIPT_COMPONENT_LUMINANCE = 172;

const SHARPEN_KERNEL = [
  [0, -1, 0],
  [-1, 5, -1],
  [0, -1, 0],
];
const CLAHE_TILE_SIZE = 64;
const CLAHE_CLIP_LIMIT = 2.2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const ORIENTATION_TO_ROTATION = {
  3: 180,
  6: 90,
  8: -90,
};

const ORIENTATION_CANDIDATES = [
  { id: 'upright', label: 'Orientacao original', rotation: 0 },
  { id: 'rotate_right', label: 'Orientacao 90 graus', rotation: 90 },
  { id: 'rotate_left', label: 'Orientacao -90 graus', rotation: -90 },
  { id: 'upside_down', label: 'Orientacao 180 graus', rotation: 180 },
];

const VARIANT_PROFILES = [
  {
    id: 'document_gray',
    label: 'Documento em cinza',
    ocrProbeCandidate: true,
    operations: ['document_focus', 'greyscale', 'normalize', 'adaptive_contrast', 'brightness_0.03', 'contrast_0.24'],
    apply: (image) => adaptiveContrastNormalize(image.greyscale().normalize()).brightness(0.03).contrast(0.24),
  },
  {
    id: 'document_binary',
    label: 'Documento binarizado',
    ocrProbeCandidate: true,
    operations: ['document_focus', 'greyscale', 'normalize', 'adaptive_contrast', 'blur_1', 'contrast_0.42', 'threshold_168'],
    apply: (image) => thresholdImage(
      adaptiveContrastNormalize(image.greyscale().normalize()).blur(1).contrast(0.42),
      168,
    ),
  },
  {
    id: 'document_sharp',
    label: 'Documento com nitidez reforcada',
    ocrProbeCandidate: false,
    operations: ['document_focus', 'greyscale', 'normalize', 'adaptive_contrast', 'contrast_0.24', 'sharpen_kernel'],
    apply: (image) => adaptiveContrastNormalize(image.greyscale().normalize()).contrast(0.24).convolute(SHARPEN_KERNEL),
  },
];

const thresholdImage = (image, threshold = 150) => {
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function scanPixel(x, y, idx) {
    const red = this.bitmap.data[idx + 0];
    const green = this.bitmap.data[idx + 1];
    const blue = this.bitmap.data[idx + 2];
    const luminance = Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114));
    const value = luminance >= threshold ? 255 : 0;
    this.bitmap.data[idx + 0] = value;
    this.bitmap.data[idx + 1] = value;
    this.bitmap.data[idx + 2] = value;
  });

  return image;
};

const adaptiveThresholdImage = (image, radius = 10, offset = 8) => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const grayscale = new Uint8Array(width * height);
  const integral = new Uint32Array((width + 1) * (height + 1));

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    grayscale[(y * width) + x] = this.bitmap.data[idx];
  });

  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += grayscale[((y - 1) * width) + (x - 1)];
      integral[(y * (width + 1)) + x] = integral[((y - 1) * (width + 1)) + x] + rowSum;
    }
  }

  image.scan(0, 0, width, height, function scanThreshold(x, y, idx) {
    const left = Math.max(0, x - radius);
    const top = Math.max(0, y - radius);
    const right = Math.min(width - 1, x + radius);
    const bottom = Math.min(height - 1, y + radius);
    const area = Math.max(1, (right - left + 1) * (bottom - top + 1));
    const sum = (
      integral[((bottom + 1) * (width + 1)) + (right + 1)]
      - integral[(top * (width + 1)) + (right + 1)]
      - integral[((bottom + 1) * (width + 1)) + left]
      + integral[(top * (width + 1)) + left]
    );
    const localMean = sum / area;
    const value = grayscale[(y * width) + x] > (localMean - offset) ? 255 : 0;

    this.bitmap.data[idx + 0] = value;
    this.bitmap.data[idx + 1] = value;
    this.bitmap.data[idx + 2] = value;
  });

  return image;
};

const adaptiveContrastNormalize = (image, {
  tileSize = CLAHE_TILE_SIZE,
  clipLimit = CLAHE_CLIP_LIMIT,
} = {}) => {
  const prepared = image.clone();
  const width = prepared.bitmap.width;
  const height = prepared.bitmap.height;
  if (!width || !height) return prepared;

  const tilesX = Math.max(1, Math.ceil(width / tileSize));
  const tilesY = Math.max(1, Math.ceil(height / tileSize));
  const luts = Array.from({ length: tilesY }, () => Array.from({ length: tilesX }, () => new Uint8Array(256)));
  const grayscale = new Uint8Array(width * height);

  prepared.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const luminance = Math.round(
      (this.bitmap.data[idx + 0] * 0.299)
      + (this.bitmap.data[idx + 1] * 0.587)
      + (this.bitmap.data[idx + 2] * 0.114),
    );
    grayscale[(y * width) + x] = luminance;
  });

  for (let tileY = 0; tileY < tilesY; tileY += 1) {
    for (let tileX = 0; tileX < tilesX; tileX += 1) {
      const startX = tileX * tileSize;
      const startY = tileY * tileSize;
      const endX = Math.min(width, startX + tileSize);
      const endY = Math.min(height, startY + tileSize);
      const hist = new Uint32Array(256);
      const pixelCount = Math.max(1, (endX - startX) * (endY - startY));
      const clipThreshold = Math.max(1, Math.floor((pixelCount / 256) * clipLimit));

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          hist[grayscale[(y * width) + x]] += 1;
        }
      }

      let excess = 0;
      for (let idx = 0; idx < hist.length; idx += 1) {
        if (hist[idx] > clipThreshold) {
          excess += hist[idx] - clipThreshold;
          hist[idx] = clipThreshold;
        }
      }

      const redistributed = Math.floor(excess / hist.length);
      const remainder = excess % hist.length;
      for (let idx = 0; idx < hist.length; idx += 1) {
        hist[idx] += redistributed + (idx < remainder ? 1 : 0);
      }

      let cdf = 0;
      let cdfMin = -1;
      for (let idx = 0; idx < hist.length; idx += 1) {
        cdf += hist[idx];
        if (cdfMin < 0 && hist[idx] > 0) cdfMin = cdf;
        const normalized = pixelCount === cdfMin
          ? idx
          : Math.round(((cdf - cdfMin) / Math.max(1, pixelCount - cdfMin)) * 255);
        luts[tileY][tileX][idx] = clamp(normalized, 0, 255);
      }
    }
  }

  prepared.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const value = grayscale[(y * width) + x];
    const tilePosX = ((x + 0.5) / tileSize) - 0.5;
    const tilePosY = ((y + 0.5) / tileSize) - 0.5;
    const tileX0 = clamp(Math.floor(tilePosX), 0, tilesX - 1);
    const tileY0 = clamp(Math.floor(tilePosY), 0, tilesY - 1);
    const tileX1 = clamp(tileX0 + 1, 0, tilesX - 1);
    const tileY1 = clamp(tileY0 + 1, 0, tilesY - 1);
    const tx = clamp(tilePosX - tileX0, 0, 1);
    const ty = clamp(tilePosY - tileY0, 0, 1);
    const lut00 = luts[tileY0][tileX0][value];
    const lut10 = luts[tileY0][tileX1][value];
    const lut01 = luts[tileY1][tileX0][value];
    const lut11 = luts[tileY1][tileX1][value];
    const top = (lut00 * (1 - tx)) + (lut10 * tx);
    const bottom = (lut01 * (1 - tx)) + (lut11 * tx);
    const mapped = Math.round((top * (1 - ty)) + (bottom * ty));

    this.bitmap.data[idx + 0] = mapped;
    this.bitmap.data[idx + 1] = mapped;
    this.bitmap.data[idx + 2] = mapped;
  });

  return prepared;
};

const morphologyPass = (image, mode = 'dilate') => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const source = Buffer.from(image.bitmap.data);

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    let selected = mode === 'dilate' ? 0 : 255;

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
        const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
        const sampleIndex = ((sampleY * width) + sampleX) * 4;
        const luminance = source[sampleIndex];
        if (mode === 'dilate') {
          if (luminance < 255) {
            selected = 0;
            offsetY = 2;
            break;
          }
        } else if (luminance > 0) {
          selected = 255;
          offsetY = 2;
          break;
        } else {
          selected = 0;
        }
      }
    }

    this.bitmap.data[idx + 0] = selected;
    this.bitmap.data[idx + 1] = selected;
    this.bitmap.data[idx + 2] = selected;
  });

  return image;
};

const morphologyClose = (image) => morphologyPass(morphologyPass(image, 'dilate'), 'erode');

const sharpenLight = (image) => image.convolute(SHARPEN_KERNEL);

const getLuminanceAt = (bitmap, idx) => Math.round(
  (bitmap.data[idx + 0] * 0.299)
  + (bitmap.data[idx + 1] * 0.587)
  + (bitmap.data[idx + 2] * 0.114),
);

const findDominantBand = (counts, threshold) => {
  let best = null;
  let start = null;

  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= threshold) {
      if (start === null) start = index;
      continue;
    }

    if (start === null) continue;
    const end = index - 1;
    const length = end - start + 1;
    if (!best || length > best.length) {
      best = { start, end, length };
    }
    start = null;
  }

  if (start !== null) {
    const end = counts.length - 1;
    const length = end - start + 1;
    if (!best || length > best.length) {
      best = { start, end, length };
    }
  }

  return best;
};

const scaleDownForProbe = (image, maxEdge = RECEIPT_COMPONENT_MAX_EDGE) => {
  const probe = image.clone();
  const longestEdge = Math.max(probe.bitmap.width, probe.bitmap.height);

  if (longestEdge > maxEdge) {
    probe.scale(maxEdge / longestEdge);
  }

  return probe;
};

const mapBoundsToSource = (sourceImage, probeImage, bounds) => {
  if (!bounds) return null;

  const scaleX = sourceImage.bitmap.width / Math.max(1, probeImage.bitmap.width);
  const scaleY = sourceImage.bitmap.height / Math.max(1, probeImage.bitmap.height);
  const x = Math.max(0, Math.floor(bounds.x * scaleX));
  const y = Math.max(0, Math.floor(bounds.y * scaleY));
  const width = Math.min(
    sourceImage.bitmap.width - x,
    Math.max(2, Math.ceil(bounds.width * scaleX)),
  );
  const height = Math.min(
    sourceImage.bitmap.height - y,
    Math.max(2, Math.ceil(bounds.height * scaleY)),
  );

  return { x, y, width, height };
};

const expandBounds = (image, bounds, paddingXRatio = 0.05, paddingYRatio = 0.16) => {
  if (!bounds) return null;

  const isHorizontalStrip = bounds.width >= bounds.height;
  const shortEdge = Math.max(1, Math.min(bounds.width, bounds.height));
  const longAxisPadding = Math.floor(shortEdge * 1.6);
  const paddingX = isHorizontalStrip
    ? Math.max(12, Math.floor(bounds.width * paddingXRatio), longAxisPadding)
    : Math.max(10, Math.floor(bounds.width * paddingXRatio), Math.floor(shortEdge * 0.2));
  const paddingY = isHorizontalStrip
    ? Math.max(10, Math.floor(bounds.height * paddingYRatio), Math.floor(shortEdge * 0.2))
    : Math.max(12, Math.floor(bounds.height * paddingYRatio), longAxisPadding);
  const x = Math.max(0, bounds.x - paddingX);
  const y = Math.max(0, bounds.y - paddingY);
  const width = Math.min(image.bitmap.width - x, bounds.width + (paddingX * 2));
  const height = Math.min(image.bitmap.height - y, bounds.height + (paddingY * 2));

  return { x, y, width, height };
};

const findReceiptComponentBounds = (image, luminanceThreshold = RECEIPT_COMPONENT_LUMINANCE) => {
  const probe = scaleDownForProbe(
    image.clone().greyscale().normalize().brightness(0.04).contrast(0.25),
  );
  const width = probe.bitmap.width;
  const height = probe.bitmap.height;
  const totalPixels = width * height;
  const mask = new Uint8Array(totalPixels);
  const visited = new Uint8Array(totalPixels);
  const stack = [];
  let bestComponent = null;

  probe.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const pixelIndex = (y * width) + x;
    mask[pixelIndex] = getLuminanceAt(this.bitmap, idx) >= luminanceThreshold ? 1 : 0;
  });

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    if (!mask[pixelIndex] || visited[pixelIndex]) continue;

    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    stack.push(pixelIndex);
    visited[pixelIndex] = 1;

    while (stack.length) {
      const current = stack.pop();
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;

          const nextIndex = (nextY * width) + nextX;
          if (!mask[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          stack.push(nextIndex);
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const boundsArea = componentWidth * componentHeight;
    const areaRatio = area / Math.max(1, totalPixels);
    const rectangularity = area / Math.max(1, boundsArea);
    const longestEdge = Math.max(componentWidth, componentHeight);
    const shortestEdge = Math.max(1, Math.min(componentWidth, componentHeight));
    const aspectRatio = longestEdge / shortestEdge;

    if (areaRatio < 0.006) continue;
    if (componentWidth < Math.max(24, Math.floor(width * 0.08))) continue;
    if (componentHeight < Math.max(18, Math.floor(height * 0.03))) continue;
    if (rectangularity < 0.64) continue;
    if (aspectRatio < 2.4) continue;

    const elongatedBonus = aspectRatio >= 6
      ? 3
      : aspectRatio >= 4
        ? 2.2
        : 1.6;
    const score = area
      * aspectRatio
      * aspectRatio
      * elongatedBonus
      * (0.6 + (rectangularity * rectangularity * 2.2));

    if (!bestComponent || score > bestComponent.score) {
      bestComponent = {
        score,
        x: minX,
        y: minY,
        width: componentWidth,
        height: componentHeight,
      };
    }
  }

  if (!bestComponent) return null;

  return expandBounds(
    image,
    mapBoundsToSource(image, probe, bestComponent),
    0.06,
    0.2,
  );
};

const findReceiptBandBounds = (image, luminanceThreshold = RECEIPT_COMPONENT_LUMINANCE) => {
  const probe = scaleDownForProbe(
    image.clone().greyscale().normalize().contrast(0.2),
  );
  const width = probe.bitmap.width;
  const height = probe.bitmap.height;
  const rowCounts = new Array(height).fill(0);
  const columnCounts = new Array(width).fill(0);

  probe.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    if (getLuminanceAt(this.bitmap, idx) < luminanceThreshold) return;
    rowCounts[y] += 1;
    columnCounts[x] += 1;
  });

  const horizontalBand = findDominantBand(
    rowCounts,
    Math.max(20, Math.floor(width * 0.28)),
  );
  const verticalBand = findDominantBand(
    columnCounts,
    Math.max(20, Math.floor(height * 0.28)),
  );

  const candidates = [];

  if (horizontalBand && horizontalBand.length >= Math.max(18, Math.floor(height * 0.06))) {
    const horizontalColumns = new Array(width).fill(0);
    for (let y = horizontalBand.start; y <= horizontalBand.end; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = ((y * width) + x) * 4;
        if (probe.bitmap.data[idx] >= luminanceThreshold) horizontalColumns[x] += 1;
      }
    }
    const columnThreshold = Math.max(10, Math.floor(horizontalBand.length * 0.32));
    const left = horizontalColumns.findIndex((count) => count >= columnThreshold);
    let right = -1;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (horizontalColumns[x] >= columnThreshold) {
        right = x;
        break;
      }
    }

    if (left >= 0 && right >= left) {
      candidates.push({
        x: left,
        y: horizontalBand.start,
        width: right - left + 1,
        height: horizontalBand.length,
      });
    }
  }

  if (verticalBand && verticalBand.length >= Math.max(18, Math.floor(width * 0.06))) {
    const verticalRows = new Array(height).fill(0);
    for (let x = verticalBand.start; x <= verticalBand.end; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const idx = ((y * width) + x) * 4;
        if (probe.bitmap.data[idx] >= luminanceThreshold) verticalRows[y] += 1;
      }
    }
    const rowThreshold = Math.max(10, Math.floor(verticalBand.length * 0.32));
    const top = verticalRows.findIndex((count) => count >= rowThreshold);
    let bottom = -1;
    for (let y = height - 1; y >= 0; y -= 1) {
      if (verticalRows[y] >= rowThreshold) {
        bottom = y;
        break;
      }
    }

    if (top >= 0 && bottom >= top) {
      candidates.push({
        x: verticalBand.start,
        y: top,
        width: verticalBand.length,
        height: bottom - top + 1,
      });
    }
  }

  const ranked = candidates
    .map((candidate) => {
      const areaRatio = (candidate.width * candidate.height) / Math.max(1, width * height);
      const aspectRatio = Math.max(candidate.width, candidate.height) / Math.max(1, Math.min(candidate.width, candidate.height));
      const rectangularity = areaRatio * aspectRatio;
      return Object.assign({}, candidate, {
        score: rectangularity * aspectRatio,
      });
    })
    .filter((candidate) => (
      Math.max(candidate.width, candidate.height) / Math.max(1, Math.min(candidate.width, candidate.height)) >= 2.8
    ))
    .sort((left, right) => right.score - left.score);

  if (!ranked.length) return null;

  return expandBounds(
    image,
    mapBoundsToSource(image, probe, ranked[0]),
    0.04,
    0.1,
  );
};

const findDocumentBounds = (image, luminanceThreshold = 168) => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const rowCounts = new Array(height).fill(0);
  const columnCounts = new Array(width).fill(0);

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const luminance = getLuminanceAt(this.bitmap, idx);

    if (luminance >= luminanceThreshold) {
      rowCounts[y] += 1;
      columnCounts[x] += 1;
    }
  });

  const minBrightPixelsPerRow = Math.max(12, Math.floor(width * 0.12));
  const minBrightPixelsPerColumn = Math.max(12, Math.floor(height * 0.08));
  const top = rowCounts.findIndex((count) => count >= minBrightPixelsPerRow);
  const left = columnCounts.findIndex((count) => count >= minBrightPixelsPerColumn);
  let bottom = -1;
  let right = -1;

  for (let row = height - 1; row >= 0; row -= 1) {
    if (rowCounts[row] >= minBrightPixelsPerRow) {
      bottom = row;
      break;
    }
  }

  for (let column = width - 1; column >= 0; column -= 1) {
    if (columnCounts[column] >= minBrightPixelsPerColumn) {
      right = column;
      break;
    }
  }

  if (top < 0 || left < 0 || bottom < top || right < left) {
    return null;
  }

  const croppedWidth = right - left + 1;
  const croppedHeight = bottom - top + 1;
  const areaRatio = (croppedWidth * croppedHeight) / Math.max(1, width * height);

  if (areaRatio < 0.03) {
    return null;
  }

  const paddingX = Math.max(8, Math.floor(croppedWidth * 0.03));
  const paddingY = Math.max(8, Math.floor(croppedHeight * 0.12));

  return {
    x: Math.max(0, left - paddingX),
    y: Math.max(0, top - paddingY),
    width: Math.min(width - Math.max(0, left - paddingX), croppedWidth + (paddingX * 2)),
    height: Math.min(height - Math.max(0, top - paddingY), croppedHeight + (paddingY * 2)),
  };
};

const focusDocument = (image) => {
  const componentBounds = findReceiptComponentBounds(image);
  if (componentBounds) {
    return image.crop(
      componentBounds.x,
      componentBounds.y,
      componentBounds.width,
      componentBounds.height,
    );
  }

  const probe = image.clone().greyscale().normalize().contrast(0.25);
  const bounds = findDocumentBounds(probe);

  if (!bounds) return image;
  return image.crop(bounds.x, bounds.y, bounds.width, bounds.height);
};

const normalizeLongestEdge = (image, {
  minEdge = MIN_LONGEST_EDGE,
  maxEdge = MAX_LONGEST_EDGE,
} = {}) => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const longestEdge = Math.max(width, height);

  if (!longestEdge) return image;

  if (longestEdge < minEdge) {
    image.scale(minEdge / longestEdge);
    return image;
  }

  if (longestEdge > maxEdge) {
    image.scale(maxEdge / longestEdge);
  }

  return image;
};

const detectExifRotation = (imagePath) => {
  try {
    const buffer = fs.readFileSync(imagePath);
    const parsedExif = ExifParser.create(buffer).parse();
    const orientation = parsedExif && parsedExif.tags ? parsedExif.tags.Orientation || null : null;
    const rotation = ORIENTATION_TO_ROTATION[orientation] || 0;
    return {
      orientation,
      rotation,
      source: rotation ? 'exif' : 'none',
    };
  } catch (error) {
    logger.debug('Nao foi possivel ler EXIF da imagem.', {
      imagePath,
      error: error.message,
    });

    return {
      orientation: null,
      rotation: 0,
      source: 'unavailable',
    };
  }
};

const prepareBaseImage = async (imagePath, profile = 'debug') => {
  const image = await Jimp.read(imagePath);
  const orientation = detectExifRotation(imagePath);
  const edgeConfig = profile === 'local_fast'
    ? { minEdge: FAST_MIN_LONGEST_EDGE, maxEdge: FAST_MAX_LONGEST_EDGE }
    : { minEdge: MIN_LONGEST_EDGE, maxEdge: MAX_LONGEST_EDGE };

  if (orientation.rotation) {
    image.rotate(orientation.rotation);
  }

  normalizeLongestEdge(image, edgeConfig);

  return {
    image,
    orientation,
  };
};

const persistVariant = async (variantImage, variantId, variantsDir) => {
  const targetPath = path.join(variantsDir, `${variantId}.png`);
  await variantImage.getBufferAsync(PNG_MIME).then((buffer) => fs.promises.writeFile(targetPath, buffer));
  return targetPath;
};

const clampRegion = (value, min, max) => Math.max(min, Math.min(max, value));

const buildOrientedBase = (baseImage, rotation) => {
  const oriented = baseImage.clone();

  if (rotation) {
    oriented.rotate(rotation);
  }

  const alignment = receiptTemplateService.alignReceiptToTemplate(oriented);
  const alignedImage = alignment.alignedImage;
  const maskedImage = receiptTemplateService.maskSignatureRegion(alignedImage.clone());

  return {
    alignedImage,
    maskedImage,
    alignment,
  };
};

const resolveOrientationCandidates = (baseImage, profile) => {
  if (profile !== 'local_fast') {
    return ORIENTATION_CANDIDATES;
  }

  const isLandscape = baseImage.bitmap.width >= baseImage.bitmap.height;
  return isLandscape
    ? ORIENTATION_CANDIDATES.filter((candidate) => (
      candidate.id === 'upright' || candidate.id === 'upside_down'
    ))
    : ORIENTATION_CANDIDATES.filter((candidate) => (
      candidate.id === 'rotate_right' || candidate.id === 'rotate_left'
    ));
};

module.exports = {
  thresholdImage,
  adaptiveThresholdImage,
  adaptiveContrastNormalize,
  morphologyClose,
  sharpenLight,
  normalizeLongestEdge,
  findDocumentBounds,
  findReceiptBandBounds,
  findReceiptComponentBounds,
  focusDocument,
  prepareBaseImage,

  async preprocessImage({ imagePath, outputDir, profile = 'debug' }) {
    await ensureDir(outputDir);
    const variantsDir = path.join(outputDir, 'variants');
    await ensureDir(variantsDir);

    const { image: baseImage, orientation } = await prepareBaseImage(imagePath, profile);
    const variants = [];
    const orientationCandidates = [];
    const edgeConfig = profile === 'local_fast'
      ? { minEdge: FAST_MIN_LONGEST_EDGE, maxEdge: FAST_MAX_LONGEST_EDGE }
      : { minEdge: MIN_LONGEST_EDGE, maxEdge: MAX_LONGEST_EDGE };
    const persistIntermediate = profile !== 'local_fast';

    const activeOrientationCandidates = resolveOrientationCandidates(baseImage, profile);

    for (const orientationDefinition of activeOrientationCandidates) {
      const orientedBase = buildOrientedBase(baseImage, orientationDefinition.rotation);
      const alignedBase = orientedBase.alignedImage;
      const maskedBase = orientedBase.maskedImage;
      const orientationVariantIds = [];
      const alignedFilePath = persistIntermediate
        ? await persistVariant(
          alignedBase.clone(),
          `${orientationDefinition.id}__aligned`,
          variantsDir,
        )
        : null;
      const maskedFilePath = persistIntermediate
        ? await persistVariant(
          maskedBase.clone(),
          `${orientationDefinition.id}__masked`,
          variantsDir,
        )
        : null;

      for (const variantProfile of VARIANT_PROFILES) {
        if (profile !== 'debug' && variantProfile.id === 'document_sharp') {
          continue;
        }

        const variantImage = variantProfile.apply(maskedBase.clone());
        normalizeLongestEdge(variantImage, edgeConfig);
        const variantId = `${orientationDefinition.id}__${variantProfile.id}`;
        const filePath = await persistVariant(variantImage, variantId, variantsDir);

        variants.push({
          id: variantId,
          label: `${orientationDefinition.label} - ${variantProfile.label}`,
          filePath,
          width: variantImage.bitmap.width,
          height: variantImage.bitmap.height,
          ocrProbeCandidate: variantProfile.ocrProbeCandidate !== false,
          orientationId: orientationDefinition.id,
          rotation: orientationDefinition.rotation,
          profileId: variantProfile.id,
          operations: [
            orientation.rotation ? `rotate_exif_${orientation.rotation}` : 'rotate_exif_0',
            orientationDefinition.rotation ? `rotate_${orientationDefinition.rotation}` : 'rotate_0',
            'template_align',
            'mask_signature',
            ...variantProfile.operations,
          ],
          alignment: {
            contourDetected: orientedBase.alignment.contour.contourDetected,
            contourBounds: orientedBase.alignment.contour.bounds,
            contourCorners: orientedBase.alignment.contour.corners,
            contourScore: orientedBase.alignment.contour.geometryScore,
            templateMatched: orientedBase.alignment.templateMatched,
            deskewAngle: orientedBase.alignment.deskew.angle,
            warpApplied: orientedBase.alignment.warp.applied,
            nfAnchor: orientedBase.alignment.nfAnchor,
            signatureCheck: orientedBase.alignment.signatureCheck,
            normalizedWidth: orientedBase.alignment.normalized.width,
            normalizedHeight: orientedBase.alignment.normalized.height,
          },
          alignedFilePath,
          maskedFilePath,
        });
        orientationVariantIds.push(variantId);
      }

      orientationCandidates.push({
        id: orientationDefinition.id,
        label: orientationDefinition.label,
        rotation: orientationDefinition.rotation,
        variantIds: orientationVariantIds,
        alignedFilePath,
        maskedFilePath,
        width: alignedBase.bitmap.width,
        height: alignedBase.bitmap.height,
        alignment: {
          contourDetected: orientedBase.alignment.contour.contourDetected,
          contourBounds: orientedBase.alignment.contour.bounds,
          contourCorners: orientedBase.alignment.contour.corners,
          contourScore: orientedBase.alignment.contour.geometryScore,
          templateMatched: orientedBase.alignment.templateMatched,
          deskewAngle: orientedBase.alignment.deskew.angle,
          deskewScore: orientedBase.alignment.deskew.score,
          warpApplied: orientedBase.alignment.warp.applied,
          nfAnchor: orientedBase.alignment.nfAnchor,
          signatureCheck: orientedBase.alignment.signatureCheck,
          normalizedWidth: orientedBase.alignment.normalized.width,
          normalizedHeight: orientedBase.alignment.normalized.height,
          geometryScore: orientedBase.alignment.geometryScore,
        },
      });
    }

    logger.info('Variantes preprocessadas geradas.', {
      imagePath,
      profile,
      totalVariants: variants.length,
      variantsDir,
    });

    return {
      outputDir,
      variantsDir,
      profile,
      orientation,
      orientationCandidates,
      totalVariants: variants.length,
      ocrProbeCandidates: variants.filter((variant) => variant.ocrProbeCandidate),
      variants,
    };
  },

  async generateRegionVariants({
    sourceVariant,
    outputDir,
    regionDefinitions = [],
    transform = null,
    variantSuffix = null,
    edgeConfig = null,
  }) {
    if (!sourceVariant || !sourceVariant.filePath) return [];

    await ensureDir(outputDir);
    const sourceImage = await Jimp.read(sourceVariant.filePath);
    const regions = [];

    for (const regionDefinition of regionDefinitions) {
      const x = clampRegion(
        Math.floor(sourceImage.bitmap.width * regionDefinition.box.x),
        0,
        Math.max(0, sourceImage.bitmap.width - 2),
      );
      const y = clampRegion(
        Math.floor(sourceImage.bitmap.height * regionDefinition.box.y),
        0,
        Math.max(0, sourceImage.bitmap.height - 2),
      );
      const width = clampRegion(
        Math.floor(sourceImage.bitmap.width * regionDefinition.box.width),
        2,
        sourceImage.bitmap.width - x,
      );
      const height = clampRegion(
        Math.floor(sourceImage.bitmap.height * regionDefinition.box.height),
        2,
        sourceImage.bitmap.height - y,
      );

      let regionImage = sourceImage.clone().crop(x, y, width, height);
      if (typeof transform === 'function') {
        const transformed = await Promise.resolve(transform(regionImage.clone(), {
          x,
          y,
          width,
          height,
          sourceVariant,
          regionDefinition,
        }));
        if (transformed) regionImage = transformed;
      }
      if (edgeConfig !== false) {
        normalizeLongestEdge(regionImage, edgeConfig || undefined);
      }

      const variantId = variantSuffix
        ? `${sourceVariant.id}__${regionDefinition.id}__${variantSuffix}`
        : `${sourceVariant.id}__${regionDefinition.id}`;
      const filePath = await persistVariant(
        regionImage,
        variantId,
        outputDir,
      );

      regions.push({
        id: variantId,
        label: regionDefinition.label,
        filePath,
        sourceVariantId: sourceVariant.id,
        width: regionImage.bitmap.width,
        height: regionImage.bitmap.height,
        box: regionDefinition.box,
        sourceType: 'region',
        meta: {
          regionId: regionDefinition.id,
          regionLabel: regionDefinition.label,
          fieldKeys: regionDefinition.fieldKeys || [],
          sourceVariantId: sourceVariant.id,
          variantProfileId: sourceVariant.profileId,
          orientationId: sourceVariant.orientationId,
          variantSuffix,
        },
      });
    }

    return regions;
  },
};
