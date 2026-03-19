const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const dotenv = require('dotenv');
const env = require('../config/env');
const {
  buildAlertPayload,
  guessMimeTypeFromPath,
  normalizeClassification,
  normalizeInvoiceNumber,
  resolveSyncAction,
} = require('./backendSyncSupport.service');
const {
  buildAnalysisFromProcessingResult,
  buildMetadataFromCanonicalRequest,
} = require('./backendSyncPayloadAdapter.service');

const MOCK_INVOICE_DATABASE = {};
const REAL_BACKEND_SYNC_MODES = new Set(['full', 'status_only', 'alerts_only']);

let backendContextPromise = null;
let resolvedCompanyPromise = null;

const normalizeText = (value) => String(value || '').trim();
const isRemoteBackendApiEnabled = () => !!normalizeText(env.receiptBackendApiBaseUrl);
const resolveBackendTransportMode = () => (
  isRemoteBackendApiEnabled()
    ? 'backend_api'
    : 'backend_service'
);

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

const buildBackendApiHeaders = ({
  includeJsonContentType = true,
} = {}) => {
  const token = normalizeText(env.receiptBackendApiToken);
  if (!token) {
    throw new Error('RECEIPT_BACKEND_API_TOKEN nao configurado para sincronizar com o backend remoto.');
  }

  const headers = {
    accept: 'application/json',
    'x-receipt-bot-token': token,
  };

  if (includeJsonContentType) {
    headers['content-type'] = 'application/json';
  }

  if (Number.isFinite(env.receiptInvoiceLookupCompanyId) && env.receiptInvoiceLookupCompanyId > 0) {
    headers['x-company-id'] = String(env.receiptInvoiceLookupCompanyId);
  } else if (normalizeText(env.receiptInvoiceLookupCompanyCode)) {
    headers['x-company-code'] = normalizeText(env.receiptInvoiceLookupCompanyCode);
  }

  return headers;
};

