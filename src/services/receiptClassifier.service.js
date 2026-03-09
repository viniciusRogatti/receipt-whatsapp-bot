const receiptBusinessRulesService = require('./receiptPipeline/receiptBusinessRules.service');

module.exports = {
  classifyReceiptAnalysis(payload = {}) {
    return receiptBusinessRulesService.classifyStructuredReceipt(payload);
  },
};
