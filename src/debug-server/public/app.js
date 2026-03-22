const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const state = {
  selectedImageId: null,
  currentJobId: null,
  pollTimer: null,
  lastSession: null,
  filaDeProcessamento: [],
  processandoFila: false,
  renderToken: 0,
  testImages: [],
};

const elements = {
  imageList: document.getElementById('test-image-list'),
  refreshImages: document.getElementById('refresh-images'),
  processAll: document.getElementById('process-all'),
  uploadForm: document.getElementById('upload-form'),
  uploadInput: document.getElementById('upload-input'),
  jobStatus: document.getElementById('job-status'),
  progressGrid: document.getElementById('progress-grid'),
  logList: document.getElementById('log-list'),
  summaryPanel: document.getElementById('summary-panel'),
  summaryChips: document.getElementById('summary-chips'),
  summaryGrid: document.getElementById('summary-grid'),
  fieldGrid: document.getElementById('field-grid'),
  reasonList: document.getElementById('reason-list'),
  visualPanel: document.getElementById('visual-panel'),
  visualSteps: document.getElementById('visual-steps'),
  regionsPanel: document.getElementById('regions-panel'),
  regionHighlights: document.getElementById('region-highlights'),
  ocrPanel: document.getElementById('ocr-panel'),
  ocrRaw: document.getElementById('ocr-raw'),
  ocrNormalized: document.getElementById('ocr-normalized'),
  regionPreviews: document.getElementById('region-previews'),
};

const stageLabels = {
  setup: 'Preparacao',
  preprocess: 'Preprocessamento',
  orientation: 'Orientacao',
  global_ocr: 'OCR global',
  region_ocr: 'OCR regional',
  field_detection: 'Campos obrigatorios',
  nf_extraction: 'Extracao da NF',
  classification: 'Classificacao',
  debug_assets: 'Artefatos visuais',
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const setStatusCard = (title, description) => {
  elements.jobStatus.innerHTML = `
    <p class="status-title">${escapeHtml(title)}</p>
    <p class="muted">${escapeHtml(description)}</p>
  `;
};

const STATUS_LABELS = {
  idle: 'Aguardando',
  queued: 'Na fila',
  running: 'Em processamento',
  processing: 'Em processamento',
  completed: 'Concluído',
  failed: 'Falhou',
  success: 'Sucesso',
  error: 'Erro',
  warning: 'Aviso',
  skipped: 'Ignorado',
  approved: 'Aprovado',
  review: 'Em revisão',
  rejected: 'Rejeitado',
  valid: 'Válido',
  invalid: 'Inválido',
};

const LOG_LEVEL_LABELS = {
  info: 'Informação',
  debug: 'Depuração',
  warn: 'Aviso',
  warning: 'Aviso',
  error: 'Erro',
};

const translateLabel = (value, dictionary, fallback = '-') => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  return dictionary[normalized] || raw;
};

const syncQueueControls = () => {
  if (!elements.processAll) return;

  elements.processAll.disabled = state.processandoFila;
  elements.processAll.textContent = state.processandoFila
    ? `Processando fila (${state.filaDeProcessamento.length} restantes)`
    : 'Processar fila ao vivo';
};

const stopQueueProcessing = () => {
  state.filaDeProcessamento = [];
  state.processandoFila = false;
  syncQueueControls();
};

const cancelCurrentRender = () => {
  state.renderToken += 1;
};

