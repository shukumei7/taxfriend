import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { readdir, mkdir, rename, unlink, writeFile, readFile, stat } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { scanPerson } from './src/scanner.js';
import { extractText } from './src/extractor.js';
import { classifyDocuments } from './src/analyzer.js';
import { generateReport } from './src/reporter.js';
import { generateChecklist, refreshChecklist } from './src/checklist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function validatePathSegment(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  if (!/^[\w\-. ]+$/.test(value)) return false;
  return true;
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });

// GET /api/years
app.get('/api/years', async (req, res) => {
  try {
    const inputDir = join(__dirname, 'input');
    await mkdir(inputDir, { recursive: true });
    const entries = await readdir(inputDir);
    const years = [];
    for (const entry of entries) {
      const s = await stat(join(inputDir, entry)).catch(() => null);
      if (s && s.isDirectory()) years.push(entry);
    }
    years.sort();
    res.json({ years });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/:year
app.get('/api/persons/:year', async (req, res) => {
  if (!validatePathSegment(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  try {
    const yearDir = join(__dirname, 'input', req.params.year);
    await mkdir(yearDir, { recursive: true });
    const entries = await readdir(yearDir);
    const persons = [];
    for (const entry of entries) {
      const s = await stat(join(yearDir, entry)).catch(() => null);
      if (s && s.isDirectory()) persons.push(entry);
    }
    persons.sort();
    res.json({ persons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  const { year, person } = req.body;
  if (!year || !person) {
    return res.status(400).json({ error: 'year and person are required' });
  }
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }

  const destDir = join(__dirname, 'input', year, person);
  await mkdir(destDir, { recursive: true });

  const uploaded = [];

  for (const file of req.files || []) {
    const ext = extname(file.originalname).toLowerCase();

    if (ext === '.zip') {
      try {
        const zip = new AdmZip(file.path);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          // Sanitize: strip leading slashes, normalize backslashes, reject traversal
          const safeName = entry.entryName.replace(/^[/\\]+/, '').replace(/\\/g, '/');
          if (safeName.includes('..') || safeName.startsWith('/')) continue;
          const outPath = join(destDir, safeName);
          // Ensure outPath stays within destDir
          if (!resolve(outPath).startsWith(resolve(destDir))) continue;
          // Create subdirectory and extract
          await mkdir(dirname(outPath), { recursive: true });
          zip.extractEntryTo(entry, dirname(outPath), false, true);
        }
        uploaded.push({ name: file.originalname, type: 'zip', size: file.size });
      } finally {
        await unlink(file.path).catch(() => {});
      }
    } else {
      const destPath = join(destDir, file.originalname);
      await rename(file.path, destPath).catch(async () => {
        // rename across drives fails; fall back to copy+delete
        const buf = await readFile(file.path);
        await writeFile(destPath, buf);
        await unlink(file.path).catch(() => {});
      });
      uploaded.push({ name: file.originalname, type: ext.slice(1) || 'file', size: file.size });
    }
  }

  res.json({ success: true, uploaded });
});

// POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { year, person } = req.body;
  if (!year || !person) {
    return res.status(400).json({ error: 'year and person are required' });
  }
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }

  // 5-minute timeout
  req.socket.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const files = await scanPerson(year, person, __dirname);
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No files found in input/${year}/${person}/`,
      });
    }

    const extractions = await Promise.all(files.map(f => extractText(f)));
    const analysis = await classifyDocuments(extractions, year, person);
    const { markdown, json } = await generateReport(year, person, analysis);

    const outDir = join(__dirname, 'output', String(year), person);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'report.md'), markdown, 'utf-8');
    await writeFile(join(outDir, 'report.json'), json, 'utf-8');

    const taxfriendDir = join(__dirname, 'input', String(year), person, '.taxfriend');
    await mkdir(taxfriendDir, { recursive: true });
    await writeFile(join(taxfriendDir, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf-8');
    await writeFile(join(taxfriendDir, 'report.md'), markdown, 'utf-8');

    // Post clarification requests to chat for any unclear documents
    const unclearDocs = (analysis.documents || []).filter(d => d.needs_clarification && d.clarification_question);
    if (unclearDocs.length > 0) {
      const chatPath = join(taxfriendDir, 'chat.json');
      let history = [];
      try {
        const raw = await readFile(chatPath, 'utf-8');
        history = JSON.parse(raw);
      } catch {
        history = [];
      }
      for (const doc of unclearDocs) {
        history.push({
          role: 'assistant',
          content: '[CLARIFICATION_REQUEST]',
          clarification: {
            file: doc.file,
            question: doc.clarification_question,
          },
        });
      }
      await writeFile(chatPath, JSON.stringify(history, null, 2), 'utf-8');
    }

    // Generate filing checklist
    const checklist = await generateChecklist(analysis, year, person);
    if (checklist) {
      await writeFile(join(taxfriendDir, 'checklist.json'), JSON.stringify(checklist, null, 2), 'utf-8');
    }

    res.json({ success: true, report: { markdown, json: analysis }, checklist });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/report/:year/:person
app.get('/api/report/:year/:person', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const reportPath = join(__dirname, 'output', year, person, 'report.json');
  try {
    const raw = await readFile(reportPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'Report not found' });
  }
});

// GET /api/analysis/:year/:person
app.get('/api/analysis/:year/:person', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const analysisPath = join(__dirname, 'input', year, person, '.taxfriend', 'analysis.json');
  try {
    const raw = await readFile(analysisPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'Analysis not found' });
  }
});

// GET /api/checklist/:year/:person
app.get('/api/checklist/:year/:person', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const checklistPath = join(__dirname, 'input', year, person, '.taxfriend', 'checklist.json');
  try {
    const raw = await readFile(checklistPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'Checklist not found' });
  }
});

// POST /api/checklist/:year/:person/refresh
app.post('/api/checklist/:year/:person/refresh', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const taxfriendDir = join(__dirname, 'input', year, person, '.taxfriend');
  const checklistPath = join(taxfriendDir, 'checklist.json');
  const analysisPath = join(taxfriendDir, 'analysis.json');

  let existingChecklist;
  try {
    const raw = await readFile(checklistPath, 'utf-8');
    existingChecklist = JSON.parse(raw);
  } catch {
    return res.status(404).json({ error: 'Checklist not found. Run analysis first.' });
  }

  let analysis;
  try {
    const raw = await readFile(analysisPath, 'utf-8');
    analysis = JSON.parse(raw);
  } catch {
    return res.status(404).json({ error: 'Analysis not found. Run analysis first.' });
  }

  const { chatHistory: incomingHistory = [] } = req.body || {};

  req.socket.setTimeout(130000);
  res.setTimeout(130000);

  try {
    const updated = await refreshChecklist(existingChecklist, incomingHistory, analysis);
    await writeFile(checklistPath, JSON.stringify(updated, null, 2), 'utf-8');
    res.json({ success: true, checklist: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/checklist/:year/:person/item/:itemId
app.patch('/api/checklist/:year/:person/item/:itemId', async (req, res) => {
  const { year, person, itemId } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const { status } = req.body || {};

  const validStatuses = ['done', 'missing', 'optional', 'not_applicable', 'needs_clarification'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const checklistPath = join(__dirname, 'input', year, person, '.taxfriend', 'checklist.json');

  let checklist;
  try {
    const raw = await readFile(checklistPath, 'utf-8');
    checklist = JSON.parse(raw);
  } catch {
    return res.status(404).json({ error: 'Checklist not found' });
  }

  let found = false;
  for (const cat of checklist.categories || []) {
    for (const item of cat.items || []) {
      if (item.id === itemId) {
        item.status = status;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    return res.status(404).json({ error: `Item '${itemId}' not found in checklist` });
  }

  // Recalculate summary
  let requiredDone = 0, requiredTotal = 0, optionalDone = 0, optionalTotal = 0, totalItems = 0;
  for (const cat of checklist.categories || []) {
    for (const item of cat.items || []) {
      totalItems++;
      if (item.priority === 'required' || item.priority === 'recommended') {
        requiredTotal++;
        if (item.status === 'done') requiredDone++;
      } else {
        optionalTotal++;
        if (item.status === 'done') optionalDone++;
      }
    }
  }
  checklist.summary = {
    total_items: totalItems,
    required_done: requiredDone,
    required_total: requiredTotal,
    optional_done: optionalDone,
    optional_total: optionalTotal,
    ready_to_file: requiredDone === requiredTotal && requiredTotal > 0 && (checklist.filing_blockers || []).length === 0,
  };

  try {
    await writeFile(checklistPath, JSON.stringify(checklist, null, 2), 'utf-8');
    res.json({ success: true, checklist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/:year/:person/:filename
app.get('/api/files/:year/:person/:filename', async (req, res) => {
  const { year, person, filename } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person) || !validatePathSegment(filename)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const inputDir = resolve(join(__dirname, 'input', year, person));
  const filePath = resolve(join(inputDir, filename));
  if (!filePath.startsWith(inputDir)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.sendFile(filePath, err => {
    if (err) res.status(404).json({ error: 'File not found' });
  });
});

// GET /api/chat/:year/:person
app.get('/api/chat/:year/:person', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const chatPath = join(__dirname, 'input', year, person, '.taxfriend', 'chat.json');
  try {
    const raw = await readFile(chatPath, 'utf-8');
    res.json({ history: JSON.parse(raw) });
  } catch {
    res.json({ history: [] });
  }
});

// DELETE /api/chat/:year/:person
app.delete('/api/chat/:year/:person', async (req, res) => {
  const { year, person } = req.params;
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }
  const chatPath = join(__dirname, 'input', year, person, '.taxfriend', 'chat.json');
  try {
    await unlink(chatPath);
  } catch {
    // file may not exist — that's fine
  }
  res.json({ success: true });
});

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { year, person, message } = req.body;
  if (!year || !person || !message) {
    return res.status(400).json({ error: 'year, person, and message are required' });
  }
  if (!validatePathSegment(year) || !validatePathSegment(person)) {
    return res.status(400).json({ error: 'Invalid year or person value' });
  }

  req.socket.setTimeout(120000);
  res.setTimeout(120000);

  const taxfriendDir = join(__dirname, 'input', String(year), person, '.taxfriend');
  const analysisPath = join(taxfriendDir, 'analysis.json');
  const chatPath = join(taxfriendDir, 'chat.json');

  // Load analysis for context
  let analysisContext = '';
  try {
    const raw = await readFile(analysisPath, 'utf-8');
    analysisContext = raw.slice(0, 3000);
  } catch {
    analysisContext = '{}';
  }

  // Load existing chat history
  let history = [];
  try {
    const raw = await readFile(chatPath, 'utf-8');
    history = JSON.parse(raw);
  } catch {
    history = [];
  }

  // Build conversation context from recent history (last 10 exchanges = 20 messages)
  const recentHistory = history.slice(-20);
  const historyText = recentHistory.length > 0
    ? '[Previous conversation:\n' + recentHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n]\n\n'
    : '';

  const systemPrompt = `You are an expert Canadian tax assistant for CRA (Canada Revenue Agency) filings. You have access to this taxpayer's full tax analysis. Answer questions clearly and specifically, referencing their actual documents and amounts where relevant. Always refer to CRA line numbers and form names. Be concise but thorough.

Tax Analysis Context:
${analysisContext}`;

  const fullPrompt = `${historyText}User: ${message}`;

  try {
    const response = await new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p', fullPrompt, '--system-prompt', systemPrompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', chunk => { stdout += chunk; });
      proc.stderr.on('data', chunk => { stderr += chunk; });
      proc.on('error', err => reject(new Error(`Failed to spawn claude: ${err.message}`)));

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Chat request timed out'));
      }, 115000);

      proc.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      });
    });

    // Append to history and save
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: response });
    await mkdir(taxfriendDir, { recursive: true });
    await writeFile(chatPath, JSON.stringify(history, null, 2), 'utf-8');

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET / → index.html (already handled by static middleware, but explicit fallback)
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = 9001;
app.listen(PORT, () => {
  process.stdout.write(`TaxFriend server running at http://localhost:${PORT}\n`);
});
