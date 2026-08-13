'use strict';

(() => {
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const RISK_LABELS = {
    low: 'ความเสี่ยงต่ำ',
    medium: 'ความเสี่ยงปานกลาง',
    high: 'ความเสี่ยงสูง',
    critical: 'ความเสี่ยงวิกฤต'
  };
  const SEVERITY_LABELS = {
    low: 'ต่ำ',
    medium: 'ปานกลาง',
    high: 'สูง',
    critical: 'วิกฤต'
  };

  const elements = {
    form: document.querySelector('#analysis-form'),
    modeTabs: [...document.querySelectorAll('.mode-tab')],
    textPanel: document.querySelector('#text-panel'),
    imagePanel: document.querySelector('#image-panel'),
    messageInput: document.querySelector('#message-input'),
    characterCount: document.querySelector('#character-count'),
    imageInput: document.querySelector('#image-input'),
    dropZone: document.querySelector('#drop-zone'),
    previewCard: document.querySelector('#image-preview-card'),
    preview: document.querySelector('#image-preview'),
    filename: document.querySelector('#image-filename'),
    filesize: document.querySelector('#image-filesize'),
    removeImage: document.querySelector('#remove-image'),
    clientError: document.querySelector('#client-error'),
    analyzeButton: document.querySelector('#analyze-button'),
    cancelButton: document.querySelector('#cancel-button'),
    loadingPanel: document.querySelector('#loading-panel'),
    loadingMessage: document.querySelector('#loading-message'),
    errorPanel: document.querySelector('#error-panel'),
    errorTitle: document.querySelector('#error-title'),
    errorMessage: document.querySelector('#error-message'),
    errorDetails: document.querySelector('#error-details'),
    resultPanel: document.querySelector('#result-panel'),
    riskCard: document.querySelector('#risk-card'),
    resultTitle: document.querySelector('#result-title'),
    resultSummary: document.querySelector('#result-summary'),
    riskScore: document.querySelector('#risk-score'),
    scoreFill: document.querySelector('#score-fill'),
    reviewNotice: document.querySelector('#review-notice'),
    indicatorCount: document.querySelector('#indicator-count'),
    indicatorList: document.querySelector('#indicator-list'),
    actionList: document.querySelector('#action-list'),
    confidenceValue: document.querySelector('#confidence-value'),
    processingTime: document.querySelector('#processing-time'),
    technicalList: document.querySelector('#technical-list')
  };

  let mode = 'text';
  let selectedImage = null;
  let previewUrl = null;
  let activeController = null;
  let submissionPending = false;
  let loadingTimer = null;

  function setMode(nextMode) {
    if (submissionPending || (nextMode !== 'text' && nextMode !== 'image')) return;
    mode = nextMode;
    elements.modeTabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    elements.textPanel.hidden = mode !== 'text';
    elements.imagePanel.hidden = mode !== 'image';
    clearClientError();
  }

  function generateRequestId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function showClientError(message) {
    elements.clientError.textContent = message;
    elements.clientError.hidden = false;
  }

  function clearClientError() {
    elements.clientError.textContent = '';
    elements.clientError.hidden = true;
  }

  function clearPreview() {
    selectedImage = null;
    elements.imageInput.value = '';
    elements.preview.removeAttribute('src');
    elements.previewCard.hidden = true;
    elements.dropZone.hidden = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function chooseImage(fileList) {
    clearClientError();
    const files = [...fileList];
    if (files.length !== 1) {
      showClientError('กรุณาเลือกภาพเพียงหนึ่งไฟล์');
      return;
    }
    const file = files[0];
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      showClientError('รองรับเฉพาะไฟล์ PNG, JPEG และ WebP');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showClientError('ไฟล์มีขนาดใหญ่เกิน 5 MiB กรุณาเลือกไฟล์ที่เล็กลง');
      return;
    }
    if (!file.size) {
      showClientError('ไฟล์ภาพว่างเปล่า');
      return;
    }
    clearPreview();
    selectedImage = file;
    previewUrl = URL.createObjectURL(file);
    elements.preview.src = previewUrl;
    elements.filename.textContent = file.name;
    elements.filesize.textContent = formatBytes(file.size);
    elements.dropZone.hidden = true;
    elements.previewCard.hidden = false;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
      reader.readAsDataURL(file);
    });
  }

  function base64FromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('INVALID_DATA_URL');
    }
    const separator = dataUrl.indexOf(',');
    if (separator < 0) throw new Error('INVALID_DATA_URL');
    const base64 = dataUrl.slice(separator + 1);
    if (!base64) throw new Error('EMPTY_IMAGE_DATA');
    return base64;
  }

  async function buildRequest() {
    const requestId = generateRequestId();
    if (mode === 'text') {
      const content = elements.messageInput.value.trim();
      if (!content) throw new Error('กรุณาใส่ข้อความที่ต้องการตรวจสอบ');
      return {
        requestId,
        body: {
          input_type: 'text',
          content,
          request_id: requestId,
          language: 'th',
          metadata: { source: 'web-demo' }
        }
      };
    }
    if (!selectedImage) throw new Error('กรุณาเลือกภาพหน้าจอที่ต้องการตรวจสอบ');
    if (!ACCEPTED_IMAGE_TYPES.has(selectedImage.type)) throw new Error('รองรับเฉพาะไฟล์ PNG, JPEG และ WebP');
    if (selectedImage.size > MAX_IMAGE_BYTES) throw new Error('ไฟล์มีขนาดใหญ่เกิน 5 MiB กรุณาเลือกไฟล์ที่เล็กลง');
    const dataUrl = await readAsDataUrl(selectedImage);
    const base64 = base64FromDataUrl(dataUrl);
    return {
      requestId,
      body: {
        input_type: 'image',
        content: { mime_type: selectedImage.type, data: base64 },
        request_id: requestId,
        language: 'th',
        metadata: { source: 'web-demo' }
      }
    };
  }

  function setLoading(active) {
    elements.analyzeButton.disabled = active;
    elements.modeTabs.forEach((tab) => { tab.disabled = active; });
    elements.messageInput.disabled = active;
    elements.imageInput.disabled = active;
    elements.dropZone.disabled = active;
    elements.loadingPanel.hidden = !active;
    elements.cancelButton.hidden = !active;
    if (!active && loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function beginLoadingMessages() {
    const messages = mode === 'image'
      ? ['กำลังเตรียมข้อมูล...', 'กำลังอ่านข้อความจากภาพ...', 'กำลังวิเคราะห์ความเสี่ยง...', 'กำลังสร้างคำแนะนำ...']
      : ['กำลังเตรียมข้อมูล...', 'กำลังวิเคราะห์ความเสี่ยง...', 'กำลังสร้างคำแนะนำ...'];
    let index = 0;
    elements.loadingMessage.textContent = messages[index];
    loadingTimer = setInterval(() => {
      index = Math.min(index + 1, messages.length - 1);
      elements.loadingMessage.textContent = messages[index];
    }, mode === 'image' ? 4000 : 2500);
  }

  function appendTextElement(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = typeof text === 'string' ? text : '';
    parent.append(element);
    return element;
  }

  function renderIndicators(indicators) {
    elements.indicatorList.replaceChildren();
    elements.indicatorCount.textContent = String(indicators.length);
    if (!indicators.length) {
      appendTextElement(elements.indicatorList, 'p', 'empty-state', 'ไม่พบตัวบ่งชี้ความเสี่ยงที่มีหลักฐานรองรับ');
      return;
    }
    for (const indicator of indicators) {
      const card = document.createElement('article');
      card.className = 'indicator-item';
      card.dataset.severity = indicator.severity;
      const heading = document.createElement('div');
      heading.className = 'indicator-heading';
      const titleGroup = document.createElement('div');
      appendTextElement(titleGroup, 'strong', '', indicator.title);
      appendTextElement(titleGroup, 'code', '', indicator.code);
      heading.append(titleGroup);
      appendTextElement(heading, 'span', 'severity-badge', SEVERITY_LABELS[indicator.severity] || indicator.severity);
      card.append(heading);
      const evidence = document.createElement('blockquote');
      evidence.textContent = indicator.evidence;
      card.append(evidence);
      appendTextElement(card, 'p', 'indicator-explanation', indicator.explanation);
      elements.indicatorList.append(card);
    }
  }

  function renderActions(actions) {
    elements.actionList.replaceChildren();
    if (!actions.length) {
      appendTextElement(elements.actionList, 'li', 'empty-state', 'ยังไม่มีคำแนะนำเพิ่มเติมสำหรับผลนี้');
      return;
    }
    actions.forEach((action) => appendTextElement(elements.actionList, 'li', '', action));
  }

  function addTechnicalDetail(label, value) {
    appendTextElement(elements.technicalList, 'dt', '', label);
    appendTextElement(elements.technicalList, 'dd', '', value == null ? '—' : String(value));
  }

  function renderResult(result, requestId) {
    const riskLevel = Object.prototype.hasOwnProperty.call(RISK_LABELS, result.risk_level) ? result.risk_level : 'low';
    const score = Number.isFinite(result.risk_score) ? Math.max(0, Math.min(100, result.risk_score)) : 0;
    const indicators = Array.isArray(result.indicators) ? result.indicators : [];
    const actions = Array.isArray(result.recommended_actions) ? result.recommended_actions : [];
    const confidence = Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0;
    const processingMs = Number.isFinite(result.processing_time_ms) ? Math.max(0, result.processing_time_ms) : 0;

    elements.riskCard.dataset.risk = riskLevel;
    elements.resultTitle.textContent = RISK_LABELS[riskLevel];
    elements.resultSummary.textContent = typeof result.summary === 'string' ? result.summary : '';
    elements.riskScore.textContent = String(score);
    elements.scoreFill.style.width = `${score}%`;
    elements.reviewNotice.hidden = result.needs_human_review !== true;
    renderIndicators(indicators);
    renderActions(actions);
    elements.confidenceValue.textContent = `ความมั่นใจของการวิเคราะห์: ${Math.round(confidence * 100)}%`;
    elements.processingTime.textContent = `ใช้เวลาวิเคราะห์ ${(processingMs / 1000).toFixed(1)} วินาที`;
    elements.technicalList.replaceChildren();
    addTechnicalDetail('Analysis ID', result.analysis_id);
    addTechnicalDetail('API version', result.api_version);
    addTechnicalDetail('Taxonomy version', result.taxonomy_version);
    addTechnicalDetail('Scoring version', result.scoring_version);
    addTechnicalDetail('Processing time', `${processingMs} ms`);
    addTechnicalDetail('Request ID', requestId);
    elements.resultPanel.hidden = false;
    elements.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function safeErrorCopy(status, payload) {
    const code = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : '';
    const serverMessage = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : '';
    if (status === 413) return { title: 'ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด', message: 'กรุณาลดขนาดไฟล์หรือข้อความแล้วลองอีกครั้ง' };
    if (status === 422 && code === 'IMAGE_TEXT_EXTRACTION_FAILED') {
      return { title: 'ไม่สามารถอ่านข้อความจากภาพได้', message: 'ลองใช้ภาพที่ชัดขึ้นหรือใส่ข้อความด้วยตนเอง' };
    }
    if (status === 422) return { title: 'ไม่สามารถวิเคราะห์ข้อมูลนี้ได้', message: serverMessage || 'ผลการวิเคราะห์ไม่ผ่านการตรวจสอบข้อมูล' };
    if (status === 503) return { title: 'ระบบวิเคราะห์ไม่พร้อมใช้งานชั่วคราว', message: 'กรุณาลองใหม่อีกครั้ง' };
    if (status === 500) return { title: 'เกิดข้อผิดพลาดภายในระบบ', message: 'กรุณาลองใหม่ในภายหลัง' };
    if (status === 400) return { title: 'ข้อมูลที่ส่งไม่ถูกต้อง', message: serverMessage || 'กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง' };
    return { title: 'ไม่สามารถดำเนินการได้', message: 'กรุณาลองใหม่อีกครั้ง' };
  }

  function renderError(status, payload) {
    const copy = safeErrorCopy(status, payload);
    elements.errorTitle.textContent = copy.title;
    elements.errorMessage.textContent = copy.message;
    elements.errorDetails.replaceChildren();
    const details = payload && payload.error && Array.isArray(payload.error.details) ? payload.error.details : [];
    for (const detail of details.slice(0, 5)) {
      if (!detail || typeof detail.issue !== 'string') continue;
      const prefix = typeof detail.field === 'string' ? `${detail.field}: ` : '';
      appendTextElement(elements.errorDetails, 'li', '', `${prefix}${detail.issue}`);
    }
    elements.errorDetails.hidden = !elements.errorDetails.childElementCount;
    elements.errorPanel.hidden = false;
    elements.errorPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function parseResponse(response) {
    try {
      const payload = await response.json();
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    } catch {
      return {};
    }
  }

  async function submitAnalysis(event) {
    event.preventDefault();
    if (submissionPending) return;
    submissionPending = true;
    clearClientError();
    elements.errorPanel.hidden = true;
    elements.resultPanel.hidden = true;

    let request;
    try {
      request = await buildRequest();
    } catch (error) {
      submissionPending = false;
      showClientError(error && error.message ? error.message : 'ไม่สามารถเตรียมข้อมูลได้');
      return;
    }

    activeController = new AbortController();
    setLoading(true);
    beginLoadingMessages();
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: activeController.signal
      });
      const payload = await parseResponse(response);
      if (!response.ok) {
        renderError(response.status, payload);
        return;
      }
      renderResult(payload, request.requestId);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        showClientError('ยกเลิกการรอผลแล้ว การประมวลผลฝั่งระบบอาจยังดำเนินต่อ');
      } else {
        renderError(503, {});
      }
    } finally {
      activeController = null;
      submissionPending = false;
      setLoading(false);
    }
  }

  elements.modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
  elements.messageInput.addEventListener('input', () => {
    elements.characterCount.textContent = `${elements.messageInput.value.length.toLocaleString('th-TH')} / 10,000`;
  });
  elements.dropZone.addEventListener('click', () => elements.imageInput.click());
  elements.imageInput.addEventListener('change', () => chooseImage(elements.imageInput.files));
  elements.removeImage.addEventListener('click', clearPreview);
  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('is-dragging');
  });
  elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-dragging'));
  elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('is-dragging');
    chooseImage(event.dataTransfer.files);
  });
  elements.cancelButton.addEventListener('click', () => activeController?.abort());
  elements.form.addEventListener('submit', submitAnalysis);
})();