const setActiveTestImageButton = (imageId) => {
  document.querySelectorAll('.test-image-button').forEach((button) => {
    const isActive = button.getAttribute('data-image-id') === imageId;
    button.classList.toggle('active', isActive);
    if (isActive) {
      button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
};

const renderTestImages = (items) => {
  if (!items.length) {
    elements.imageList.innerHTML = '<p class="muted">Nenhuma imagem encontrada em <code>test-images/</code>.</p>';
    syncQueueControls();
    return;
  }

  elements.imageList.innerHTML = items.map((item) => `
    <button
      type="button"
      class="test-image-button ${state.selectedImageId === item.id ? 'active' : ''}"
      data-image-id="${escapeHtml(item.id)}"
    >
      <strong>${escapeHtml(item.name)}</strong>
      <span class="muted">${escapeHtml(item.relativePath)}</span>
    </button>
  `).join('');
  syncQueueControls();
};

const renderProgress = (stages = {}) => {
  elements.progressGrid.innerHTML = Object.keys(stageLabels).map((stageKey) => {
    const stage = stages[stageKey] || {};
    return `
      <article class="progress-card ${escapeHtml(stage.status || 'idle')}">
        <span class="label">${escapeHtml(stageLabels[stageKey])}</span>
        <strong>${escapeHtml(translateLabel(stage.status || 'idle', STATUS_LABELS, 'Aguardando'))}</strong>
        <p class="muted">${escapeHtml(stage.message || 'Aguardando.')}</p>
      </article>
    `;
  }).join('');
};

const renderLogs = (logs = []) => {
  if (!logs.length) {
    elements.logList.innerHTML = '<p class="muted">Os logs amigaveis aparecerao aqui durante a analise.</p>';
    return;
  }

  elements.logList.innerHTML = logs.slice().reverse().map((entry) => `
    <article class="log-item">
      <div>
        <strong>${escapeHtml(translateLabel(entry.level || 'info', LOG_LEVEL_LABELS, 'Informação'))}</strong>
        <p>${escapeHtml(entry.message || '')}</p>
      </div>
      <span class="log-time">${escapeHtml(new Date(entry.at).toLocaleTimeString())}</span>
    </article>
  `).join('');
};

const renderSummary = async (session) => {
  const renderToken = state.renderToken + 1;
  state.renderToken = renderToken;
  elements.summaryPanel.classList.remove('hidden');
  elements.visualPanel.classList.remove('hidden');
  elements.regionsPanel.classList.remove('hidden');
  elements.ocrPanel.classList.remove('hidden');

  const classification = session.classification || {};
  const summary = session.summary || {};
  const requiredFields = session.requiredFields || {};
  const texts = session.texts || {};

  elements.summaryChips.innerHTML = `
    <span class="chip ${escapeHtml(summary.classification || 'neutral')}">${escapeHtml(translateLabel(summary.classification, STATUS_LABELS, 'Sem classificação'))}</span>
    <span class="chip neutral">NF: ${escapeHtml(summary.nf || 'nao detectada')}</span>
    <span class="chip neutral">Confianca: ${escapeHtml(summary.nfConfidence ?? '-')}</span>
    <span class="chip neutral">Score: ${escapeHtml(summary.businessScore ?? '-')}</span>
    <span class="chip neutral">Validacao: ${escapeHtml(translateLabel(session.validation ? session.validation.status : '-', STATUS_LABELS, '-'))}</span>
  `;

  elements.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="label">Imagem</span>
      <strong>${escapeHtml(session.source.displayName)}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Classificacao</span>
      <strong>${escapeHtml(translateLabel(summary.classification, STATUS_LABELS, '-'))}</strong>
    </article>
    <article class="summary-card">
      <span class="label">NF extraida</span>
      <strong>${escapeHtml(summary.nf || 'nao detectada')}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Confianca da NF</span>
      <strong>${escapeHtml(summary.nfConfidence ?? '-')}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Score de negocio</span>
      <strong>${escapeHtml(summary.businessScore ?? '-')}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Campos detectados</span>
      <strong>${escapeHtml(summary.requiredFieldCount ?? 0)}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Melhor orientacao</span>
      <strong>${escapeHtml(summary.bestOrientationId || '-')}</strong>
    </article>
    <article class="summary-card">
      <span class="label">Tempo total</span>
      <strong>${escapeHtml(session.timings ? `${(session.timings.totalMs / 1000).toFixed(1)}s` : '-')}</strong>
    </article>
  `;

  elements.fieldGrid.innerHTML = Object.keys(requiredFields).map((fieldKey) => {
    const field = requiredFields[fieldKey];
    return `
      <article class="field-card">
        <span class="label">${escapeHtml(field.label || fieldKey)}</span>
        <strong>${field.found ? 'Encontrado' : 'Nao encontrado'}</strong>
        <p class="muted">Confianca: ${escapeHtml(field.confidence ?? 0)}</p>
        <p class="muted">${escapeHtml(field.matchedText || field.method || '')}</p>
      </article>
    `;
  }).join('');

  elements.reasonList.innerHTML = (classification.reasons || []).map((reason) => `
    <article class="reason-card">
      <strong>Motivo</strong>
      <p class="muted">${escapeHtml(reason)}</p>
    </article>
  `).join('');

  elements.visualSteps.innerHTML = '';
  elements.regionHighlights.innerHTML = '';
  elements.ocrRaw.textContent = '';
  elements.ocrNormalized.textContent = '';
  elements.regionPreviews.innerHTML = '';

  for (const step of session.visualSteps || []) {
    if (renderToken !== state.renderToken) return;

    elements.visualSteps.innerHTML += `
      <article class="visual-card">
        <img src="${escapeHtml(step.url)}" alt="${escapeHtml(step.label)}" />
        <div class="body">
          <h3>${escapeHtml(step.label)}</h3>
          <p class="muted">${escapeHtml(step.description || '')}</p>
        </div>
      </article>
    `;
    if (elements.visualSteps.lastElementChild) {
      elements.visualSteps.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    await sleep(1000);
  }

  for (const highlight of session.regionHighlights || []) {
    if (renderToken !== state.renderToken) return;

    elements.regionHighlights.innerHTML += `
      <article class="region-card">
        <img src="${escapeHtml(highlight.url)}" alt="${escapeHtml(highlight.sourceVariantLabel)}" />
        <div class="body">
          <h3>${escapeHtml(highlight.sourceVariantLabel)}</h3>
          <p class="muted">${escapeHtml((highlight.boxes || []).length)} regioes destacadas.</p>
          ${(highlight.boxes || []).map((box) => `
            <article class="region-preview-card">
              <strong>${escapeHtml(box.label)}</strong>
              <p class="muted">Confianca: ${escapeHtml(box.confidence ?? '-')} | Score: ${escapeHtml(box.score ?? '-')} | PSM: ${escapeHtml(box.psm ?? '-')}</p>
              <p class="muted">${escapeHtml(box.textPreview || '')}</p>
            </article>
          `).join('')}
        </div>
      </article>
    `;
    if (elements.regionHighlights.lastElementChild) {
      elements.regionHighlights.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    await sleep(1200);
  }

  if (renderToken !== state.renderToken) return;

  elements.ocrRaw.textContent = texts.fullOcrRaw || '';
  elements.ocrNormalized.textContent = texts.fullOcrNormalized || '';
  elements.regionPreviews.innerHTML = (texts.regionPreviews || []).concat(texts.nfRoiPreviews || []).map((item) => `
    <article class="region-preview-card">
      <strong>${escapeHtml(item.label)}</strong>
      <p class="muted">Confianca: ${escapeHtml(item.confidence ?? '-')} | Score: ${escapeHtml(item.score ?? '-')} | PSM: ${escapeHtml(item.meta && item.meta.psm ? item.meta.psm : '-')}</p>
      <p>${escapeHtml(item.textPreview || '')}</p>
    </article>
  `).join('');
};

const pollJob = async (jobId) => {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  try {
    const response = await fetch(`/api/debug/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || 'Falha ao consultar o processo de depuração.');
    }

    renderProgress(job.stages);
    renderLogs(job.logs);
    setStatusCard(
      `Processo ${translateLabel(job.status, STATUS_LABELS, 'em andamento')}`,
      `${job.sourceLabel || 'Imagem'} em processamento local.`,
    );

    if (job.status === 'completed' && job.result) {
      state.lastSession = job.result;
      await renderSummary(job.result);

      if (state.processandoFila && state.filaDeProcessamento.length > 0) {
        await sleep(2500);
        processarProximoDaFila();
      } else {
        stopQueueProcessing();
      }
      return;
    }

    if (job.status === 'failed') {
      stopQueueProcessing();
      setStatusCard('Falha no processo', job.error ? job.error.message : 'Erro desconhecido.');
      return;
    }

    state.pollTimer = window.setTimeout(() => pollJob(jobId), 1000);
  } catch (error) {
    stopQueueProcessing();
    setStatusCard('Erro ao atualizar o processo', error.message);
  }
};

