const Jimp = require('jimp');
const {
  RECEIPT_FIELD_KEYS,
} = require('../../config/receiptProfiles');
const {
  RECEIPT_TEMPLATE,
  TEMPLATE_ROI_DEFINITIONS,
} = require('./receiptConstants');

const DEFAULT_BRIGHTNESS_THRESHOLD = 168;
const DEFAULT_DARKNESS_THRESHOLD = 162;
const DEFAULT_COMPONENT_BRIGHTNESS_THRESHOLD = 172;
const DEFAULT_DESKEW_ANGLES = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const MAX_PROBE_EDGE = 960;
const SECONDARY_TRIM_MIN_AREA_RATIO = 0.8;
const RECEIPT_BAND_PADDING_X_RATIO = 0.08;
const RECEIPT_BAND_PADDING_Y_RATIO = 0.12;
const RECEIPT_DOCUMENT_PADDING_X_RATIO = 0.06;
const SIGNATURE_DARK_RATIO_ALERT = 0.72;
const WARP_OUTPUT_WIDTH = RECEIPT_TEMPLATE.standardWidth;
const WARP_OUTPUT_HEIGHT = Math.max(
  120,
  Math.round(RECEIPT_TEMPLATE.standardWidth / Math.max(RECEIPT_TEMPLATE.aspectRatio, 1)),
);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getLuminanceAt = (bitmap, idx) => Math.round(
  (bitmap.data[idx + 0] * 0.299)
  + (bitmap.data[idx + 1] * 0.587)
  + (bitmap.data[idx + 2] * 0.114),
);

const scaleDownForProbe = (image, maxEdge = MAX_PROBE_EDGE) => {
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

const mapPointToSource = (sourceImage, probeImage, point) => ({
  x: Number((point.x * (sourceImage.bitmap.width / Math.max(1, probeImage.bitmap.width))).toFixed(2)),
  y: Number((point.y * (sourceImage.bitmap.height / Math.max(1, probeImage.bitmap.height))).toFixed(2)),
});

const mapBoundsToProbe = (sourceImage, probeImage, bounds) => {
  if (!bounds) return null;

  const scaleX = probeImage.bitmap.width / Math.max(1, sourceImage.bitmap.width);
  const scaleY = probeImage.bitmap.height / Math.max(1, sourceImage.bitmap.height);

  return {
    x: clamp(Math.floor(bounds.x * scaleX), 0, Math.max(0, probeImage.bitmap.width - 2)),
    y: clamp(Math.floor(bounds.y * scaleY), 0, Math.max(0, probeImage.bitmap.height - 2)),
    width: clamp(Math.ceil(bounds.width * scaleX), 2, probeImage.bitmap.width),
    height: clamp(Math.ceil(bounds.height * scaleY), 2, probeImage.bitmap.height),
  };
};

const expandBounds = (image, bounds, paddingXRatio = 0.04, paddingYRatio = 0.1) => {
  if (!bounds) return null;

  const paddingX = Math.max(8, Math.floor(bounds.width * paddingXRatio));
  const paddingY = Math.max(8, Math.floor(bounds.height * paddingYRatio));
  const x = Math.max(0, bounds.x - paddingX);
  const y = Math.max(0, bounds.y - paddingY);
  const width = Math.min(image.bitmap.width - x, bounds.width + (paddingX * 2));
  const height = Math.min(image.bitmap.height - y, bounds.height + (paddingY * 2));

  return { x, y, width, height };
};

const distanceBetweenPoints = (left, right) => Math.sqrt(
  (((left.x || 0) - (right.x || 0)) ** 2) + (((left.y || 0) - (right.y || 0)) ** 2),
);

const polygonArea = (points = []) => {
  if (!Array.isArray(points) || points.length < 4) return 0;
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }

  return Math.abs(area / 2);
};

const buildBoundingBoxFromCorners = (corners = []) => {
  if (!Array.isArray(corners) || corners.length < 4) return null;
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min.apply(null, xs);
  const maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys);
  const maxY = Math.max.apply(null, ys);

  return {
    x: Math.max(0, Math.floor(minX)),
    y: Math.max(0, Math.floor(minY)),
    width: Math.max(2, Math.ceil(maxX - minX)),
    height: Math.max(2, Math.ceil(maxY - minY)),
  };
};

const buildFullImageBounds = (image) => ({
  x: 0,
  y: 0,
  width: image.bitmap.width,
  height: image.bitmap.height,
});

const percentile = (values = [], ratio = 0.5) => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[position];
};

const average = (values = []) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const normalizeContrastProbe = (image) => image.clone().greyscale().normalize().contrast(0.4);

const findDocumentBounds = (image, luminanceThreshold = DEFAULT_BRIGHTNESS_THRESHOLD) => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const rowCounts = new Array(height).fill(0);
  const columnCounts = new Array(width).fill(0);

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const luminance = getLuminanceAt(this.bitmap, idx);
    if (luminance < luminanceThreshold) return;
    rowCounts[y] += 1;
    columnCounts[x] += 1;
  });

  const minBrightPixelsPerRow = Math.max(10, Math.floor(width * 0.08));
  const minBrightPixelsPerColumn = Math.max(8, Math.floor(height * 0.05));
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

  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
};

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

const findReceiptBandBounds = (image, luminanceThreshold = DEFAULT_BRIGHTNESS_THRESHOLD) => {
  const probe = scaleDownForProbe(image.clone().greyscale().normalize().contrast(0.2));
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
    RECEIPT_BAND_PADDING_X_RATIO,
    RECEIPT_BAND_PADDING_Y_RATIO,
  );
};

