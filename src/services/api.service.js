const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const dotenv = require('dotenv');
const env = require('../config/env');
const {
  buildAlertPayload,
  guessMimeTypeFromPath,
  normalizeInvoiceNumber,
  resolveSyncAction,
} = require('./backendSyncSupport.service');

const MOCK_INVOICE_DATABASE = {};
const REAL_BACKEND_SYNC_MODES = new Set(['full', 'status_only', 'alerts_only']);

let backendContextPromise = null;
let resolvedCompanyPromise = null;

const normalizeText = (value) => String(value || '').trim();

const toDateOnly = (value) => {
  if (!value && value !== 0) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return toDateOnly(new Date(millis));
  }

  const raw = normalizeText(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return toDateOnly(Number(raw));

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const isRealBackendSyncEnabled = () => REAL_BACKEND_SYNC_MODES.has(env.receiptBackendSyncMode);

const getBackendRequire = () => createRequire(path.join(env.backendRoot, 'package.json'));

const loadBackendContext = async () => {
  if (backendContextPromise) return backendContextPromise;

  backendContextPromise = (async () => {
    dotenv.config({
      path: env.receiptInvoiceLookupBackendEnvPath,
      override: false,
    });

    const backendRequire = getBackendRequire();
    const models = backendRequire('./src/database/models');

    return {
      backendRequire,
      sequelize: models.sequelize,
      Company: models.Company,
      Danfe: models.Danfe,
      TripNote: models.TripNote,
      Trips: models.Trips,
      AlertsService: backendRequire('./src/services/AlertsService'),
      DanfesService: backendRequire('./src/services/DanfesService'),
      ReceiptsService: backendRequire('./src/services/ReceiptsService'),
    };
  })().catch((error) => {
    backendContextPromise = null;
    throw error;
  });

  return backendContextPromise;
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

const buildSystemActor = (companyScope) => {
  if (!companyScope || !Number.isFinite(Number(companyScope.id)) || Number(companyScope.id) <= 0) {
    throw new Error('Nao foi possivel resolver a empresa para sincronizar o resultado com o backend.');
  }

  return {
    id: null,
    company_id: Number(companyScope.id),
    permission: 'admin',
    username: 'receipt-whatsapp-bot',
    name: 'Receipt WhatsApp Bot',
    is_system: true,
  };
};

const resolveCompanyScopeFromLookup = async (lookup = null) => {
  if (lookup && lookup.company && Number.isFinite(Number(lookup.company.id)) && Number(lookup.company.id) > 0) {
    return {
      id: Number(lookup.company.id),
      code: lookup.company.code || null,
      name: lookup.company.name || null,
      taxId: lookup.company.taxId || null,
      source: lookup.company.source || 'lookup',
    };
  }

  const { Company } = await loadBackendContext();
  return resolveCompanyScope(Company);
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

  const { Company, Danfe } = await loadBackendContext();
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

const resolveDeliveryContext = async (invoiceNumber, companyId) => {
  if (!companyId) {
    return {
      tripId: null,
      driverId: null,
      tripDate: null,
    };
  }

  const { TripNote, Trips } = await loadBackendContext();
  const key = normalizeInvoiceNumber(invoiceNumber);

  const tripNote = await TripNote.findOne({
    where: {
      company_id: companyId,
      invoice_number: key,
    },
    attributes: ['trip_id', 'created_at', 'updated_at'],
    include: [{
      model: Trips,
      required: false,
      where: { company_id: companyId },
      attributes: ['id', 'driver_id', 'date'],
    }],
    order: [['updated_at', 'DESC'], ['created_at', 'DESC']],
  });

  return {
    tripId: tripNote && tripNote.trip_id ? Number(tripNote.trip_id) : null,
    driverId: tripNote && tripNote.Trip && tripNote.Trip.driver_id
      ? Number(tripNote.Trip.driver_id)
      : null,
    tripDate: tripNote && tripNote.Trip ? tripNote.Trip.date : null,
  };
};

const uploadReceiptEvidence = async ({ invoiceNumber, imagePath, companyScope, metadata = {} }) => {
  if (!imagePath) {
    throw new Error('imagePath e obrigatorio para sincronizar o canhoto real no backend.');
  }

  const { ReceiptsService } = await loadBackendContext();
  const actor = buildSystemActor(companyScope);
  const deliveryContext = await resolveDeliveryContext(invoiceNumber, Number(companyScope.id));
  const buffer = await fs.promises.readFile(imagePath);
  const deliveredAt = toDateOnly(
    metadata.deliveredAt
    || metadata.messageTimestamp
    || metadata.messageDate
    || deliveryContext.tripDate
    || new Date(),
  );
  const payload = {
    nfNumber: normalizeInvoiceNumber(invoiceNumber),
    deliveredAt,
  };

  if (deliveryContext.tripId) payload.tripId = deliveryContext.tripId;
  if (deliveryContext.driverId) payload.motoristaId = deliveryContext.driverId;

  try {
    const receipt = await ReceiptsService.uploadReceipt({
      file: {
        buffer,
        mimetype: guessMimeTypeFromPath(imagePath),
        originalname: path.basename(imagePath || `${invoiceNumber}.jpg`),
      },
      payload,
      actor,
    });

    return {
      uploaded: true,
      skipped: false,
      mode: 'backend_service',
      receipt,
      payload,
    };
  } catch (error) {
    if (error && error.code === 'RECEIPT_ALREADY_EXISTS') {
      return {
        uploaded: false,
        skipped: true,
        mode: 'backend_service',
        reason: 'receipt_already_exists',
        error: error.message,
        payload,
      };
    }

    throw error;
  }
};

const updateInvoiceStatusInBackend = async (invoiceNumber, payload = {}, companyScope) => {
  const key = normalizeInvoiceNumber(invoiceNumber);
  if (!key) {
    return {
      updated: false,
      mode: 'backend_service',
      reason: 'missing_invoice_number',
    };
  }

  const { DanfesService } = await loadBackendContext();
  const actor = buildSystemActor(companyScope);
  const deliveryStatus = normalizeText(payload.deliveryStatus || 'delivered').toLowerCase() || 'delivered';

  await DanfesService.updateDanfesStatus([{
    invoice_number: key,
    status: deliveryStatus,
  }], actor);

  return {
    updated: true,
    mode: 'backend_service',
    invoice: {
      invoiceNumber: key,
      deliveryStatus,
      updatedAt: new Date().toISOString(),
    },
  };
};

const createAlertInBackend = async (payload = {}, companyScope) => {
  const { AlertsService } = await loadBackendContext();
  const resolvedScope = companyScope && companyScope.id
    ? companyScope
    : await resolveCompanyScopeFromLookup(null);
  const actor = buildSystemActor(resolvedScope);

  const alert = await AlertsService.createAlert({
    companyId: Number(resolvedScope.id),
    userId: actor.id || null,
    nfNumber: payload.invoiceNumber || payload.nfNumber || null,
    code: payload.code,
    title: payload.title,
    message: payload.message,
    severity: payload.severity || 'WARNING',
    metadata: payload.metadata || null,
  });

  return {
    created: true,
    mode: 'backend_service',
    alert,
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
    if (!isRealBackendSyncEnabled() || env.receiptBackendSyncMode === 'alerts_only') {
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
    }

    const lookup = await findInvoiceInBackendDb(invoiceNumber);
    const companyScope = await resolveCompanyScopeFromLookup(lookup);
    return updateInvoiceStatusInBackend(invoiceNumber, payload, companyScope);
  },

  async createReceiptAlert(payload = {}) {
    if (!isRealBackendSyncEnabled()) {
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
    }

    const companyScope = payload.companyId
      ? {
        id: Number(payload.companyId),
        code: payload.companyCode || null,
        source: 'payload',
      }
      : await resolveCompanyScopeFromLookup(payload.lookup || null);

    return createAlertInBackend(payload, companyScope);
  },

  async syncAnalysisResult(analysis = {}, options = {}) {
    const syncMode = env.receiptBackendSyncMode;
    const invoiceNumber = normalizeInvoiceNumber(analysis.nfExtraction && analysis.nfExtraction.nf);
    let lookup = null;

    if (invoiceNumber) {
      lookup = isRealBackendSyncEnabled()
        ? await findInvoiceInBackendDb(invoiceNumber)
        : (analysis.invoiceLookup || await this.findInvoiceByNumber(invoiceNumber));
    }

    const syncAction = resolveSyncAction({
      analysis,
      lookup,
      syncMode,
    });

    if (syncAction.type === 'none') {
      return {
        mode: syncMode,
        action: 'none',
        reason: syncAction.reason,
        lookup,
      };
    }

    if (syncAction.type === 'mark_delivered') {
      const companyScope = await resolveCompanyScopeFromLookup(lookup);
      const upload = syncAction.uploadReceipt
        ? await uploadReceiptEvidence({
          invoiceNumber: syncAction.invoiceNumber,
          imagePath: options.imagePath,
          companyScope,
          metadata: options.metadata || {},
        })
        : {
          uploaded: false,
          skipped: true,
          mode: 'backend_service',
          reason: 'sync_mode_status_only',
        };
      const update = await updateInvoiceStatusInBackend(syncAction.invoiceNumber, {
        deliveryStatus: 'delivered',
      }, companyScope);

      return {
        mode: syncMode,
        action: 'mark_invoice_delivered',
        lookup,
        upload,
        update,
      };
    }

    const alertPayload = buildAlertPayload({
      analysis,
      lookup,
      metadata: options.metadata || {},
    });
    const alert = await this.createReceiptAlert(Object.assign({}, alertPayload, {
      invoiceNumber: syncAction.invoiceNumber,
      lookup,
    }));

    return {
      mode: syncMode,
      action: 'create_receipt_alert',
      reason: syncAction.reason,
      lookup,
      alert,
    };
  },

  async shutdown() {
    if (!backendContextPromise) return;

    try {
      const context = await backendContextPromise;
      if (context && context.sequelize && typeof context.sequelize.close === 'function') {
        await context.sequelize.close();
      }
    } finally {
      backendContextPromise = null;
      resolvedCompanyPromise = null;
    }
  },
};