const createTestImageJob = async () => {
  if (!state.selectedImageId) {
    setStatusCard('Selecione uma imagem', 'Escolha uma imagem da pasta de testes antes de iniciar a análise.');
    return;
  }

  cancelCurrentRender();

  const response = await fetch('/api/debug/jobs/test-image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      relativePath: state.selectedImageId,
    }),
  });
  const job = await response.json();

  if (!response.ok) {
    throw new Error(job.error || 'Falha ao criar processo para a imagem de teste.');
  }

  state.currentJobId = job.id;
  setStatusCard('Processo criado', `Imagem ${state.selectedImageId} enviada para análise.`);
  renderProgress(job.stages);
  renderLogs(job.logs);
  pollJob(job.id);
};

const createUploadJob = async (file) => {
  cancelCurrentRender();
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/debug/jobs/upload', {
    method: 'POST',
    body: formData,
  });
  const job = await response.json();

  if (!response.ok) {
    throw new Error(job.error || 'Falha ao criar processo para o envio.');
  }

  state.currentJobId = job.id;
  setStatusCard('Arquivo recebido', `${file.name} enviado para análise.`);
  renderProgress(job.stages);
  renderLogs(job.logs);
  pollJob(job.id);
};

const loadTestImages = async () => {
  const response = await fetch('/api/debug/test-images');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Falha ao carregar imagens de teste.');
  }

  state.testImages = payload.items || [];

  if (!state.selectedImageId && payload.items.length) {
    state.selectedImageId = payload.items[0].id;
  }

  renderTestImages(payload.items);
};