const findReceiptComponentBounds = (image, luminanceThreshold = DEFAULT_COMPONENT_BRIGHTNESS_THRESHOLD) => {
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
    const luminance = getLuminanceAt(this.bitmap, idx);
    if (luminance >= luminanceThreshold) {
      mask[(y * width) + x] = 1;
    }
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

const findReceiptDarkBandBounds = (image, darknessThreshold = DEFAULT_DARKNESS_THRESHOLD) => {
  const probe = scaleDownForProbe(normalizeContrastProbe(image), 900);
  const width = probe.bitmap.width;
  const height = probe.bitmap.height;
  const rowCounts = new Array(height).fill(0);
  const columnCounts = new Array(width).fill(0);

  probe.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const luminance = getLuminanceAt(this.bitmap, idx);
    if (luminance > darknessThreshold) return;
    rowCounts[y] += 1;
    columnCounts[x] += 1;
  });

  const horizontalBand = findDominantBand(
    rowCounts,
    Math.max(8, Math.floor(width * 0.045)),
  );
  const verticalBand = findDominantBand(
    columnCounts,
    Math.max(6, Math.floor(height * 0.1)),
  );

  if (!horizontalBand) return null;

  const top = horizontalBand.start;
  const bottom = horizontalBand.end;
  const left = verticalBand ? verticalBand.start : columnCounts.findIndex((count) => count >= Math.max(6, Math.floor(height * 0.08)));
  let right = verticalBand ? verticalBand.end : -1;

  if (right < 0) {
    for (let column = width - 1; column >= 0; column -= 1) {
      if (columnCounts[column] >= Math.max(6, Math.floor(height * 0.08))) {
        right = column;
        break;
      }
    }
  }

  if (left < 0 || right < left || bottom <= top) return null;

  const widthRatio = (right - left + 1) / Math.max(1, width);
  const heightRatio = (bottom - top + 1) / Math.max(1, height);

  if (widthRatio < 0.35 || heightRatio < 0.04) return null;

  return expandBounds(
    image,
    mapBoundsToSource(image, probe, {
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    }),
    RECEIPT_BAND_PADDING_X_RATIO,
    RECEIPT_BAND_PADDING_Y_RATIO,
  );
};

const buildThresholdProbe = (image, threshold = 180) => {
  const probe = image.clone().greyscale().normalize().contrast(0.48);

  probe.scan(0, 0, probe.bitmap.width, probe.bitmap.height, function scanPixel(x, y, idx) {
    const luminance = this.bitmap.data[idx];
    const value = luminance >= threshold ? 255 : 0;
    this.bitmap.data[idx + 0] = value;
    this.bitmap.data[idx + 1] = value;
    this.bitmap.data[idx + 2] = value;
  });

  return probe;
};

const computeHorizontalProjectionScore = (image) => {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const rowDarkCounts = new Array(height).fill(0);

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    if (this.bitmap.data[idx] < 180) rowDarkCounts[y] += 1;
  });

  const mean = rowDarkCounts.reduce((sum, value) => sum + value, 0) / Math.max(1, rowDarkCounts.length);
  const variance = rowDarkCounts.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, rowDarkCounts.length);
  return variance;
};

const estimateDeskewAngle = (image) => {
  const probeBase = scaleDownForProbe(buildThresholdProbe(image), 820);
  let best = {
    angle: 0,
    score: computeHorizontalProjectionScore(probeBase),
  };

  DEFAULT_DESKEW_ANGLES.forEach((angle) => {
    if (!angle) return;
    const rotated = probeBase.clone().rotate(angle, false);
    const score = computeHorizontalProjectionScore(rotated);
    if (score > best.score) {
      best = {
        angle,
        score,
      };
    }
  });

  return best;
};

const buildPixelBox = (image, box) => {
  const x = clamp(
    Math.floor(image.bitmap.width * Number(box.x || 0)),
    0,
    Math.max(0, image.bitmap.width - 2),
  );
  const y = clamp(
    Math.floor(image.bitmap.height * Number(box.y || 0)),
    0,
    Math.max(0, image.bitmap.height - 2),
  );
  const width = clamp(
    Math.floor(image.bitmap.width * Number(box.width || 1)),
    2,
    image.bitmap.width - x,
  );
  const height = clamp(
    Math.floor(image.bitmap.height * Number(box.height || 1)),
    2,
    image.bitmap.height - y,
  );

  return { x, y, width, height };
};

const whitenBox = (image, box) => {
  const color = Jimp.rgbaToInt(255, 255, 255, 255);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.bitmap.width - 1, Math.floor(box.x + box.width));
  const y1 = Math.min(image.bitmap.height - 1, Math.floor(box.y + box.height));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      image.setPixelColor(color, x, y);
    }
  }
};

