const path = require('path');
const { createRequire } = require('module');
const dotenv = require('dotenv');
const env = require('../config/env');

const MOCK_INVOICE_DATABASE = {};

let backendDbContextPromise = null;
let resolvedCompanyPromise = null;

const normalizeInvoiceNumber = (invoiceNumber) => {
  const digitsOnly = String(invoiceNumber || '').replace(/\D+/g, '');
  return digitsOnly || String(invoiceNumber || '').trim();
};

const getBackendRequire = () => createRequire(path.join(env.backendRoot, 'package.json'));

const loadBackendDbContext = async () => {
  if (backendDbContextPromise) return backendDbContextPromise;

  backendDbContextPromise = (async () => {
    dotenv.config({
      path: env.receiptInvoiceLookupBackendEnvPath,
      override: false,
    });

    const backendRequire = getBackendRequire();
    const models = backendRequire('./src/database/models');

    return {
      Company: models.Company,
      Danfe: models.Danfe,
      sequelize: models.sequelize,
    };
  })().catch((error) => {
    backendDbContextPromise = null;
    throw error;
  });

  return backendDbContextPromise;
};

const findInvoiceInMockDatabase = async (invoiceNumber) => {
  const key = normalizeInvoiceNumber(invoiceNumber);

  return {
    found: !!MOCK_INVOICE_DATABASE[key],
    invoice: MOCK_INVOICE_DATABASE[key] || null,
    mode: 'mock',
    reason: MOCK_INVOICE_DATABASE[key]
      ? 'invoice_found'
      : key
        ? 'invoice_not_found'
        : 'missing_invoice_number',
  };
};

const resolveCompanyScope = async (Company) => {
  if (resolvedCompanyPromise) return resolvedCompanyPromise;

  resolvedCompanyPromise = (async () => {
    if (Number.isFinite(env.receiptInvoiceLookupCompanyId) && env.receiptInvoiceLookupCompanyId > 0) {
      return {
        id: env.receiptInvoiceLookupCompanyId,
        code: env.receiptInvoiceLookupCompanyCode || null,
        source: 'config_id',
      };
    }

    if (!env.receiptInvoiceLookupCompanyCode || !Company) {
      return {
        id: null,
        code: null,
        source: 'unscoped',
      };
    }

    const company = await Company.findOne({
      where: {
        code: env.receiptInvoiceLookupCompanyCode,
      },
      attributes: ['id', 'code', 'name', 'tax_id'],
    });

    if (!company) {
      return {
        id: null,
        code: env.receiptInvoiceLookupCompanyCode,
        source: 'code_not_found',
      };
    }

    return {
      id: Number(company.id),
      code: company.code,
      name: company.name,
      taxId: company.tax_id,
      source: 'config_code',
    };
  })().catch((error) => {
    resolvedCompanyPromise = null;
    throw error;
  });

  return resolvedCompanyPromise;
};

const findInvoiceInBackendDb = async (invoiceNumber) => {
  const key = normalizeInvoiceNumber(invoiceNumber);

  if (!key) {
    return {
      found: false,
      invoice: null,
      mode: 'backend_db',
      reason: 'missing_invoice_number',
      company: null,
    };
  }

  const { Company, Danfe } = await loadBackendDbContext();
  const companyScope = await resolveCompanyScope(Company);
  const where = {
    invoice_number: key,
  };

  if (Number.isFinite(companyScope.id) && companyScope.id > 0) {
    where.company_id = companyScope.id;
  }

  const invoice = await Danfe.findOne({
    where,
    attributes: [
      'invoice_number',
      'company_id',
      'status',
      'invoice_date',
      'load_number',
      'barcode',
      'total_value',
    ],
  });

  return {
    found: !!invoice,
    invoice: invoice
      ? {
        invoiceNumber: invoice.invoice_number,
        companyId: Number(invoice.company_id),
        status: invoice.status,
        invoiceDate: invoice.invoice_date,
        loadNumber: invoice.load_number,
        barcode: invoice.barcode,
        totalValue: invoice.total_value,
      }
      : null,
    mode: 'backend_db',
    reason: invoice ? 'invoice_found' : 'invoice_not_found',
    company: companyScope,
  };
};

