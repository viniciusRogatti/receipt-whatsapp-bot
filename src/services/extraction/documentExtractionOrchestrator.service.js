const providerRegistry = require('./extractionProviderRegistry.service');
const env = require('../../config/env');
const parserService = require('../processing/documentFieldParser.service');
const decisionService = require('../processing/receiptDecision.service');

const normalizeAttempt = (providerId, payload = {}) => Object.assign(
  {
    providerId,
    status: 'unknown',
    reason: null,
  },
  payload,
);

const parseProviderResult = ({ providerId, providerResult, context }) => {
  if (providerResult.extractedDocument) {
    return providerResult.extractedDocument;
  }

  if (providerResult.ocrDocument) {
    return parserService.parseStructuredDocument({
      ocrDocument: providerResult.ocrDocument,
      documentProfile: context.documentProfile,
      providerId,
    });
  }

  return null;
};

module.exports = {
  async extract({ imagePath, context }) {
    const strategy = context.documentProfile.extractionStrategy || {};
    const primaryProviderId = strategy.primaryProvider;
    const fallbackProviders = Array.isArray(strategy.fallbackProviders) ? strategy.fallbackProviders : [];
    const migrationProviders = Array.isArray(strategy.migrationProviders) ? strategy.migrationProviders : [];
    const allowLegacyOnFailure = !!(
      strategy.allowLegacyOnFailure
      && env.receiptLegacyFallbackEnabled
    );
    const attempts = [];

    const runProvider = async (providerId) => {
      const provider = providerRegistry.getProvider(providerId);
      if (!provider) {
        attempts.push(normalizeAttempt(providerId, {
          status: 'unavailable',
          reason: 'provider_not_registered',
        }));
        return null;
      }

      const providerResult = await provider.extract({
        imagePath,
        context,
        previousAttempts: attempts,
      });

      const parsedDocument = providerResult.status === 'success'
        ? parseProviderResult({
          providerId,
          providerResult,
          context,
        })
        : null;
      const attempt = normalizeAttempt(providerId, {
        status: providerResult.status,
        reason: providerResult.reason || null,
        parsedDocument,
        raw: providerResult.raw || null,
      });
      attempts.push(attempt);
      return attempt;
    };

    const primaryAttempt = await runProvider(primaryProviderId);
    if (
      primaryAttempt
      && primaryAttempt.status === 'success'
      && primaryAttempt.parsedDocument
    ) {
      const primaryDecision = decisionService.buildOperationalDecision({
        parsedDocument: primaryAttempt.parsedDocument,
        documentProfile: context.documentProfile,
        companyProfile: context.companyProfile,
        sourceProfile: context.sourceProfile,
        providerId: primaryAttempt.providerId,
        providerAttempts: attempts,
      });

      if (!primaryDecision.shouldTriggerFallback && primaryDecision.classification === 'valid') {
        return {
          selectedAttempt: primaryAttempt,
          attempts,
          decision: primaryDecision,
        };
      }

      if (!primaryDecision.shouldTriggerFallback && !allowLegacyOnFailure) {
        return {
          selectedAttempt: primaryAttempt,
          attempts,
          decision: primaryDecision,
        };
      }
    }

    for (const providerId of fallbackProviders) {
      const fallbackAttempt = await runProvider(providerId);
      if (
        fallbackAttempt
        && fallbackAttempt.status === 'success'
        && fallbackAttempt.parsedDocument
      ) {
        const fallbackDecision = decisionService.buildOperationalDecision({
          parsedDocument: fallbackAttempt.parsedDocument,
          documentProfile: context.documentProfile,
          companyProfile: context.companyProfile,
          sourceProfile: context.sourceProfile,
          providerId: fallbackAttempt.providerId,
          providerAttempts: attempts,
        });

        if (fallbackDecision.classification !== 'invalid') {
          return {
            selectedAttempt: fallbackAttempt,
            attempts,
            decision: fallbackDecision,
          };
        }
      }
    }

    if (allowLegacyOnFailure) {
      for (const providerId of migrationProviders) {
        const migrationAttempt = await runProvider(providerId);
        if (
          migrationAttempt
          && migrationAttempt.status === 'success'
          && migrationAttempt.parsedDocument
        ) {
          const migrationDecision = decisionService.buildOperationalDecision({
            parsedDocument: migrationAttempt.parsedDocument,
            documentProfile: context.documentProfile,
            companyProfile: context.companyProfile,
            sourceProfile: context.sourceProfile,
            providerId: migrationAttempt.providerId,
            providerAttempts: attempts,
          });

          return {
            selectedAttempt: migrationAttempt,
            attempts,
            decision: migrationDecision,
          };
        }
      }
    }

    const selectedAttempt = attempts.find((attempt) => attempt.parsedDocument)
      || attempts[attempts.length - 1]
      || normalizeAttempt(primaryProviderId, {
        status: 'unavailable',
        reason: 'no_attempts_executed',
      });

    return {
      selectedAttempt,
      attempts,
      decision: selectedAttempt.parsedDocument
        ? decisionService.buildOperationalDecision({
          parsedDocument: selectedAttempt.parsedDocument,
          documentProfile: context.documentProfile,
          companyProfile: context.companyProfile,
          sourceProfile: context.sourceProfile,
          providerId: selectedAttempt.providerId,
          providerAttempts: attempts,
        })
        : {
          classification: 'invalid',
          accepted: false,
          reasons: ['Nenhum provider conseguiu produzir um resultado util.'],
          metrics: {
            providerAttempts: attempts,
            averageConfidence: 0,
            missingRequiredCount: 3,
          },
          actions: {
            message: context.documentProfile.operationalResponse.invalid,
            shouldReply: Array.isArray(context.companyProfile.operationalPolicy.autoReplySources)
              && context.companyProfile.operationalPolicy.autoReplySources.includes(context.sourceProfile.id),
          },
          shouldTriggerFallback: false,
        },
    };
  },
};