const assessSignaturePresence = (image) => {
  const signatureDefinition = TEMPLATE_ROI_DEFINITIONS.find((definition) => definition.id === 'roi_signature');
  if (!signatureDefinition) {
    return {
      evaluated: false,
      present: null,
      reason: 'signature_roi_not_found',
    };
  }

  const outerBox = buildPixelBox(image, signatureDefinition.box);
  const innerBox = {
    x: outerBox.x + Math.max(8, Math.floor(outerBox.width * 0.08)),
    y: outerBox.y + Math.max(8, Math.floor(outerBox.height * 0.1)),
    width: Math.max(20, outerBox.width - (Math.max(8, Math.floor(outerBox.width * 0.08)) * 2)),
    height: Math.max(20, outerBox.height - (Math.max(8, Math.floor(outerBox.height * 0.1)) * 2)),
  };
  const safeInnerBox = {
    x: clamp(innerBox.x, 0, Math.max(0, image.bitmap.width - 2)),
    y: clamp(innerBox.y, 0, Math.max(0, image.bitmap.height - 2)),
    width: clamp(innerBox.width, 2, image.bitmap.width - clamp(innerBox.x, 0, Math.max(0, image.bitmap.width - 2))),
    height: clamp(innerBox.height, 2, image.bitmap.height - clamp(innerBox.y, 0, Math.max(0, image.bitmap.height - 2))),
  };
  const probe = image.clone()
    .crop(safeInnerBox.x, safeInnerBox.y, safeInnerBox.width, safeInnerBox.height)
    .greyscale()
    .contrast(0.08);
  const rowInk = new Array(probe.bitmap.height).fill(0);
  const columnInk = new Array(probe.bitmap.width).fill(0);
  let darkPixels = 0;
  let edgePixels = 0;

  for (let y = 0; y < probe.bitmap.height; y += 1) {
    for (let x = 0; x < probe.bitmap.width; x += 1) {
      const idx = probe.getPixelIndex(x, y);
      const luminance = getLuminanceAt(probe.bitmap, idx);
      const isDark = luminance < 208;

      if (isDark) {
        darkPixels += 1;
        rowInk[y] += 1;
        columnInk[x] += 1;
      }

      if (x + 1 < probe.bitmap.width) {
        const rightLuminance = getLuminanceAt(probe.bitmap, probe.getPixelIndex(x + 1, y));
        if (Math.abs(luminance - rightLuminance) >= 28 && (luminance < 228 || rightLuminance < 228)) {
          edgePixels += 1;
        }
      }

      if (y + 1 < probe.bitmap.height) {
        const bottomLuminance = getLuminanceAt(probe.bitmap, probe.getPixelIndex(x, y + 1));
        if (Math.abs(luminance - bottomLuminance) >= 28 && (luminance < 228 || bottomLuminance < 228)) {
          edgePixels += 1;
        }
      }
    }
  }

  const area = Math.max(1, probe.bitmap.width * probe.bitmap.height);
  const darkRatio = darkPixels / area;
  const edgeRatio = edgePixels / Math.max(1, area * 2);
  const activeRows = rowInk.filter((count) => count >= Math.max(4, Math.floor(probe.bitmap.width * 0.025))).length;
  const activeColumns = columnInk.filter((count) => count >= Math.max(4, Math.floor(probe.bitmap.height * 0.025))).length;
  const rowCoverage = activeRows / Math.max(1, probe.bitmap.height);
  const columnCoverage = activeColumns / Math.max(1, probe.bitmap.width);
  const score = Number(Math.min(
    1,
    (darkRatio * 10)
    + (edgeRatio * 8)
    + (rowCoverage * 0.75)
    + (columnCoverage * 0.75),
  ).toFixed(2));
  const present = (
    score >= 0.12
    && darkRatio >= 0.003
    && edgeRatio >= 0.0015
    && rowCoverage >= 0.015
    && columnCoverage >= 0.015
  );

  return {
    evaluated: true,
    present,
    score,
    darkRatio: Number(darkRatio.toFixed(4)),
    edgeRatio: Number(edgeRatio.toFixed(4)),
    rowCoverage: Number(rowCoverage.toFixed(4)),
    columnCoverage: Number(columnCoverage.toFixed(4)),
    roiBox: safeInnerBox,
  };
};

const computeTemplateGeometryScore = (image, subject = null) => {
  const bounds = subject && subject.bounds
    ? subject.bounds
    : subject && subject.width && subject.height
      ? subject
      : null;
  const corners = subject && Array.isArray(subject.corners) ? subject.corners : null;

  if (!bounds) {
    return {
      templateMatched: false,
      geometryScore: 0,
      reasons: ['contorno_nao_detectado'],
    };
  }

  const imageArea = Math.max(1, image.bitmap.width * image.bitmap.height);
  const boundsArea = Math.max(1, bounds.width * bounds.height);
  const topWidth = corners ? distanceBetweenPoints(corners[0], corners[1]) : bounds.width;
  const bottomWidth = corners ? distanceBetweenPoints(corners[3], corners[2]) : bounds.width;
  const leftHeight = corners ? distanceBetweenPoints(corners[0], corners[3]) : bounds.height;
  const rightHeight = corners ? distanceBetweenPoints(corners[1], corners[2]) : bounds.height;
  const meanWidth = (topWidth + bottomWidth) / 2;
  const meanHeight = Math.max(1, (leftHeight + rightHeight) / 2);
  const coverage = (corners ? polygonArea(corners) : boundsArea) / imageArea;
  const aspectRatio = meanWidth / meanHeight;
  const templateAspect = RECEIPT_TEMPLATE.aspectRatio;
  const aspectDelta = Math.abs(aspectRatio - templateAspect);
  const aspectScore = Math.max(0, 1 - (aspectDelta / Math.max(templateAspect, 1)));
  const coverageScore = coverage >= 0.55
    ? 1
    : coverage >= 0.35
      ? 0.82
      : coverage >= 0.22
        ? 0.58
        : 0.24;
  const widthConsistency = Math.max(0, 1 - (Math.abs(topWidth - bottomWidth) / Math.max(topWidth, bottomWidth, 1)));
  const heightConsistency = Math.max(0, 1 - (Math.abs(leftHeight - rightHeight) / Math.max(leftHeight, rightHeight, 1)));
  const cornerConsistency = corners
    ? Number((((widthConsistency + heightConsistency) / 2)).toFixed(2))
    : 0.72;
  const geometryScore = Number(Math.min(
    1,
    (
      (aspectScore * 0.52)
      + (coverageScore * 0.28)
      + (cornerConsistency * 0.2)
    ),
  ).toFixed(2));
  const reasons = [];

  if (aspectRatio < RECEIPT_TEMPLATE.minAspectRatio) reasons.push('aspect_ratio_baixo');
  if (aspectRatio > RECEIPT_TEMPLATE.maxAspectRatio) reasons.push('aspect_ratio_alto');
  if (coverage < 0.22) reasons.push('cobertura_baixa');
  if (cornerConsistency < 0.62) reasons.push('perspectiva_instavel');

  return {
    templateMatched: geometryScore >= 0.58,
    geometryScore,
    coverage: Number(coverage.toFixed(3)),
    aspectRatio: Number(aspectRatio.toFixed(2)),
    cornerConsistency,
    reasons,
  };
};

