const fs = require('fs');
const path = require('path');
const env = require('../../../config/env');

const buildVisionEndpoint = () => {
  if (!env.receiptProviderGoogleVisionApiKey) {
    return env.receiptProviderGoogleVisionEndpoint;
  }

  const separator = env.receiptProviderGoogleVisionEndpoint.includes('?') ? '&' : '?';
  return `${env.receiptProviderGoogleVisionEndpoint}${separator}key=${encodeURIComponent(env.receiptProviderGoogleVisionApiKey)}`;
};

const normalizeWordText = (word = {}) => (
  Array.isArray(word.symbols)
    ? word.symbols.map((symbol) => symbol.text || '').join('')
    : ''
);

const normalizeWordConfidence = (word = {}) => {
  const confidence = Number(word.confidence);
  if (!Number.isFinite(confidence)) return 0.6;
  if (confidence > 1) return Math.max(0, Math.min(1, confidence / 100));
  return Math.max(0, Math.min(1, confidence));
};

const buildLineFromParagraph = (paragraph = {}) => {
  const words = Array.isArray(paragraph.words) ? paragraph.words : [];
  const text = words.map(normalizeWordText).join(' ').trim();
  const averageConfidence = words.length
    ? words.reduce((sum, word) => sum + normalizeWordConfidence(word), 0) / words.length
    : 0.6;

  return {
    text,
    confidence: Number(averageConfidence.toFixed(2)),
    boundingPoly: paragraph.boundingBox || null,
  };
};

const buildOcrDocument = (responsePayload = {}) => {
  const annotation = responsePayload.responses && responsePayload.responses[0]
    ? responsePayload.responses[0].fullTextAnnotation
    : null;

  if (!annotation) {
    return {
      fullText: '',
      lines: [],
      baseConfidence: 0,
      providerConfidence: 0,
      raw: responsePayload,
    };
  }

  const pages = Array.isArray(annotation.pages) ? annotation.pages : [];
  const firstPage = pages[0] || null;
  const lines = [];

  pages.forEach((page) => {
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];

    blocks.forEach((block) => {
      const paragraphs = Array.isArray(block.paragraphs) ? block.paragraphs : [];
      paragraphs.forEach((paragraph) => {
        const line = buildLineFromParagraph(paragraph);
        if (line.text) lines.push(line);
      });
    });
  });

  const providerConfidence = lines.length
    ? Number((lines.reduce((sum, line) => sum + Number(line.confidence || 0), 0) / lines.length).toFixed(2))
    : 0;

  return {
    fullText: String(annotation.text || '').trim(),
    lines,
    pageWidth: Number(firstPage && firstPage.width ? firstPage.width : 0),
    pageHeight: Number(firstPage && firstPage.height ? firstPage.height : 0),
    baseConfidence: providerConfidence,
    providerConfidence,
    raw: responsePayload,
  };
};

module.exports = {
  id: 'google_vision_document_text',

  isAvailable() {
    return !!(
      env.receiptProviderGoogleVisionEnabled
      && (
        env.receiptProviderGoogleVisionApiKey
        || env.receiptProviderGoogleVisionBearerToken
      )
    );
  },

  async extract({ imagePath }) {
    if (!this.isAvailable()) {
      return {
        providerId: this.id,
        status: 'unavailable',
        reason: 'google_vision_not_configured',
      };
    }

    const buffer = await fs.promises.readFile(imagePath);
    const endpoint = buildVisionEndpoint();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      env.receiptProviderGoogleVisionTimeoutMs,
    );

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: Object.assign(
          {
            'content-type': 'application/json',
          },
          env.receiptProviderGoogleVisionBearerToken
            ? {
              authorization: `Bearer ${env.receiptProviderGoogleVisionBearerToken}`,
            }
            : {},
        ),
        body: JSON.stringify({
          requests: [
            {
              image: {
                content: buffer.toString('base64'),
              },
              features: [
                {
                  type: 'DOCUMENT_TEXT_DETECTION',
                },
              ],
              imageContext: {
                languageHints: ['pt-BR', 'pt'],
              },
            },
          ],
        }),
        signal: controller.signal,
      });

      const payload = await response.json();
      if (!response.ok) {
        return {
          providerId: this.id,
          status: 'error',
          reason: payload.error && payload.error.message
            ? payload.error.message
            : `google_vision_http_${response.status}`,
          raw: payload,
        };
      }

      return {
        providerId: this.id,
        status: 'success',
        ocrDocument: buildOcrDocument(payload),
        raw: payload,
        meta: {
          imagePath: path.basename(imagePath),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