module.exports = {
  async findInvoiceByNumber(invoiceNumber) {
    const lookupMode = env.receiptInvoiceLookupMode;
    const key = normalizeInvoiceNumber(invoiceNumber);

    if (!key) {
      return {
        found: false,
        invoice: null,
        mode: lookupMode === 'disabled' ? 'disabled' : 'none',
        reason: 'missing_invoice_number',
      };
    }

    if (lookupMode === 'disabled') {
      return {
        found: false,
        invoice: null,
        mode: 'disabled',
        reason: 'lookup_disabled',
      };
    }

    if (lookupMode === 'mock') {
      return findInvoiceInMockDatabase(key);
    }

    if (lookupMode === 'backend_db' || lookupMode === 'auto') {
      try {
        return await findInvoiceInBackendDb(key);
      } catch (error) {
        if (lookupMode === 'backend_db') {
          return {
            found: false,
            invoice: null,
            mode: 'backend_db',
            reason: 'lookup_error',
            error: error.message,
          };
        }
      }
    }

    const fallback = await findInvoiceInMockDatabase(key);
    return Object.assign({}, fallback, {
      mode: lookupMode === 'auto' ? 'auto_mock_fallback' : fallback.mode,
      fallbackFrom: 'backend_db',
    });
  },

  async updateInvoiceReceiptStatus(invoiceNumber, payload = {}) {
    const key = normalizeInvoiceNumber(invoiceNumber);
    if (!key) {
      return {
        updated: false,
        mode: 'mock',
        reason: 'missing_invoice_number',
      };
    }

    MOCK_INVOICE_DATABASE[key] = Object.assign(
      {},
      MOCK_INVOICE_DATABASE[key] || {},
      {
        invoiceNumber: key,
        receiptStatus: payload.receiptStatus || 'receipt_received',
        updatedAt: new Date().toISOString(),
      },
      payload,
    );

    return {
      updated: true,
      mode: 'mock',
      invoice: MOCK_INVOICE_DATABASE[key],
    };
  },

  async createReceiptAlert(payload = {}) {
    return {
      created: true,
      mode: 'mock',
      alert: Object.assign(
        {
          id: `mock-alert-${Date.now()}`,
          createdAt: new Date().toISOString(),
          type: 'receipt_analysis_alert',
        },
        payload,
      ),
    };
  },

  async syncAnalysisResult(analysis = {}) {
    if (!analysis || !analysis.nfExtraction || !analysis.nfExtraction.nf) {
      return {
        mode: 'mock',
        action: 'none',
        reason: 'missing_nf',
      };
    }

    const lookup = analysis.invoiceLookup
      ? analysis.invoiceLookup
      : await this.findInvoiceByNumber(analysis.nfExtraction.nf);

    if (lookup.found) {
      const update = await this.updateInvoiceReceiptStatus(analysis.nfExtraction.nf, {
        receiptStatus: analysis.classification && analysis.classification.classification === 'valid'
          ? 'receipt_received'
          : 'receipt_pending_review',
      });

      return {
        mode: lookup.mode || 'mock',
        action: 'update_invoice_receipt_status',
        lookup,
        update,
      };
    }

    const alert = await this.createReceiptAlert({
      invoiceNumber: analysis.nfExtraction.nf,
      reason: 'invoice_not_found',
      classification: analysis.classification ? analysis.classification.classification : null,
    });

    return {
      mode: lookup.mode || 'mock',
      action: 'create_receipt_alert',
      lookup,
      alert,
    };
  },

  async shutdown() {
    if (!backendDbContextPromise) return;

    try {
      const context = await backendDbContextPromise;
      if (context && context.sequelize && typeof context.sequelize.close === 'function') {
        await context.sequelize.close();
      }
    } finally {
      backendDbContextPromise = null;
      resolvedCompanyPromise = null;
    }
  },
};
