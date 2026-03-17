let queuedFiles = [];
let chatHistory = [];
let currentChecklist = null;

const yearSelect = document.getElementById('year-select');
const yearNew = document.getElementById('year-new');
const personSelect = document.getElementById('person-select');
const personNew = document.getElementById('person-new');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const uploadBtn = document.getElementById('upload-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const statusEl = document.getElementById('status');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getYear() {
  const newVal = yearNew.value.trim();
  return newVal || yearSelect.value;
}

function getPerson() {
  const newVal = personNew.value.trim();
  return newVal || personSelect.value;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_ICONS = {
  done: '✅',
  missing: '❌',
  optional: '⬜',
  not_applicable: '➖',
  needs_clarification: '⚠️',
};
const STATUS_CYCLE = ['done', 'missing', 'optional', 'not_applicable'];

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadYears();
  attachListeners();
  renderChatHistory();
}

async function loadYears() {
  try {
    const res = await fetch('/api/years');
    const { years } = await res.json();
    yearSelect.innerHTML = '<option value="">— select year —</option>';
    for (const y of years) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    }
  } catch {
    // silently ignore — server may not have input/ yet
  }
}

async function loadPersons(year) {
  personSelect.innerHTML = '<option value="">— select person —</option>';
  if (!year) return;
  try {
    const res = await fetch(`/api/persons/${encodeURIComponent(year)}`);
    const { persons } = await res.json();
    for (const p of persons) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      personSelect.appendChild(opt);
    }
  } catch {
    // silently ignore
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function attachListeners() {
  yearSelect.addEventListener('change', () => {
    if (!yearNew.value.trim()) {
      loadPersons(yearSelect.value);
      updateButtons();
    }
  });

  yearNew.addEventListener('input', () => {
    const val = yearNew.value.trim();
    loadPersons(val || yearSelect.value);
    updateButtons();
  });

  personSelect.addEventListener('change', () => {
    if (!personNew.value.trim()) {
      updateButtons();
      loadExistingAnalysis();
      loadChatHistory();
      loadChecklist();
    }
  });

  personNew.addEventListener('input', () => {
    updateButtons();
    loadExistingAnalysis();
    loadChatHistory();
    loadChecklist();
  });

  // Drop zone
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
  });

  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  uploadBtn.addEventListener('click', handleUpload);
  analyzeBtn.addEventListener('click', handleAnalyze);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(target).classList.add('active');
    });
  });

  // Chat
  document.getElementById('chat-send-btn').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
  document.getElementById('chat-clear-btn').addEventListener('click', clearChat);

  // Checklist
  document.getElementById('checklist-refresh-btn').addEventListener('click', refreshChecklist);
}

// ── File handling ─────────────────────────────────────────────────────────────

function addFiles(files) {
  for (const f of files) {
    if (!queuedFiles.some(q => q.name === f.name && q.size === f.size)) {
      queuedFiles.push(f);
    }
  }
  renderFileList();
  updateButtons();
}

