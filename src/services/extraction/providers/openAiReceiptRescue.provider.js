const fs = require('fs');
const env = require('../../../config/env');
const { EXTRACTION_FIELD_KEYS } = require('../../../config/profiles');

const stripJsonFences = (value) => String(value || '')
  .replace(/^```json\s*/i, '')
  .replace(/^```\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const extractOutputText = (responsePayload = {}) => {
  if (typeof responsePayload.output_text === 'string' && responsePayload.output_text.trim()) {
    return responsePayload.output_text.trim();
  }

  const outputs = Array.isArray(responsePayload.output) ? responsePayload.output : [];
  const fragments = [];

  outputs.forEach((item) => {
    const content = Array.isArray(item.content) ? item.content : [];
    content.forEach((block) => {
      if (typeof block.text === 'string' && block.text.trim()) {
        fragments.push(block.text.trim());
      }
    });
  });

  return fragments.join('\n').trim();
};

const validatePayload = (payload = {}) => {
  const normalized = {
    invoiceNumber: payload.invoiceNumber ? String(payload.invoiceNumber).replace(/\D+/g, '') : null,
    receiptDate: payload.receiptDate ? String(payload.receiptDate).trim() : null,
    issuerHeaderDetected: payload.issuerHeaderDetected === true,
    issuerHeaderText: payload.issuerHeaderText ? String(payload.issuerHeaderText).trim() : null,
    confidence: Math.max(0, Math.min(1, Number(payload.confidence || 0))),
    notes: payload.notes ? String(payload.notes).trim() : null,
  };

  return normalized;
};

const guessMimeType = (imagePath) => {
  const extension = String(imagePath || '').split('.').pop().toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'bmp') return 'image/bmp';
  if (extension === 'tif' || extension === 'tiff') return 'image/tiff';
  return 'image/jpeg';
};

module.exports = {
  id: 'openai_receipt_rescue',

  isAvailable() {
    return !!(env.receiptProviderOpenAiEnabled && env.receiptProviderOpenAiApiKey);
  },

  async extract({ imagePath, context, previousAttempts = [] }) {
    if (!this.isAvailable()) {
      return {
        providerId: this.id,
        status: 'unavailable',
        reason: 'openai_not_configured',
      };
    }

    const buffer = await fs.promises.readFile(imagePath);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      env.receiptProviderOpenAiTimeoutMs,
    );
    const hints = previousAttempts
      .filter((attempt) => attempt && attempt.parsedDocument)
      .map((attempt) => ({
        providerId: attempt.providerId,
        fields: attempt.parsedDocument.fields,
      }));

    try {
      const response = await fetch(`${env.receiptProviderOpenAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.receiptProviderOpenAiApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.receiptProviderOpenAiModel,
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: [
                    'Extraia campos de canhoto em JSON puro.',
                    'Responda apenas um objeto JSON com as chaves invoiceNumber, receiptDate, issuerHeaderDetected, issuerHeaderText, confidence e notes.',
                    'Se nao souber um campo, use null.',
                  ].join(' '),
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: JSON.stringify({
                    companyId: context.companyProfile.id,
                    companyName: context.companyProfile.displayName,
                    documentType: context.documentProfile.documentType,
                    fieldLabels: Object.values(context.documentProfile.fieldDefinitions).map((field) => field.label),
                    previousAttempts: hints,
                  }),
                },
                {
                  type: 'input_image',
                  image_url: `data:${guessMimeType(imagePath)};base64,${buffer.toString('base64')}`,
                },
              ],
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
            : `openai_http_${response.status}`,
          raw: payload,
        };
      }

      const outputText = stripJsonFences(extractOutputText(payload));
      const normalized = validatePayload(JSON.parse(outputText));

      return {
        providerId: this.id,
        status: 'success',
        extractedDocument: {
          providerId: this.id,
          fullText: null,
          fields: {
            [EXTRACTION_FIELD_KEYS.invoiceNumber]: {
              key: EXTRACTION_FIELD_KEYS.invoiceNumber,
              label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.invoiceNumber].label,
              found: !!normalized.invoiceNumber,
              value: normalized.invoiceNumber,
              confidence: normalized.invoiceNumber ? normalized.confidence : 0,
              source: 'openai_rescue',
            },
            [EXTRACTION_FIELD_KEYS.receiptDate]: {
              key: EXTRACTION_FIELD_KEYS.receiptDate,
              label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.receiptDate].label,
              found: !!normalized.receiptDate,
              value: normalized.receiptDate,
              confidence: normalized.receiptDate ? normalized.confidence : 0,
              source: 'openai_rescue',
            },
            [EXTRACTION_FIELD_KEYS.issuerHeader]: {
              key: EXTRACTION_FIELD_KEYS.issuerHeader,
              label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.issuerHeader].label,
              found: !!normalized.issuerHeaderDetected,
              value: normalized.issuerHeaderText,
              confidence: normalized.issuerHeaderDetected ? normalized.confidence : 0,
              source: 'openai_rescue',
            },
          },
          summary: {
            foundFieldCount: [
              normalized.invoiceNumber,
              normalized.receiptDate,
              normalized.issuerHeaderDetected,
            ].filter(Boolean).length,
            missingFieldKeys: [
              !normalized.invoiceNumber ? EXTRACTION_FIELD_KEYS.invoiceNumber : null,
              !normalized.receiptDate ? EXTRACTION_FIELD_KEYS.receiptDate : null,
              !normalized.issuerHeaderDetected ? EXTRACTION_FIELD_KEYS.issuerHeader : null,
            ].filter(Boolean),
            averageConfidence: normalized.confidence,
          },
          raw: {
            model: env.receiptProviderOpenAiModel,
            notes: normalized.notes,
            response: payload,
          },
        },
        raw: payload,
      };
    } catch (error) {
      return {
        providerId: this.id,
        status: 'error',
        reason: error.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