const findPerspectiveQuad = (image, sourceBounds) => {
  if (!sourceBounds) return null;

  const probe = scaleDownForProbe(normalizeContrastProbe(image), 920);
  const probeBounds = mapBoundsToProbe(image, probe, sourceBounds);
  if (!probeBounds) return null;

  const searchX = clamp(probeBounds.x, 0, Math.max(0, probe.bitmap.width - 2));
  const searchY = clamp(probeBounds.y, 0, Math.max(0, probe.bitmap.height - 2));
  const searchRight = clamp(probeBounds.x + probeBounds.width, searchX + 2, probe.bitmap.width);
  const searchBottom = clamp(probeBounds.y + probeBounds.height, searchY + 2, probe.bitmap.height);
  const rowEdges = [];

  for (let y = searchY; y < searchBottom; y += 1) {
    let left = -1;
    let right = -1;

    for (let x = searchX; x < searchRight; x += 1) {
      const idx = ((y * probe.bitmap.width) + x) * 4;
      if (getLuminanceAt(probe.bitmap, idx) <= DEFAULT_DARKNESS_THRESHOLD) {
        left = x;
        break;
      }
    }

    if (left < 0) continue;

    for (let x = searchRight - 1; x >= searchX; x -= 1) {
      const idx = ((y * probe.bitmap.width) + x) * 4;
      if (getLuminanceAt(probe.bitmap, idx) <= DEFAULT_DARKNESS_THRESHOLD) {
        right = x;
        break;
      }
    }

    if (right < left) continue;

    const rowWidth = right - left + 1;
    if (rowWidth < Math.max(10, Math.floor(probeBounds.width * 0.28))) continue;

    rowEdges.push({ y, left, right, rowWidth });
  }

  if (rowEdges.length < Math.max(6, Math.floor(probeBounds.height * 0.16))) {
    return null;
  }

  const sampleCount = Math.max(4, Math.floor(rowEdges.length * 0.16));
  const topRows = rowEdges.slice(0, sampleCount);
  const bottomRows = rowEdges.slice(-sampleCount);

  const topLeftProbe = {
    x: percentile(topRows.map((row) => row.left), 0.2),
    y: average(topRows.map((row) => row.y)),
  };
  const topRightProbe = {
    x: percentile(topRows.map((row) => row.right), 0.8),
    y: average(topRows.map((row) => row.y)),
  };
  const bottomLeftProbe = {
    x: percentile(bottomRows.map((row) => row.left), 0.2),
    y: average(bottomRows.map((row) => row.y)),
  };
  const bottomRightProbe = {
    x: percentile(bottomRows.map((row) => row.right), 0.8),
    y: average(bottomRows.map((row) => row.y)),
  };

  const corners = [
    mapPointToSource(image, probe, topLeftProbe),
    mapPointToSource(image, probe, topRightProbe),
    mapPointToSource(image, probe, bottomRightProbe),
    mapPointToSource(image, probe, bottomLeftProbe),
  ];
  const bounds = buildBoundingBoxFromCorners(corners);

  if (!bounds || bounds.width < 40 || bounds.height < 12) {
    return null;
  }

  return {
    corners,
    bounds,
  };
};

const solveLinearSystem = (matrix, vector) => {
  const size = vector.length;
  const augmented = matrix.map((row, index) => row.slice().concat(vector[index]));

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotValue = Math.abs(augmented[pivotRow][column]);

    for (let row = column + 1; row < size; row += 1) {
      const value = Math.abs(augmented[row][column]);
      if (value > pivotValue) {
        pivotRow = row;
        pivotValue = value;
      }
    }

    if (pivotValue < 1e-8) return null;

    if (pivotRow !== column) {
      const temp = augmented[column];
      augmented[column] = augmented[pivotRow];
      augmented[pivotRow] = temp;
    }

    const pivot = augmented[column][column];
    for (let idx = column; idx <= size; idx += 1) {
      augmented[column][idx] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (!factor) continue;

      for (let idx = column; idx <= size; idx += 1) {
        augmented[row][idx] -= factor * augmented[column][idx];
      }
    }
  }

  return augmented.map((row) => row[size]);
};

const buildPerspectiveCoefficients = ({ sourceCorners, targetWidth, targetHeight }) => {
  const destinationCorners = [
    { x: 0, y: 0 },
    { x: targetWidth - 1, y: 0 },
    { x: targetWidth - 1, y: targetHeight - 1 },
    { x: 0, y: targetHeight - 1 },
  ];
  const matrix = [];
  const vector = [];

  destinationCorners.forEach((destinationPoint, index) => {
    const sourcePoint = sourceCorners[index];
    const u = destinationPoint.x;
    const v = destinationPoint.y;
    const x = sourcePoint.x;
    const y = sourcePoint.y;

    matrix.push([u, v, 1, 0, 0, 0, -(u * x), -(v * x)]);
    vector.push(x);
    matrix.push([0, 0, 0, u, v, 1, -(u * y), -(v * y)]);
    vector.push(y);
  });

  const solved = solveLinearSystem(matrix, vector);
  if (!solved) return null;

  return {
    a: solved[0],
    b: solved[1],
    c: solved[2],
    d: solved[3],
    e: solved[4],
    f: solved[5],
    g: solved[6],
    h: solved[7],
  };
};