function renderFileList() {
  fileList.innerHTML = '';
  for (let i = 0; i < queuedFiles.length; i++) {
    const f = queuedFiles[i];
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="file-icon">${fileIcon(f.name)}</span>
      <span class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
      <span class="file-size">${humanSize(f.size)}</span>
      <button class="file-remove" data-idx="${i}" title="Remove">&#x2715;</button>
    `;
    fileList.appendChild(li);
  }

  fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      queuedFiles.splice(idx, 1);
      renderFileList();
      updateButtons();
    });
  });
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (ext === 'zip') return '🗜️';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
  return '📝';
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Button state ──────────────────────────────────────────────────────────────

function updateButtons() {
  const hasTarget = !!(getYear() && getPerson());
  uploadBtn.disabled = !(hasTarget && queuedFiles.length > 0);
  analyzeBtn.disabled = !hasTarget;
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function handleUpload() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return showStatus('Please select a year and person first.', 'warning');
  if (queuedFiles.length === 0) return showStatus('No files queued for upload.', 'warning');

  showStatus(`<span class="spinner"></span> Uploading ${queuedFiles.length} file(s)...`, 'info');
  uploadBtn.disabled = true;

  const form = new FormData();
  form.append('year', year);
  form.append('person', person);
  for (const f of queuedFiles) form.append('files', f);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    queuedFiles = [];
    renderFileList();
    updateButtons();
    showStatus(`Uploaded ${data.uploaded.length} file(s) successfully.`, 'success');
  } catch (err) {
    showStatus(`Upload error: ${err.message}`, 'error');
    uploadBtn.disabled = false;
  }
}

// ── Analyze ───────────────────────────────────────────────────────────────────

async function loadExistingAnalysis() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return;

  try {
    const [analysisRes, reportRes] = await Promise.all([
      fetch(`/api/analysis/${encodeURIComponent(year)}/${encodeURIComponent(person)}`),
      fetch(`/api/report/${encodeURIComponent(year)}/${encodeURIComponent(person)}`),
    ]);

    if (!analysisRes.ok) return; // no saved analysis yet

    const analysis = await analysisRes.json();

    // Build markdown from saved report if available, otherwise skip markdown tab
    let markdown = null;
    if (reportRes.ok) {
      const reportJson = await reportRes.json();
      // report.json wraps the full analysis; the markdown is in report.md on disk
      // We can reconstruct a basic view from analysis if no markdown endpoint exists
      markdown = reportJson.markdown || null;
    }

    // Load markdown report from the .md file via a dedicated endpoint if needed
    if (!markdown) {
      const mdRes = await fetch(`/api/report-md/${encodeURIComponent(year)}/${encodeURIComponent(person)}`);
      if (mdRes.ok) markdown = await mdRes.text();
    }

    if (markdown) {
      document.getElementById('tab-report').innerHTML = renderMarkdown(markdown);
    }
    document.getElementById('report-json').textContent = JSON.stringify(analysis, null, 2);
    renderFillGuide(analysis.fill_guide);
    renderAdviceBar(analysis);
    showStatus('Loaded saved analysis for ' + person + ' (' + year + ').', 'info');
  } catch {
    // No saved analysis — tabs stay at placeholder, that's fine
  }
}

async function handleAnalyze() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return showStatus('Please select a year and person first.', 'warning');

  showStatus('<span class="spinner"></span> Analyzing documents with Claude... this may take 1–2 minutes', 'info');
  analyzeBtn.disabled = true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, person }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Analysis failed');

    renderReport(data.report.markdown, data.report.json);
    renderFillGuide(data.report.json.fill_guide);
    renderAdviceBar(data.report.json);
    if (data.checklist) renderChecklist(data.checklist);
    await loadChatHistory();
    showStatus('Analysis complete. Report generated.', 'success');

    const hasClarifications = chatHistory.some(
      m => m.role === 'assistant' && m.content === '[CLARIFICATION_REQUEST]'
    );
    if (hasClarifications) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="tab-chat"]').classList.add('active');
      document.getElementById('tab-chat').classList.add('active');
    } else {
      // Switch to Report tab
      document.querySelectorAll('.tab-btn')[0].click();
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      showStatus('Analysis timed out after 5 minutes.', 'error');
    } else {
      showStatus(`Analysis error: ${err.message}`, 'error');
    }
  } finally {
    analyzeBtn.disabled = !(getYear() && getPerson());
  }
}

// ── Report rendering ──────────────────────────────────────────────────────────

function renderReport(markdown, jsonData) {
  document.getElementById('tab-report').innerHTML = renderMarkdown(markdown);
  document.getElementById('report-json').textContent = JSON.stringify(jsonData, null, 2);
}

function renderFillGuide(fillGuide) {
  const el = document.getElementById('tab-fillguide');
  if (!fillGuide || !fillGuide.sections || fillGuide.sections.length === 0) {
    el.innerHTML = '<p class="placeholder">No fill guide data available. Run analysis first.</p>';
    return;
  }

  let html = `<span class="fill-guide-software-badge">${escHtml(fillGuide.software || 'TurboTax Canada')}</span>`;

  for (const section of fillGuide.sections) {
    html += `<div class="fill-guide-section">
      <div class="fill-guide-section-header">${escHtml(section.section)}</div>
      <ul class="fill-guide-steps">
        ${section.steps.map(s => `<li>${escHtml(s)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (fillGuide.final_steps && fillGuide.final_steps.length > 0) {
    html += `<div class="fill-guide-final">
      <h4>Final Steps Before Filing</h4>
      <ul class="fill-guide-steps">
        ${fillGuide.final_steps.map(s => `<li>${escHtml(s)}</li>`).join('')}
      </ul>
    </div>`;
  }

  el.innerHTML = html;
}

function renderAdviceBar(analysis) {
  const bar = document.getElementById('advice-bar');
  const missing = analysis.missing_documents || [];
  const advice = analysis.advice || [];

  if (missing.length === 0 && advice.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  const hasMissing = missing.length > 0;
  bar.className = `advice-bar${hasMissing ? ' has-missing' : ''}`;

  let html = '';
  if (hasMissing) {
    html += `<strong>⚠ Missing Documents (${missing.length})</strong><ul>` +
      missing.map(m => `<li>${escHtml(m)}</li>`).join('') + '</ul>';
  }
  if (advice.length > 0) {
    html += `<strong style="display:block;margin-top:${hasMissing ? 8 : 0}px">💡 Advice</strong><ul>` +
      advice.slice(0, 4).map(a => `<li>${escHtml(a)}</li>`).join('') + '</ul>';
  }
  bar.innerHTML = html;
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading 1
    if (line.startsWith('# ')) {
      out.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith('## ')) {
      out.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
      i++;
      continue;
    }

    // Heading 3
    if (line.startsWith('### ')) {
      out.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
      i++;
      continue;
    }

    // HR
    if (/^-{3,}$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Table: detect by leading pipe
    if (line.trim().startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    // List items
    if (/^[-*] /.test(line)) {
      const listItems = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        listItems.push(`<li>${inlineMarkdown(lines[i].slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${listItems.join('')}</ul>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      out.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    out.push(`<p>${inlineMarkdown(line)}</p>`);
    i++;
  }

  return out.join('\n');
}

function renderTable(tableLines) {
  // Filter out separator rows (---|---)
  const rows = tableLines.filter(l => !/^\|[\s|:-]+\|$/.test(l.trim()));
  if (rows.length === 0) return '';

  const parseRow = line =>
    line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  const [headerRow, ...bodyRows] = rows;
  const headers = parseRow(headerRow);

  const thead = `<thead><tr>${headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${bodyRows.map(r => {
    const cells = parseRow(r);
    return `<tr>${cells.map(c => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`;
  }).join('')}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

function inlineMarkdown(text) {
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  return text;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function loadChatHistory() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return;
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(year)}/${encodeURIComponent(person)}`);
    const data = await res.json();
    chatHistory = data.history || [];
    renderChatHistory();
  } catch {
    // silently ignore
  }
}

function renderClarificationBubble(msg) {
  const c = msg.clarification;
  const ext = (c.file.split('.').pop() || '').toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  const year = getYear();
  const person = getPerson();
  const fileUrl = `/api/files/${encodeURIComponent(year)}/${encodeURIComponent(person)}/${encodeURIComponent(c.file)}`;

  const iconMap = { pdf: '📄', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', zip: '🗜️', txt: '📝', csv: '📊' };
  const icon = iconMap[ext] || '📎';

  let previewHtml = '';
  if (isImage) {
    previewHtml = `<div class="chat-clarification-preview"><img src="${fileUrl}" alt="${escapeHtml(c.file)}" loading="lazy"></div>`;
  } else if (ext === 'pdf') {
    previewHtml = `<div class="chat-clarification-preview"><p class="pdf-preview-placeholder">📄 PDF — click "View" to open</p></div>`;
  }

  return `<div class="chat-msg assistant">
    <div class="chat-clarification">
      <div class="chat-clarification-file">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${escapeHtml(c.file)}</span>
        <a class="file-link" href="${fileUrl}" target="_blank" rel="noopener">View ↗</a>
      </div>
      ${previewHtml}
      <div class="chat-clarification-question">${escapeHtml(c.question)}</div>
    </div>
  </div>`;
}

function renderChatHistory() {
  const el = document.getElementById('chat-history');
  if (chatHistory.length === 0) {
    el.innerHTML = '<p class="placeholder" style="text-align:center;color:#aaa;margin-top:40px">Ask me anything about your taxes, deductions, or how to fill in your return.</p>';
    return;
  }
  el.innerHTML = chatHistory.map(msg => {
    if (msg.role === 'assistant' && msg.content === '[CLARIFICATION_REQUEST]' && msg.clarification) {
      return renderClarificationBubble(msg);
    }
    return `<div class="chat-msg ${msg.role}">${escapeHtml(msg.content)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  const year = getYear();
  const person = getPerson();
  if (!year || !person) {
    showStatus('Select a year and person first', 'warning');
    return;
  }

  // Add user message
  chatHistory.push({ role: 'user', content: message });
  input.value = '';
  renderChatHistory();

  // Show thinking
  const historyEl = document.getElementById('chat-history');
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'chat-msg thinking';
  thinkingEl.textContent = 'Claude is thinking...';
  historyEl.appendChild(thinkingEl);
  historyEl.scrollTop = historyEl.scrollHeight;

  const btn = document.getElementById('chat-send-btn');
  btn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, person, message }),
    });
    const data = await res.json();
    thinkingEl.remove();
    if (data.response) {
      chatHistory.push({ role: 'assistant', content: data.response });
      renderChatHistory();
      // Fire-and-forget background checklist refresh
      fetch(`/api/checklist/${encodeURIComponent(year)}/${encodeURIComponent(person)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatHistory: chatHistory.slice(-4) }),
      }).then(r => r.json()).then(d => { if (d.checklist) renderChecklist(d.checklist); }).catch(() => {});
    } else {
      showStatus(data.error || 'Chat failed', 'error');
      chatHistory.pop();
      renderChatHistory();
    }
  } catch (err) {
    thinkingEl.remove();
    showStatus('Chat error: ' + err.message, 'error');
    chatHistory.pop();
    renderChatHistory();
  } finally {
    btn.disabled = false;
  }
}

async function clearChat() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return;
  await fetch(`/api/chat/${encodeURIComponent(year)}/${encodeURIComponent(person)}`, { method: 'DELETE' });
  chatHistory = [];
  renderChatHistory();
}

// ── Checklist ─────────────────────────────────────────────────────────────────

function renderChecklist(checklist) {
  currentChecklist = checklist;
  const body = document.getElementById('checklist-body');
  const progressEl = document.getElementById('checklist-progress');
  const refreshBtn = document.getElementById('checklist-refresh-btn');
  const nextStepsEl = document.getElementById('checklist-next-steps');
  const blockersEl = document.getElementById('checklist-blockers');

  if (!checklist || !checklist.categories) {
    body.innerHTML = '<p class="placeholder">No checklist available. Run an analysis first.</p>';
    return;
  }

  // Progress bar
  const s = checklist.summary;
  const pct = s.required_total > 0 ? Math.round((s.required_done / s.required_total) * 100) : 0;
  progressEl.classList.remove('hidden');
  progressEl.innerHTML = `
    <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    <span class="progress-label">${s.required_done}/${s.required_total} required</span>
    <span class="${s.ready_to_file ? 'ready-badge' : 'not-ready-badge'}">${s.ready_to_file ? '✓ Ready to file' : 'Not ready'}</span>
  `;
  refreshBtn.classList.remove('hidden');

  // Categories
  let html = '';
  for (const cat of checklist.categories) {
    const doneCount = cat.items.filter(i => i.status === 'done').length;
    html += `<div class="checklist-category">
      <div class="checklist-category-header">
        <span class="cat-icon">${cat.icon || '📋'}</span>
        ${escapeHtml(cat.name)}
        <span class="checklist-category-count">${doneCount}/${cat.items.length}</span>
      </div>`;
    for (const item of cat.items) {
      const icon = STATUS_ICONS[item.status] || '⬜';
      const labelClass = item.status === 'done' ? 'checklist-item-label done' : 'checklist-item-label';
      html += `<div class="checklist-item" data-cat="${escapeHtml(cat.id)}" data-item="${escapeHtml(item.id)}" title="Click to toggle status">
        <span class="checklist-status-icon">${icon}</span>
        <div class="checklist-item-body">
          <div class="${labelClass}">${escapeHtml(item.label)}</div>
          ${item.detail ? `<div class="checklist-item-detail">${escapeHtml(item.detail)}</div>` : ''}
          ${item.value ? `<div class="checklist-item-value">${escapeHtml(item.value)}</div>` : ''}
          ${item.status === 'missing' && item.action ? `<div class="checklist-item-action">${escapeHtml(item.action)}</div>` : ''}
          ${item.cra_line ? `<div class="checklist-item-line">CRA Line ${item.cra_line}</div>` : ''}
        </div>
        <span class="checklist-priority-badge priority-${item.priority || 'optional'}">${item.priority || 'optional'}</span>
      </div>`;
    }
    html += '</div>';
  }
  body.innerHTML = html;

  // Next steps
  if (checklist.next_steps && checklist.next_steps.length > 0) {
    nextStepsEl.classList.remove('hidden');
    nextStepsEl.innerHTML = `<h4>Next Steps</h4><ol>${checklist.next_steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;
  } else {
    nextStepsEl.classList.add('hidden');
  }

  // Blockers
  if (checklist.filing_blockers && checklist.filing_blockers.length > 0) {
    blockersEl.classList.remove('hidden');
    blockersEl.innerHTML = `<h4>⛔ Filing Blockers</h4><ul>${checklist.filing_blockers.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
  } else {
    blockersEl.classList.add('hidden');
  }

  // Wire click handlers for status toggle
  document.querySelectorAll('.checklist-item').forEach(el => {
    el.addEventListener('click', () => toggleChecklistItem(el.dataset.cat, el.dataset.item));
  });
}

async function toggleChecklistItem(catId, itemId) {
  if (!currentChecklist) return;
  const cat = currentChecklist.categories.find(c => c.id === catId);
  if (!cat) return;
  const item = cat.items.find(i => i.id === itemId);
  if (!item) return;

  const currentIdx = STATUS_CYCLE.indexOf(item.status);
  const nextStatus = STATUS_CYCLE[(currentIdx + 1) % STATUS_CYCLE.length];

  const year = getYear();
  const person = getPerson();
  try {
    const res = await fetch(`/api/checklist/${encodeURIComponent(year)}/${encodeURIComponent(person)}/item/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await res.json();
    if (data.checklist) renderChecklist(data.checklist);
  } catch (err) {
    showStatus('Failed to update item: ' + err.message, 'error');
  }
}

async function loadChecklist() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return;
  try {
    const res = await fetch(`/api/checklist/${encodeURIComponent(year)}/${encodeURIComponent(person)}`);
    if (res.ok) {
      const data = await res.json();
      renderChecklist(data);
    }
  } catch {}
}

async function refreshChecklist() {
  const year = getYear();
  const person = getPerson();
  if (!year || !person) return;

  const btn = document.getElementById('checklist-refresh-btn');
  btn.disabled = true;
  btn.textContent = '↻ Refreshing...';

  try {
    const res = await fetch(`/api/checklist/${encodeURIComponent(year)}/${encodeURIComponent(person)}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatHistory: chatHistory.slice(-6) }),
    });
    const data = await res.json();
    if (data.checklist) {
      renderChecklist(data.checklist);
      showStatus('Checklist updated by Claude', 'success');
    }
  } catch (err) {
    showStatus('Refresh failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh with Claude';
  }
}

// ── Status messages ───────────────────────────────────────────────────────────

function showStatus(html, type = 'info') {
  statusEl.innerHTML = `<div class="status-msg status-${type}">${html}</div>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