const parseJsonSafe = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const requestBackendApi = async (relativePath, {
  method = 'GET',
  body = null,
} = {}) => {
  if (!isRemoteBackendApiEnabled()) {
    throw new Error('RECEIPT_BACKEND_API_BASE_URL nao configurado.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.receiptBackendApiTimeoutMs);
  const url = `${env.receiptBackendApiBaseUrl}${relativePath}`;

  try {
    const response = await fetch(url, {
      method,
      headers: buildBackendApiHeaders({
        includeJsonContentType: body !== null,
      }),
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const payload = rawText ? parseJsonSafe(rawText) : null;

    if (!response.ok) {
      const error = new Error(
        payload && payload.message
          ? payload.message
          : `Falha HTTP ${response.status} ao chamar ${relativePath}.`,
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload && typeof payload === 'object' ? payload : {};
  } finally {
    clearTimeout(timeout);
  }
};

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
      ReceiptWhatsappActivityService: backendRequire('./src/services/ReceiptWhatsappActivityService'),
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

  if (isRemoteBackendApiEnabled()) {
    if (Number.isFinite(env.receiptInvoiceLookupCompanyId) && env.receiptInvoiceLookupCompanyId > 0) {
      return {
        id: env.receiptInvoiceLookupCompanyId,
        code: env.receiptInvoiceLookupCompanyCode || null,
        source: 'config_id',
      };
    }

    return {
      id: null,
      code: env.receiptInvoiceLookupCompanyCode || null,
      source: env.receiptInvoiceLookupCompanyCode ? 'config_code' : 'unscoped',
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

const findInvoiceInBackendApi = async (invoiceNumber) => {
  const key = normalizeInvoiceNumber(invoiceNumber);

  if (!key) {
    return {
      found: false,
      invoice: null,
      mode: 'backend_api',
      reason: 'missing_invoice_number',
      company: null,
    };
  }

  const payload = await requestBackendApi(`/api/receipt-bot/danfes/nf/${encodeURIComponent(key)}`);

  return {
    found: !!payload.found,
    invoice: payload.invoice || null,
    mode: 'backend_api',
    reason: payload.reason || (payload.found ? 'invoice_found' : 'invoice_not_found'),
    company: payload.company || null,
  };
};

const findInvoiceInConfiguredBackend = async (invoiceNumber, { throwOnError = false } = {}) => {
  try {
    return isRemoteBackendApiEnabled()
      ? await findInvoiceInBackendApi(invoiceNumber)
      : await findInvoiceInBackendDb(invoiceNumber);
  } catch (error) {
    if (throwOnError) throw error;

    return {
      found: false,
      invoice: null,
      mode: resolveBackendTransportMode(),
      reason: 'lookup_error',
      error: error.message,
      company: null,
    };
  }
};

const resolveDeliveryContext = async (invoiceNumber, companyId) => {
  if (!companyId) {
    return {
      tripId: null,
      tripNoteId: null,
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
    attributes: ['id', 'trip_id', 'created_at', 'updated_at'],
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
    tripNoteId: tripNote && tripNote.id ? Number(tripNote.id) : null,
    driverId: tripNote && tripNote.Trip && tripNote.Trip.driver_id
      ? Number(tripNote.Trip.driver_id)
      : null,
    tripDate: tripNote && tripNote.Trip ? tripNote.Trip.date : null,
  };
};

const buildWhatsappAlertDedupeKey = (code, metadata = {}) => {
  const normalizedCode = normalizeText(code).toUpperCase();
  const messageId = normalizeText(metadata.messageId);

  if (!normalizedCode || !messageId) return '';
  return `receipt-whatsapp:${normalizedCode}:${messageId}`;
};

const buildWhatsappSuccessSummary = (invoiceNumber, metadata = {}) => {
  const normalizedInvoice = normalizeInvoiceNumber(invoiceNumber);
  const groupLabel = normalizeText(metadata.groupName || metadata.groupId || 'grupo desconhecido');
  const senderLabel = normalizeText(
    metadata.senderContactName
    || metadata.senderName
    || metadata.senderPhone
    || metadata.sender
    || '',
  );

  if (!normalizedInvoice) {
    return `Canhoto processado pelo bot no grupo ${groupLabel}.`;
  }

  if (senderLabel) {
    return `NF ${normalizedInvoice} marcada como entregue pelo bot no grupo ${groupLabel}. Remetente: ${senderLabel}.`;
  }

  return `NF ${normalizedInvoice} marcada como entregue pelo bot no grupo ${groupLabel}.`;
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

const updateInvoiceStatusInBackendApi = async (invoiceNumber, payload = {}) => {
  const key = normalizeInvoiceNumber(invoiceNumber);
  if (!key) {
    return {
      updated: false,
      mode: 'backend_api',
      reason: 'missing_invoice_number',
    };
  }

  const deliveryStatus = normalizeText(payload.deliveryStatus || 'delivered').toLowerCase() || 'delivered';
  const response = await requestBackendApi('/api/receipt-bot/danfes/status', {
    method: 'PUT',
    body: {
      invoiceNumber: key,
      status: deliveryStatus,
    },
  });

  return Object.assign({
    updated: true,
    mode: 'backend_api',
    invoice: {
      invoiceNumber: key,
      deliveryStatus,
      updatedAt: new Date().toISOString(),
    },
  }, response && typeof response === 'object' ? response : {});
};

const createAlertInBackend = async (payload = {}, companyScope) => {
  const { AlertsService } = await loadBackendContext();
  const resolvedScope = companyScope && companyScope.id
    ? companyScope
    : await resolveCompanyScopeFromLookup(null);
  const actor = buildSystemActor(resolvedScope);
  const alertPayload = {
    companyId: Number(resolvedScope.id),
    userId: actor.id || null,
    driverId: payload.driverId || null,
    tripId: payload.tripId || null,
    tripNoteId: payload.tripNoteId || null,
    nfNumber: payload.invoiceNumber || payload.nfNumber || null,
    dedupeKey: payload.dedupeKey || null,
    code: payload.code,
    title: payload.title,
    message: payload.message,
    severity: payload.severity || 'WARNING',
    metadata: payload.metadata || null,
  };
  const alert = alertPayload.dedupeKey
    ? await AlertsService.upsertOpenAlert(alertPayload)
    : await AlertsService.createAlert(alertPayload);

  return {
    created: true,
    mode: 'backend_service',
    alert,
  };
};

const createAlertInBackendApi = async (payload = {}) => {
  const response = await requestBackendApi('/api/receipt-bot/alerts', {
    method: 'POST',
    body: {
      invoiceNumber: payload.invoiceNumber || payload.nfNumber || null,
      driverId: payload.driverId || null,
      tripId: payload.tripId || null,
      tripNoteId: payload.tripNoteId || null,
      dedupeKey: payload.dedupeKey || null,
      code: payload.code,
      title: payload.title,
      message: payload.message,
      severity: payload.severity || 'WARNING',
      metadata: payload.metadata || null,
    },
  });

  return Object.assign({
    created: true,
    mode: 'backend_api',
  }, response && typeof response === 'object' ? response : {});
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

    if (lookupMode === 'backend_db') {
      try {
        return await findInvoiceInBackendDb(key);
      } catch (error) {
        return {
          found: false,
          invoice: null,
          mode: 'backend_db',
          reason: 'lookup_error',
          error: error.message,
          company: null,
        };
      }
    }

    if (lookupMode === 'backend_api') {
      return findInvoiceInConfiguredBackend(key, { throwOnError: false });
    }

    if (lookupMode === 'auto') {
      if (isRemoteBackendApiEnabled()) {
        const lookup = await findInvoiceInConfiguredBackend(key, { throwOnError: false });
        if (lookup.reason !== 'lookup_error') {
          return Object.assign({}, lookup, {
            mode: lookup.mode === 'backend_api' ? 'backend_api' : lookup.mode,
          });
        }
      } else {
        const lookup = await findInvoiceInConfiguredBackend(key, { throwOnError: false });
        if (lookup.reason !== 'lookup_error') {
          return Object.assign({}, lookup, {
            mode: lookup.mode === 'backend_db' ? 'backend_db' : lookup.mode,
          });
        }
      }
    }

    const fallback = await findInvoiceInMockDatabase(key);
    return Object.assign({}, fallback, {
      mode: lookupMode === 'auto' ? 'auto_mock_fallback' : fallback.mode,
      fallbackFrom: isRemoteBackendApiEnabled() ? 'backend_api' : 'backend_db',
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

    if (isRemoteBackendApiEnabled()) {
      return updateInvoiceStatusInBackendApi(invoiceNumber, payload);
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

    const invoiceNumber = normalizeInvoiceNumber(payload.invoiceNumber || payload.nfNumber);
    const dedupeKey = payload.dedupeKey
      || (
        normalizeText(payload.metadata && payload.metadata.source).toLowerCase() === 'whatsapp'
          ? buildWhatsappAlertDedupeKey(payload.code, payload.metadata)
          : ''
      );

    if (isRemoteBackendApiEnabled()) {
      return createAlertInBackendApi(Object.assign({}, payload, {
        invoiceNumber: invoiceNumber || payload.invoiceNumber || payload.nfNumber || null,
        dedupeKey: dedupeKey || null,
      }));
    }

    const companyScope = payload.companyId
      ? {
        id: Number(payload.companyId),
        code: payload.companyCode || null,
        source: 'payload',
      }
      : await resolveCompanyScopeFromLookup(payload.lookup || null);
    const deliveryContext = invoiceNumber && Number.isFinite(Number(companyScope.id)) && Number(companyScope.id) > 0
      ? await resolveDeliveryContext(invoiceNumber, Number(companyScope.id))
      : {
        tripId: null,
        tripNoteId: null,
        driverId: null,
      };

    return createAlertInBackend(Object.assign({}, payload, {
      invoiceNumber: invoiceNumber || payload.invoiceNumber || payload.nfNumber || null,
      driverId: payload.driverId || deliveryContext.driverId || null,
      tripId: payload.tripId || deliveryContext.tripId || null,
      tripNoteId: payload.tripNoteId || deliveryContext.tripNoteId || null,
      dedupeKey: dedupeKey || null,
    }), companyScope);
  },

  async createWhatsappOperationalAlert(payload = {}) {
    const invoiceNumber = normalizeInvoiceNumber(payload.invoiceNumber || payload.nfNumber);
    const metadata = Object.assign({}, payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}, {
      source: 'whatsapp',
      sourceName: payload.metadata && payload.metadata.sourceName ? payload.metadata.sourceName : 'whatsapp',
      backendMode: payload.metadata && payload.metadata.backendMode
        ? payload.metadata.backendMode
        : env.receiptBackendSyncMode,
    });

    return this.createReceiptAlert(Object.assign({}, payload, {
      invoiceNumber: invoiceNumber || null,
      metadata,
      dedupeKey: payload.dedupeKey || buildWhatsappAlertDedupeKey(payload.code, metadata) || null,
    }));
  },

  async recordWhatsappSuccessActivity(payload = {}) {
    if (!isRealBackendSyncEnabled()) {
      return {
        created: false,
        skipped: true,
        mode: 'mock',
        reason: 'backend_sync_disabled',
      };
    }

    if (isRemoteBackendApiEnabled()) {
      return {
        created: false,
        skipped: true,
        mode: 'backend_api',
        reason: 'activity_endpoint_not_configured',
      };
    }

    const invoiceNumber = normalizeInvoiceNumber(payload.invoiceNumber || payload.nfNumber);
    if (!invoiceNumber) {
      return {
        created: false,
        skipped: true,
        mode: 'backend_service',
        reason: 'missing_invoice_number',
      };
    }

    const lookup = payload.lookup || await findInvoiceInBackendDb(invoiceNumber);
    const companyScope = payload.companyScope || await resolveCompanyScopeFromLookup(lookup);
    const deliveryContext = payload.deliveryContext || await resolveDeliveryContext(invoiceNumber, Number(companyScope.id));
    const { ReceiptWhatsappActivityService } = await loadBackendContext();
    const metadata = Object.assign({}, payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}, {
      source: 'whatsapp',
      sourceName: payload.metadata && payload.metadata.sourceName ? payload.metadata.sourceName : 'whatsapp',
      summaryMessage: payload.summaryMessage || buildWhatsappSuccessSummary(invoiceNumber, payload.metadata),
    });

    const result = await ReceiptWhatsappActivityService.recordSuccessActivity({
      companyId: Number(companyScope.id),
      invoiceNumber,
      tripId: deliveryContext.tripId,
      tripNoteId: deliveryContext.tripNoteId,
      driverId: deliveryContext.driverId,
      sourceMessageId: payload.sourceMessageId || metadata.messageId || null,
      occurredAt: payload.occurredAt || metadata.messageTimestamp || metadata.messageDate || new Date(),
      groupId: payload.groupId || metadata.groupId || null,
      groupName: payload.groupName || metadata.groupName || null,
      senderPhone: payload.senderPhone || metadata.senderPhone || null,
      senderName: payload.senderName || metadata.senderName || metadata.sender || null,
      senderContactName: payload.senderContactName || metadata.senderContactName || null,
      backendAction: payload.backendAction || 'mark_invoice_delivered',
      backendMode: payload.backendMode || env.receiptBackendSyncMode,
      classification: payload.classification || 'valid',
      metadata,
    });

    return Object.assign({
      mode: 'backend_service',
      deliveryContext,
    }, result);
  },

  async syncAnalysisResult(analysis = {}, options = {}) {
    const syncMode = env.receiptBackendSyncMode;
    const invoiceNumber = normalizeInvoiceNumber(analysis.nfExtraction && analysis.nfExtraction.nf);
    let lookup = null;

    if (invoiceNumber) {
      lookup = isRealBackendSyncEnabled()
        ? await findInvoiceInConfiguredBackend(invoiceNumber, { throwOnError: true })
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
      const companyScope = isRemoteBackendApiEnabled()
        ? null
        : await resolveCompanyScopeFromLookup(lookup);
      const deliveryContext = companyScope && Number.isFinite(Number(companyScope.id)) && Number(companyScope.id) > 0
        ? await resolveDeliveryContext(syncAction.invoiceNumber, Number(companyScope.id))
        : {
          tripId: null,
          tripNoteId: null,
          driverId: null,
          tripDate: null,
        };
      const upload = syncAction.uploadReceipt
        ? (
          isRemoteBackendApiEnabled()
            ? {
              uploaded: false,
              skipped: true,
              mode: 'backend_api',
              reason: 'remote_upload_not_supported',
            }
            : await uploadReceiptEvidence({
              invoiceNumber: syncAction.invoiceNumber,
              imagePath: options.imagePath,
              companyScope,
              metadata: options.metadata || {},
            })
        )
        : {
          uploaded: false,
          skipped: true,
          mode: resolveBackendTransportMode(),
          reason: 'sync_mode_status_only',
        };
      const update = isRemoteBackendApiEnabled()
        ? await updateInvoiceStatusInBackendApi(syncAction.invoiceNumber, {
          deliveryStatus: 'delivered',
        })
        : await updateInvoiceStatusInBackend(syncAction.invoiceNumber, {
          deliveryStatus: 'delivered',
        }, companyScope);
      const activity = await this.recordWhatsappSuccessActivity({
        invoiceNumber: syncAction.invoiceNumber,
        lookup,
        companyScope,
        deliveryContext,
        sourceMessageId: options.metadata && options.metadata.messageId,
        occurredAt: options.metadata && options.metadata.messageTimestamp,
        groupId: options.metadata && options.metadata.groupId,
        groupName: options.metadata && options.metadata.groupName,
        senderPhone: options.metadata && options.metadata.senderPhone,
        senderName: options.metadata && options.metadata.senderName,
        senderContactName: options.metadata && options.metadata.senderContactName,
        backendAction: 'mark_invoice_delivered',
        backendMode: syncMode,
        classification: normalizeClassification(analysis),
        metadata: Object.assign({}, options.metadata || {}, {
          backendAction: 'mark_invoice_delivered',
          backendMode: syncMode,
        }),
      });

      return {
        mode: syncMode,
        action: 'mark_invoice_delivered',
        lookup,
        upload,
        update,
        activity,
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
      metadata: Object.assign({}, alertPayload.metadata || {}, {
        backendAction: 'create_receipt_alert',
        backendMode: syncMode,
      }),
    }));

    return {
      mode: syncMode,
      action: 'create_receipt_alert',
      reason: syncAction.reason,
      lookup,
      alert,
    };
  },

  async syncProcessingResult(processingResult = {}, options = {}) {
    const analysis = buildAnalysisFromProcessingResult(processingResult);
    const metadata = Object.assign(
      {},
      buildMetadataFromCanonicalRequest(processingResult.request),
      options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
    );

    return this.syncAnalysisResult(analysis, Object.assign({}, options, {
      metadata,
    }));
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