const readChannel = (bitmap, x, y, channel) => {
  const clampedX = clamp(Math.floor(x), 0, bitmap.width - 1);
  const clampedY = clamp(Math.floor(y), 0, bitmap.height - 1);
  const index = ((clampedY * bitmap.width) + clampedX) * 4;
  return bitmap.data[index + channel];
};

const sampleBilinear = (bitmap, x, y) => {
  const x0 = clamp(Math.floor(x), 0, bitmap.width - 1);
  const y0 = clamp(Math.floor(y), 0, bitmap.height - 1);
  const x1 = clamp(x0 + 1, 0, bitmap.width - 1);
  const y1 = clamp(y0 + 1, 0, bitmap.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const channels = [0, 1, 2, 3].map((channel) => {
    const top = (readChannel(bitmap, x0, y0, channel) * (1 - tx)) + (readChannel(bitmap, x1, y0, channel) * tx);
    const bottom = (readChannel(bitmap, x0, y1, channel) * (1 - tx)) + (readChannel(bitmap, x1, y1, channel) * tx);
    return Math.round((top * (1 - ty)) + (bottom * ty));
  });

  return Jimp.rgbaToInt(channels[0], channels[1], channels[2], channels[3]);
};

const warpPerspective = (image, corners) => {
  if (!Array.isArray(corners) || corners.length < 4) return null;

  const coefficients = buildPerspectiveCoefficients({
    sourceCorners: corners,
    targetWidth: WARP_OUTPUT_WIDTH,
    targetHeight: WARP_OUTPUT_HEIGHT,
  });

  if (!coefficients) return null;

  const warped = new Jimp(WARP_OUTPUT_WIDTH, WARP_OUTPUT_HEIGHT, Jimp.rgbaToInt(255, 255, 255, 255));

  for (let y = 0; y < WARP_OUTPUT_HEIGHT; y += 1) {
    for (let x = 0; x < WARP_OUTPUT_WIDTH; x += 1) {
      const denominator = (coefficients.g * x) + (coefficients.h * y) + 1;
      if (Math.abs(denominator) < 1e-8) continue;

      const sourceX = ((coefficients.a * x) + (coefficients.b * y) + coefficients.c) / denominator;
      const sourceY = ((coefficients.d * x) + (coefficients.e * y) + coefficients.f) / denominator;

      if (
        sourceX < 0
        || sourceY < 0
        || sourceX > (image.bitmap.width - 1)
        || sourceY > (image.bitmap.height - 1)
      ) {
        continue;
      }

      warped.setPixelColor(sampleBilinear(image.bitmap, sourceX, sourceY), x, y);
    }
  }

  return warped;
};

const findTemplateDefinition = (definitionId) => (
  TEMPLATE_ROI_DEFINITIONS.find((definition) => definition.id === definitionId) || null
);

const detectNfAnchorBox = (image) => {
  const nfDefinition = findTemplateDefinition('roi_nf_block');
  if (!nfDefinition) {
    return {
      detected: false,
      score: 0,
      box: null,
      expectedBox: null,
    };
  }

  const expectedBox = buildPixelBox(image, nfDefinition.box);
  const searchX = clamp(
    expectedBox.x - Math.floor(expectedBox.width * 0.22),
    0,
    Math.max(0, image.bitmap.width - 2),
  );
  const searchY = clamp(
    expectedBox.y - Math.floor(expectedBox.height * 0.08),
    0,
    Math.max(0, image.bitmap.height - 2),
  );
  const searchBox = {
    x: searchX,
    y: searchY,
    width: clamp(Math.floor(expectedBox.width * 1.38), 2, image.bitmap.width - searchX),
    height: clamp(Math.floor(expectedBox.height * 1.16), 2, image.bitmap.height - searchY),
  };
  const searchImage = normalizeContrastProbe(
    image.clone().crop(searchBox.x, searchBox.y, searchBox.width, searchBox.height),
  );
  const rowCounts = new Array(searchImage.bitmap.height).fill(0);
  const columnCounts = new Array(searchImage.bitmap.width).fill(0);

  searchImage.scan(0, 0, searchImage.bitmap.width, searchImage.bitmap.height, function scanPixel(x, y, idx) {
    if (getLuminanceAt(this.bitmap, idx) > DEFAULT_DARKNESS_THRESHOLD) return;
    rowCounts[y] += 1;
    columnCounts[x] += 1;
  });

  const minRowDarkPixels = Math.max(6, Math.floor(searchImage.bitmap.width * 0.08));
  const minColumnDarkPixels = Math.max(8, Math.floor(searchImage.bitmap.height * 0.14));
  const top = rowCounts.findIndex((count) => count >= minRowDarkPixels);
  const left = columnCounts.findIndex((count) => count >= minColumnDarkPixels);
  let bottom = -1;
  let right = -1;

  for (let row = searchImage.bitmap.height - 1; row >= 0; row -= 1) {
    if (rowCounts[row] >= minRowDarkPixels) {
      bottom = row;
      break;
    }
  }

  for (let column = searchImage.bitmap.width - 1; column >= 0; column -= 1) {
    if (columnCounts[column] >= minColumnDarkPixels) {
      right = column;
      break;
    }
  }

  if (top < 0 || left < 0 || bottom <= top || right <= left) {
    return {
      detected: false,
      score: 0,
      box: null,
      expectedBox,
    };
  }

  const box = {
    x: searchBox.x + left,
    y: searchBox.y + top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  const widthRatio = box.width / Math.max(1, expectedBox.width);
  const heightRatio = box.height / Math.max(1, expectedBox.height);
  const aspectDelta = Math.abs(
    (box.width / Math.max(1, box.height))
    - (expectedBox.width / Math.max(1, expectedBox.height)),
  );
  const sizeSimilarity = Math.max(0, 1 - ((Math.abs(1 - widthRatio) + Math.abs(1 - heightRatio)) / 2));
  const aspectSimilarity = Math.max(0, 1 - (aspectDelta / 2));
  const score = Number(((sizeSimilarity * 0.6) + (aspectSimilarity * 0.4)).toFixed(2));

  return {
    detected: score >= 0.32,
    score,
    box,
    expectedBox,
  };
};

const buildAnchoredPixelBox = (image, box, anchor = null) => {
  const nfDefinition = findTemplateDefinition('roi_nf_block');
  const expectedAnchor = nfDefinition ? buildPixelBox(image, nfDefinition.box) : null;
  const targetBox = buildPixelBox(image, box);
  const anchorBox = anchor && anchor.detected ? anchor.box : null;

  if (!expectedAnchor || !anchorBox) {
    return Object.assign({}, targetBox);
  }

  const scaleX = anchorBox.width / Math.max(1, expectedAnchor.width);
  const scaleY = anchorBox.height / Math.max(1, expectedAnchor.height);
  const x = clamp(
    Math.floor(anchorBox.x + ((targetBox.x - expectedAnchor.x) * scaleX)),
    0,
    Math.max(0, image.bitmap.width - 2),
  );
  const y = clamp(
    Math.floor(anchorBox.y + ((targetBox.y - expectedAnchor.y) * scaleY)),
    0,
    Math.max(0, image.bitmap.height - 2),
  );
  const width = clamp(
    Math.ceil(targetBox.width * scaleX),
    2,
    image.bitmap.width - x,
  );
  const height = clamp(
    Math.ceil(targetBox.height * scaleY),
    2,
    image.bitmap.height - y,
  );

  return { x, y, width, height };
};

const applySecondaryTrim = (image) => {
  const trimmedBounds = findDocumentBounds(image.clone().greyscale().normalize().contrast(0.22));

  if (!trimmedBounds) {
    return {
      image: image.clone(),
      applied: false,
      bounds: null,
      areaRatio: 1,
    };
  }

  const trimmedArea = trimmedBounds.width * trimmedBounds.height;
  const fullArea = Math.max(1, image.bitmap.width * image.bitmap.height);
  const areaRatio = trimmedArea / fullArea;

  if (areaRatio < SECONDARY_TRIM_MIN_AREA_RATIO) {
    return {
      image: image.clone(),
      applied: false,
      bounds: trimmedBounds,
      areaRatio: Number(areaRatio.toFixed(3)),
    };
  }

  return {
    image: image.clone().crop(
      trimmedBounds.x,
      trimmedBounds.y,
      trimmedBounds.width,
      trimmedBounds.height,
    ),
    applied: true,
    bounds: trimmedBounds,
    areaRatio: Number(areaRatio.toFixed(3)),
  };
};

const normalizeToTemplateCanvas = (image) => {
  if (
    image.bitmap.width === WARP_OUTPUT_WIDTH
    && image.bitmap.height === WARP_OUTPUT_HEIGHT
  ) {
    return image.clone();
  }

  const sourceWidth = Math.max(1, image.bitmap.width);
  const sourceHeight = Math.max(1, image.bitmap.height);
  const scale = Math.max(
    WARP_OUTPUT_WIDTH / sourceWidth,
    WARP_OUTPUT_HEIGHT / sourceHeight,
  );
  const resizedWidth = Math.max(2, Math.round(sourceWidth * scale));
  const resizedHeight = Math.max(2, Math.round(sourceHeight * scale));
  const resized = image.clone().resize(resizedWidth, resizedHeight);
  const cropX = clamp(
    Math.floor((resizedWidth - WARP_OUTPUT_WIDTH) / 2),
    0,
    Math.max(0, resizedWidth - WARP_OUTPUT_WIDTH),
  );
  const cropY = clamp(
    Math.floor((resizedHeight - WARP_OUTPUT_HEIGHT) / 2),
    0,
    Math.max(0, resizedHeight - WARP_OUTPUT_HEIGHT),
  );

  return resized.crop(cropX, cropY, WARP_OUTPUT_WIDTH, WARP_OUTPUT_HEIGHT);
};

const buildAlignmentCandidate = ({
  sourceImage,
  candidateImage,
  kind,
  warped = false,
  geometry = null,
}) => {
  const deskew = estimateDeskewAngle(candidateImage);
  const deskewed = deskew.angle ? candidateImage.clone().rotate(deskew.angle, false) : candidateImage.clone();
  const secondaryTrim = applySecondaryTrim(deskewed);
  const aligned = normalizeToTemplateCanvas(secondaryTrim.image);

  const nfAnchor = detectNfAnchorBox(aligned.clone());
  const signatureCheck = assessSignaturePresence(aligned.clone());
  const referenceAspectRatio = Number(
    geometry && Number.isFinite(geometry.aspectRatio)
      ? geometry.aspectRatio
      : candidateImage.bitmap.width / Math.max(1, candidateImage.bitmap.height),
  );
  const aspectDelta = Math.abs(referenceAspectRatio - RECEIPT_TEMPLATE.aspectRatio);
  const aspectScore = Math.max(0, 1 - (aspectDelta / Math.max(RECEIPT_TEMPLATE.aspectRatio, 1)));
  const geometryScore = Number(geometry && geometry.geometryScore) || 0;
  const anchorScore = nfAnchor && nfAnchor.detected ? Number(nfAnchor.score || 0) : 0;
  const preCroppedReceiptBonus = (
    kind === 'source_full'
    && referenceAspectRatio >= (RECEIPT_TEMPLATE.minAspectRatio * 0.95)
    && referenceAspectRatio <= (RECEIPT_TEMPLATE.maxAspectRatio * 1.05)
  )
    ? 0.2
    : 0;
  const signaturePenalty = (
    signatureCheck
    && signatureCheck.darkRatio >= SIGNATURE_DARK_RATIO_ALERT
    && signatureCheck.rowCoverage >= 0.9
    && signatureCheck.columnCoverage >= 0.9
  )
    ? 0.45
    : 0;
  const warpPenalty = warped && referenceAspectRatio < RECEIPT_TEMPLATE.minAspectRatio
    ? Number(Math.min(
      0.45,
      ((RECEIPT_TEMPLATE.minAspectRatio - referenceAspectRatio) / Math.max(RECEIPT_TEMPLATE.minAspectRatio, 1)) * 0.7,
    ).toFixed(2))
    : 0;
  const trimPenalty = secondaryTrim.applied === false && secondaryTrim.bounds && secondaryTrim.areaRatio < 0.9
    ? 0.08
    : 0;
  const qualityScore = Number(Math.max(
    0,
    Math.min(
      1,
      (aspectScore * 0.34)
      + (geometryScore * 0.34)
      + (anchorScore * 0.22)
      + ((geometry && geometry.templateMatched) ? 0.08 : 0)
      + preCroppedReceiptBonus
      - signaturePenalty
      - warpPenalty
      - trimPenalty,
    ),
  ).toFixed(2));

  return {
    kind,
    warped,
    alignedImage: aligned,
    deskew,
    nfAnchor,
    signatureCheck,
    geometry,
    qualityScore,
    rawAspectRatio: Number(referenceAspectRatio.toFixed(2)),
    preCroppedReceiptBonus,
    secondaryTrim,
    suspiciousSignature: signaturePenalty > 0,
    suspiciousWarp: warpPenalty > 0,
    normalized: {
      width: aligned.bitmap.width,
      height: aligned.bitmap.height,
      aspectRatio: Number((aligned.bitmap.width / Math.max(1, aligned.bitmap.height)).toFixed(2)),
    },
  };
};

module.exports = {
  buildPixelBox,
  buildAnchoredPixelBox,
  detectNfAnchorBox,

  detectReceiptContour(image) {
    const normalized = image.clone().greyscale().normalize().contrast(0.28);
    const documentBounds = findDocumentBounds(normalized);
    const brightBandBounds = findReceiptBandBounds(image.clone());
    const darkBandBounds = findReceiptDarkBandBounds(image.clone());
    const candidateBounds = [
      darkBandBounds,
      brightBandBounds,
      documentBounds
        ? expandBounds(
          normalized,
          documentBounds,
          RECEIPT_DOCUMENT_PADDING_X_RATIO,
          RECEIPT_BAND_PADDING_Y_RATIO,
        )
        : null,
    ].filter(Boolean);

    const ranked = candidateBounds
      .map((bounds) => {
        const quad = findPerspectiveQuad(image, bounds);
        const geometry = computeTemplateGeometryScore(image, quad || bounds);
        return {
          bounds: quad && quad.bounds ? quad.bounds : bounds,
          corners: quad && quad.corners ? quad.corners : null,
          quadDetected: !!(quad && quad.corners),
          ...geometry,
        };
      })
      .sort((left, right) => {
        if (right.quadDetected !== left.quadDetected) return right.quadDetected ? 1 : -1;
        return right.geometryScore - left.geometryScore;
      });
    const best = ranked[0] || null;

    return {
      contourDetected: !!best,
      quadDetected: !!(best && best.quadDetected),
      bounds: best ? best.bounds : null,
      corners: best && best.corners ? best.corners : null,
      geometryScore: best ? best.geometryScore : 0,
      templateMatched: best ? best.templateMatched : false,
      aspectRatio: best ? best.aspectRatio : 0,
      coverage: best ? best.coverage : 0,
      reasons: best ? best.reasons : ['contorno_nao_detectado'],
      candidates: ranked.map((candidate, index) => ({
        rank: index + 1,
        x: candidate.bounds.x,
        y: candidate.bounds.y,
        width: candidate.bounds.width,
        height: candidate.bounds.height,
        geometryScore: candidate.geometryScore,
        aspectRatio: candidate.aspectRatio,
        coverage: candidate.coverage,
        quadDetected: candidate.quadDetected,
        corners: candidate.corners || null,
      })),
    };
  },

  alignReceiptToTemplate(image) {
    const contour = this.detectReceiptContour(image);
    const alignmentGeometry = computeTemplateGeometryScore(image, contour);
    const fullImageGeometry = computeTemplateGeometryScore(image, buildFullImageBounds(image));
    const warped = contour.corners ? warpPerspective(image.clone(), contour.corners) : null;
    const contourCrop = contour.bounds
      ? image.clone().crop(contour.bounds.x, contour.bounds.y, contour.bounds.width, contour.bounds.height)
      : image.clone();
    const componentBounds = findReceiptComponentBounds(image.clone());
    const componentCrop = componentBounds
      ? image.clone().crop(
        componentBounds.x,
        componentBounds.y,
        componentBounds.width,
        componentBounds.height,
      )
      : null;
    const brightBandBounds = findReceiptBandBounds(image.clone());
    const brightBandCrop = brightBandBounds
      ? image.clone().crop(
        brightBandBounds.x,
        brightBandBounds.y,
        brightBandBounds.width,
        brightBandBounds.height,
      )
      : null;
    const brightBandGeometry = brightBandBounds
      ? computeTemplateGeometryScore(image, brightBandBounds)
      : null;
    const candidates = [
      buildAlignmentCandidate({
        sourceImage: image,
        candidateImage: image.clone(),
        kind: 'source_full',
        warped: false,
        geometry: fullImageGeometry,
      }),
      buildAlignmentCandidate({
        sourceImage: image,
        candidateImage: warped || contourCrop,
        kind: warped ? 'warp' : 'contour_crop',
        warped: !!warped,
        geometry: alignmentGeometry,
      }),
    ];

    if (brightBandCrop) {
      candidates.push(buildAlignmentCandidate({
        sourceImage: image,
        candidateImage: brightBandCrop,
        kind: 'bright_band_crop',
        warped: false,
        geometry: brightBandGeometry,
      }));
    }

    if (componentCrop) {
      candidates.push(buildAlignmentCandidate({
        sourceImage: image,
        candidateImage: componentCrop,
        kind: 'component_crop',
        warped: false,
        geometry: computeTemplateGeometryScore(image, componentBounds),
      }));
    }

    const selectedCandidate = candidates
      .slice()
      .sort((left, right) => right.qualityScore - left.qualityScore)[0];
    const aligned = selectedCandidate.alignedImage.clone();
    const nfAnchor = selectedCandidate.nfAnchor;
    const signatureCheck = selectedCandidate.signatureCheck;
    const selectedGeometry = selectedCandidate.geometry || alignmentGeometry;

    return {
      alignedImage: aligned,
      contour,
      deskew: {
        angle: selectedCandidate.deskew.angle,
        score: Number(selectedCandidate.deskew.score.toFixed(2)),
      },
      warp: {
        applied: !!selectedCandidate.warped,
        outputWidth: WARP_OUTPUT_WIDTH,
        outputHeight: WARP_OUTPUT_HEIGHT,
        candidateKind: selectedCandidate.kind,
        candidateQuality: selectedCandidate.qualityScore,
        suspiciousWarp: !!selectedCandidate.suspiciousWarp,
      },
      nfAnchor,
      signatureCheck,
      normalized: selectedCandidate.normalized,
      templateMatched: selectedGeometry.templateMatched,
      geometryScore: selectedGeometry.geometryScore,
      debugCandidates: candidates
        .slice()
        .sort((left, right) => right.qualityScore - left.qualityScore)
        .map((candidate) => ({
          kind: candidate.kind,
          warped: candidate.warped,
          qualityScore: candidate.qualityScore,
          rawAspectRatio: candidate.rawAspectRatio,
          geometryScore: Number(candidate.geometry && candidate.geometry.geometryScore || 0),
          templateMatched: !!(candidate.geometry && candidate.geometry.templateMatched),
          suspiciousSignature: !!candidate.suspiciousSignature,
          suspiciousWarp: !!candidate.suspiciousWarp,
          secondaryTrimApplied: !!(candidate.secondaryTrim && candidate.secondaryTrim.applied),
          secondaryTrimAreaRatio: candidate.secondaryTrim ? candidate.secondaryTrim.areaRatio : 1,
          normalized: candidate.normalized,
        })),
    };
  },

  buildTemplateRois(image) {
    return TEMPLATE_ROI_DEFINITIONS.map((definition) => ({
      id: definition.id,
      label: definition.label,
      role: definition.role,
      ignoreForOcr: !!definition.ignoreForOcr,
      box: definition.box,
      pixelBox: buildPixelBox(image, definition.box),
    }));
  },

  maskSignatureRegion(image) {
    const signatureDefinition = TEMPLATE_ROI_DEFINITIONS.find((definition) => definition.id === 'roi_signature');
    if (!signatureDefinition) return image;
    const box = buildPixelBox(image, signatureDefinition.box);
    whitenBox(image, box);
    return image;
  },

  assessSignaturePresence,

  scoreTemplateMatch({ contour = {}, requiredFields = {}, nfBlockDetected = false }) {
    const headerConfidence = Number((requiredFields[RECEIPT_FIELD_KEYS.issuerHeader] && requiredFields[RECEIPT_FIELD_KEYS.issuerHeader].confidence) || 0);
    const dateConfidence = Number((requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento] && requiredFields[RECEIPT_FIELD_KEYS.dataRecebimento].confidence) || 0);
    const nfConfidence = Number((requiredFields[RECEIPT_FIELD_KEYS.nfe] && requiredFields[RECEIPT_FIELD_KEYS.nfe].confidence) || 0);
    const geometryScore = Number(contour.geometryScore || 0);
    const total = Number((
      (geometryScore * 38)
      + (headerConfidence * 22)
      + (dateConfidence * 18)
      + (nfConfidence * 22)
      + (nfBlockDetected ? 6 : 0)
    ).toFixed(2));

    return {
      score: total,
      templateMatched: (
        (geometryScore >= 0.52 && nfConfidence >= 0.55)
        || (total >= 58 && geometryScore >= 0.5)
        || (geometryScore >= 0.56 && headerConfidence >= 0.48 && dateConfidence >= 0.42)
      ),
      breakdown: {
        geometry: Number((geometryScore * 38).toFixed(2)),
        header: Number((headerConfidence * 22).toFixed(2)),
        date: Number((dateConfidence * 18).toFixed(2)),
        nfBlock: Number((nfConfidence * 22).toFixed(2)),
        total,
      },
    };
  },
};
