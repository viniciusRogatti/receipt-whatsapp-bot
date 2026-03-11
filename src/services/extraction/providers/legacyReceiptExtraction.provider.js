const path = require('path');
const receiptAnalysisService = require('../../receiptAnalysis.service');
const {
  EXTRACTION_FIELD_KEYS,
  REQUIRED_EXTRACTION_FIELDS,
} = require('../../../config/profiles');

module.exports = {
  id: 'legacy_receipt_analysis',

  isAvailable() {
    return true;
  },

  async extract({ imagePath, context }) {
    try {
      const analysis = await receiptAnalysisService.analyzeImage({
        imagePath,
        outputDir: path.join(process.cwd(), 'outputs', 'legacy-migration'),
      });

      const requiredFields = (analysis.detection && analysis.detection.requiredFields) || {};
      const dateField = requiredFields.dataRecebimento || {};
      const headerField = requiredFields.issuerHeader || {};

      const fields = {
        [EXTRACTION_FIELD_KEYS.invoiceNumber]: {
          key: EXTRACTION_FIELD_KEYS.invoiceNumber,
          label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.invoiceNumber].label,
          found: !!(analysis.nfExtraction && analysis.nfExtraction.nf),
          value: analysis.nfExtraction && analysis.nfExtraction.nf ? String(analysis.nfExtraction.nf) : null,
          confidence: Number(analysis.nfExtraction && analysis.nfExtraction.confidence ? analysis.nfExtraction.confidence : 0),
          source: 'legacy_analysis',
        },
        [EXTRACTION_FIELD_KEYS.receiptDate]: {
          key: EXTRACTION_FIELD_KEYS.receiptDate,
          label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.receiptDate].label,
          found: !!dateField.found,
          value: dateField.matchedText || null,
          confidence: Number(dateField.confidence || 0),
          source: 'legacy_analysis',
        },
        [EXTRACTION_FIELD_KEYS.issuerHeader]: {
          key: EXTRACTION_FIELD_KEYS.issuerHeader,
          label: context.documentProfile.fieldDefinitions[EXTRACTION_FIELD_KEYS.issuerHeader].label,
          found: !!headerField.found,
          value: headerField.matchedText || context.companyProfile.displayName || null,
          confidence: Number(headerField.confidence || 0),
          source: 'legacy_analysis',
        },
      };

      const foundFieldCount = REQUIRED_EXTRACTION_FIELDS.filter((fieldKey) => fields[fieldKey].found).length;
      const averageConfidence = foundFieldCount
        ? Number((REQUIRED_EXTRACTION_FIELDS.reduce((sum, fieldKey) => {
          if (!fields[fieldKey].found) return sum;
          return sum + Number(fields[fieldKey].confidence || 0);
        }, 0) / foundFieldCount).toFixed(2))
        : 0;

      return {
        providerId: this.id,
        status: 'success',
        extractedDocument: {
          providerId: this.id,
          fullText: analysis.fullOcr ? analysis.fullOcr.textRaw : '',
          fields,
          summary: {
            foundFieldCount,
            missingFieldKeys: REQUIRED_EXTRACTION_FIELDS.filter((fieldKey) => !fields[fieldKey].found),
            averageConfidence,
          },
          raw: {
            legacyAnalysis: analysis,
            legacyClassification: analysis.classification || null,
          },
        },
        raw: analysis,
      };
    } catch (error) {
      return {
        providerId: this.id,
        status: 'error',
        reason: error.message,
      };
    }
  },
};