const processarProximoDaFila = async () => {
  if (!state.filaDeProcessamento.length) {
    setStatusCard('Fila concluida', 'Todos os canhotos foram processados.');
    stopQueueProcessing();
    return;
  }

  const nextImageId = state.filaDeProcessamento.shift();
  state.selectedImageId = nextImageId;
  syncQueueControls();
  setActiveTestImageButton(nextImageId);

  try {
    await createTestImageJob();
  } catch (error) {
    stopQueueProcessing();
    setStatusCard('Erro', error.message);
  }
};

elements.imageList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-image-id]');
  if (!button) return;

  stopQueueProcessing();
  state.selectedImageId = button.getAttribute('data-image-id');
  await loadTestImages();
  createTestImageJob().catch((error) => setStatusCard('Erro', error.message));
});

elements.refreshImages.addEventListener('click', () => {
  loadTestImages().catch((error) => setStatusCard('Erro', error.message));
});

elements.uploadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  stopQueueProcessing();
  const file = elements.uploadInput.files && elements.uploadInput.files[0];
  if (!file) {
    setStatusCard('Selecione um arquivo', 'Escolha uma imagem antes de enviar.');
    return;
  }

  createUploadJob(file).catch((error) => setStatusCard('Erro', error.message));
});

elements.processAll.addEventListener('click', () => {
  state.filaDeProcessamento = (state.testImages || []).map((item) => item.id);

  if (!state.filaDeProcessamento.length) {
    setStatusCard('Aviso', 'Nenhuma imagem na pasta para processar.');
    stopQueueProcessing();
    return;
  }

  state.processandoFila = true;
  syncQueueControls();
  processarProximoDaFila();
});

renderProgress({});
renderLogs([]);
setStatusCard('Aguardando análise', 'Selecione uma imagem ou envie um novo canhoto.');
syncQueueControls();
loadTestImages().catch((error) => setStatusCard('Erro', error.message));
