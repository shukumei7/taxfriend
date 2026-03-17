import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractJson } from './spawn-utils.js';
import { callLLM, providerSupportsVision, getStageProvider } from './llm-providers.js';
import { pdfToImages } from './extractor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are an expert Canadian tax assistant with deep knowledge of the CRA T1 General return, all common tax slips (T4, T4A, T4E, T5, T5008, T3, T2202, RRSP receipts), deductions, and credits for the current tax year. Always respond with valid JSON only — no markdown, no explanations outside the JSON structure.`;

// ── Route A/B helpers ─────────────────────────────────────────────────────────

function makeScannedResult(extraction) {
  return {
    file: extraction.file,
    document_type: 'Unknown',
    issuer: '',
    fields: {},
    notes: 'PDF appears to be a scanned image with no extractable text layer.',
    needs_clarification: true,
    clarification_question: `The file "${extraction.file}" could not be read — it appears to be a scanned PDF with no text layer. Please provide: (1) what type of document this is, (2) the issuing organization, and (3) the total dollar amount or key figures shown.`,
  };
}

function makeImageResult(extraction) {
  const dateMatch = extraction.file.match(/PXL_(\d{4})(\d{2})(\d{2})/);
  const dateHint = dateMatch ? ` (photographed approx. ${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]})` : '';

  return {
    file: extraction.file,
    document_type: 'Unknown',
    issuer: '',
    fields: {},
    notes: `Image file${dateHint} — content cannot be extracted automatically.`,
    needs_clarification: true,
    clarification_question: `The image file "${extraction.file}"${dateHint} could not be read automatically. What type of document is this? Please provide: (1) document type (e.g. T4, RRSP receipt, medical receipt, donation receipt), (2) issuing organization, and (3) total amount or key figures shown.`,
  };
}

function makeFallbackDoc(extraction) {
  return {
    file: extraction.file,
    document_type: 'Unknown',
    issuer: '',
    fields: {},
    notes: 'LLM unavailable — manual classification required',
    needs_clarification: false,
    clarification_question: '',
  };
}

// ── Phase 1: classify one document ───────────────────────────────────────────

function buildSingleDocPrompt(extraction, year, person, hasImages = false) {
  // When images are provided, omit extracted text — form labels confuse vision models
  const content = hasImages
    ? '[See attached image(s) — read all values directly from the document.]'
    : extraction.error
      ? `[Error reading file: ${extraction.error}]`
      : extraction.text.slice(0, 4000);

  return `Tax year: ${year}
Taxpayer: ${person}
File: ${extraction.file} (type: ${extraction.type})

Classify this single tax document and return JSON with this exact structure:
{
  "file": "${extraction.file}",
  "document_type": "T4|T4A|T4E|T5|T5008|T3|RRSP|Donation|Medical|Tuition|PropertyTax|RentReceipt|ChildCare|HomeOffice|BusinessExpense|Other|Unknown",
  "issuer": "employer or institution name if found, else empty string",
  "fields": {},
  "notes": "any warnings or observations about this document",
  "needs_clarification": false,
  "clarification_question": ""
}

Rules:
- fields: include all CRA box numbers and amounts found (e.g. box_14_employment_income, box_22_income_tax_deducted)
- needs_clarification: set true if document is unclear, unreadable, blank, or ambiguous
- clarification_question: specific question to ask the taxpayer if needs_clarification is true

Document content:
${content}`;
}

// Route C: single-pass for short text
async function classifySinglePass(extraction, year, person, images = []) {
  // Try vision-capable stage first if images available (prompt omits text to avoid confusing model)
  if (images.length > 0) {
    try {
      const prompt = buildSingleDocPrompt(extraction, year, person, true);
      const responseText = await callLLM(prompt, SYSTEM_PROMPT, { stage: 'partition', timeoutMs: 90000, images });
      const parsed = extractJson(responseText);
      if (parsed) return parsed;
    } catch {
      // vision LLM unavailable (quota, no key, etc.) — fall through to text-only
    }
  }

  // Text-only synthesis (no images sent, include extracted text)
  try {
    const prompt = buildSingleDocPrompt(extraction, year, person, false);
    const responseText = await callLLM(prompt, SYSTEM_PROMPT, { stage: 'synthesis', timeoutMs: 90000 });
    const parsed = extractJson(responseText);
    if (parsed) return parsed;
  } catch {
    // fall through
  }

  return makeFallbackDoc(extraction);
}

// Route D: 3-stage pipeline for long text

function buildStage1Prompt(text) {
  return `You are analyzing a Canadian CRA tax document. Based on the extracted text below, return JSON with this exact structure:
{
  "doc_type": "T4|T4A|T4E|T5|T5008|T3|T2202|Other|Unknown",
  "issuer": "name of employer or financial institution if found, else empty string",
  "is_blank_template": false,
  "boxes": [
    { "number": "14", "label": "Employment income", "value": "12576.14", "has_value": true }
  ],
  "data_dense_regions": [
    "brief description of where actual values appear in the text, e.g. 'lines 45-80 contain box values'"
  ]
}

Rules:
- boxes: list every CRA box number found in the text. For each, extract the value if present adjacent to the label, or set has_value: false if blank
- is_blank_template: set true if ALL boxes appear to have no filled values (form template only)
- is_blank_template overrides everything — if true, no further extraction is needed

Document text (first 3000 chars):
${text.slice(0, 3000)}`;
}

function buildStage2Prompt(chunk, docType) {
  return `You are extracting field values from a section of a Canadian CRA tax document (type: ${docType}).
Extract ONLY box numbers and their corresponding dollar amounts or values from this text section.
Return JSON: { "fields": { "box_14_employment_income": 12576.14, "box_22_income_tax_deducted": 231.81 } }
Use snake_case keys with box number and field name. Only include boxes where you can see an actual numeric value — skip blank boxes.

Text section:
${chunk}`;
}

function buildStage3Prompt(extraction, docType, issuer, mergedFields) {
  return `You are producing a final classification for a Canadian tax document.

Document type identified: ${docType}
Issuer: ${issuer}
File: ${extraction.file}

All extracted field values across the document:
${JSON.stringify(mergedFields)}

Return JSON with this exact structure:
{
  "file": "${extraction.file}",
  "document_type": "${docType}",
  "issuer": "${issuer}",
  "fields": {},
  "notes": "brief summary of what was found and any concerns",
  "needs_clarification": false,
  "clarification_question": ""
}

Set needs_clarification true only if critical values are missing or ambiguous.`;
}

function splitIntoChunks(text, chunkSize, overlap, maxChunks) {
  const chunks = [];
  let offset = 0;
  const limit = Math.min(text.length, chunkSize * maxChunks);
  while (offset < limit) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += chunkSize - overlap;
    if (chunks.length >= maxChunks) break;
  }
  return chunks;
}

function mergeFields(partitionResults) {
  const merged = {};
  for (const result of partitionResults) {
    const fields = result?.fields || {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number' && value !== 0) {
        // Prefer non-zero values; keep existing non-zero if already set
        if (!merged[key] || merged[key] === 0) {
          merged[key] = value;
        }
      }
    }
  }
  return merged;
}

async function classifyMultiStage(extraction, year, person, images = []) {
  const text = extraction.text || '';

  // Stage 1: structure agent
  process.stderr.write(`[analyze] ${extraction.file}: stage1 structure\n`);
  let stage1;
  try {
    const responseText = await callLLM(buildStage1Prompt(text), SYSTEM_PROMPT, { stage: 'structure', timeoutMs: 90000, images });
    stage1 = extractJson(responseText);
  } catch {
    stage1 = null;
  }

  if (!stage1) {
    return classifySinglePass(extraction, year, person, images);
  }

  // Blank template shortcut
  if (stage1.is_blank_template === true) {
    process.stderr.write(`[analyze] ${extraction.file}: is_blank_template — skipping\n`);
    return {
      file: extraction.file,
      document_type: stage1.doc_type || 'Unknown',
      issuer: stage1.issuer || '',
      fields: {},
      notes: 'Document appears to be a blank form template with no filled values. Please obtain the actual completed slip.',
      needs_clarification: true,
      clarification_question: `The file "${extraction.file}" appears to be a blank ${stage1.doc_type || 'tax form'} template with no values filled in. Please provide the actual completed slip, or enter the values manually: employer name, employment income (Box 14), income tax deducted (Box 22), CPP contributions (Box 16), and EI premiums (Box 18).`,
    };
  }

  const docType = stage1.doc_type || 'Unknown';
  const issuer = stage1.issuer || '';

  // Stage 2: parallel partition extraction
  const chunks = splitIntoChunks(text, 2000, 200, 5);
  process.stderr.write(`[analyze] ${extraction.file}: stage2 ${chunks.length} partitions in parallel\n`);

  const partitionResults = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const responseText = await callLLM(buildStage2Prompt(chunk, docType), SYSTEM_PROMPT, { stage: 'partition', timeoutMs: 90000, images });
        return extractJson(responseText);
      } catch {
        return null;
      }
    })
  );

  const mergedFields = mergeFields(partitionResults.filter(Boolean));

  // Stage 3: synthesis agent
  process.stderr.write(`[analyze] ${extraction.file}: stage3 synthesis\n`);
  try {
    const responseText = await callLLM(
      buildStage3Prompt(extraction, docType, issuer, mergedFields),
      SYSTEM_PROMPT,
      { stage: 'synthesis', timeoutMs: 90000, images }
    );
    const parsed = extractJson(responseText);
    if (parsed) return parsed;
  } catch {
    // fall through
  }

  // Fallback: assemble from what we have
  return {
    file: extraction.file,
    document_type: docType,
    issuer,
    fields: mergedFields,
    notes: 'Multi-stage extraction completed; synthesis step unavailable.',
    needs_clarification: false,
    clarification_question: '',
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function classifyOne(extraction, year, person) {
  const text = extraction.text || '';
  const len = text.trim().length;

  // Vision path: convert PDF to images if provider supports it
  const isPdf = extraction.file.toLowerCase().endsWith('.pdf');
  let docImages = [];

  if (isPdf) {
    try {
      const { providerConfig } = getStageProvider('partition');
      if (providerSupportsVision(providerConfig)) {
        const imagesDir = join(__dirname, '..', 'input', String(year), String(person), '.taxfriend', 'images');
        docImages = await pdfToImages(join(__dirname, '..', 'input', String(year), String(person), extraction.file), imagesDir);
        if (docImages.length > 0) {
          process.stderr.write(`[analyze] ${extraction.file}: vision path, ${docImages.length} page image(s)\n`);
        }
      }
    } catch {
      // provider config unavailable — fall through to text routes
    }
  }

  if (docImages.length > 0) {
    // Vision always uses single-pass — vision models see full pages, chunking is for text overflow only.
    // classifySinglePass will try partition (vision) first, fall back to synthesis (text) if unavailable.
    process.stderr.write(`[analyze] ${extraction.file}: vision single-pass, ${docImages.length} page(s)\n`);
    return classifySinglePass(extraction, year, person, docImages);
  }

  // Route A: scanned PDF
  if (extraction.error || len < 50) {
    process.stderr.write(`[analyze] ${extraction.file}: scanned/blank, skipping LLM\n`);
    return makeScannedResult(extraction);
  }

  // Route B: image
  if (extraction.type === 'image') {
    process.stderr.write(`[analyze] ${extraction.file}: image, skipping LLM\n`);
    return makeImageResult(extraction);
  }

  // Route C: short text — single pass
  if (len < 2000) {
    process.stderr.write(`[analyze] ${extraction.file}: short (${len} chars), single pass\n`);
    return classifySinglePass(extraction, year, person);
  }

  // Route D: long text — 3-stage pipeline
  process.stderr.write(`[analyze] ${extraction.file}: long (${len} chars), 3-stage pipeline\n`);
  return classifyMultiStage(extraction, year, person);
}

// ── Phase 2: aggregate all classified docs into summary/t1_lines/fill_guide ──

// Compact document summary for the advisory prompt (no raw text, just classified results)
function buildAdvisoryPrompt(documents, t1_lines, year, person) {
  const compact = documents.map(d => ({
    file: d.file,
    type: d.document_type,
    issuer: d.issuer,
    fields: d.fields,
    needs_clarification: d.needs_clarification,
  }));

  return `Tax year: ${year}
Taxpayer: ${person}

Classified documents:
${JSON.stringify(compact, null, 2)}

Computed T1 lines: ${JSON.stringify(t1_lines)}

Return a JSON object with ONLY these three fields:
{
  "missing_documents": ["list of commonly needed slips NOT present given what IS here"],
  "advice": ["specific actionable advice referencing real amounts and issuers"],
  "fill_guide": {
    "software": "TurboTax Canada / Intuit TurboTax",
    "sections": [
      { "section": "Employment Income", "steps": ["Navigate to Income > Employment Income > T4 Slips", "Add T4: employer name, Box 14 amount, ..."] }
    ],
    "final_steps": ["step 1", "step 2"]
  }
}

Rules:
- advice: specific and actionable, reference real amounts and issuers found
- fill_guide: use TurboTax Canada navigation paths with real values from classified documents
- missing_documents: flag what is commonly needed but absent (RRSP receipts, NOA, medical, etc.)`;
}

// Deterministic fallback: compute T1 lines from per-doc fields without LLM
function deriveAggregateFromDocs(documents) {
  const t1_lines = {};
  let total_income = 0;
  let total_deductions = 0;
  let total_credits = 0;

  // Each list tries canonical box_ prefix first, then bare number (vision LLMs omit prefix)
  const T4_INCOME_FIELDS = ['box_14_employment_income', 'box_14', '14_employment_income', '14'];
  const T5_INTEREST_FIELDS = ['box_13_interest_from_canadian_sources', 'box_13_interest', 'box_13', 'other_information_amount_1'];
  const T5_DIVIDEND_FIELDS = ['box_10_actual_amount_dividends_other_than_eligible_dividends', 'box_24_eligible_dividends', 'box_24', 'other_information_amount_2'];
  const CPP_FIELDS = ['box_16_employee_cpp_contributions', 'box_16_cpp_contributions', 'box_16', '16_cpp_contributions', '16'];
  const EI_FIELDS = ['box_18_employee_ei_premiums', 'box_18_ei_premiums', 'box_18', '18_ei_premiums', '18'];
  const TAX_WITHHELD = ['box_22_income_tax_deducted', 'box_22', '22_income_tax_deducted', '22'];
  const BUSINESS_INCOME = ['total_consideration_paid_cad', 'total_consideration_paid_or_credited', 'gross_income', 'gross_business_income'];

  function pickField(fields, keys) {
    for (const k of keys) {
      if (typeof fields[k] === 'number' && fields[k] > 0) return fields[k];
    }
    return 0;
  }

  for (const doc of documents) {
    const f = doc.fields || {};
    const type = doc.document_type;

    if (type === 'T4') {
      const emp = pickField(f, T4_INCOME_FIELDS);
      if (emp) { t1_lines['10100'] = (t1_lines['10100'] || 0) + emp; total_income += emp; }
      const cpp = pickField(f, CPP_FIELDS);
      if (cpp) { t1_lines['31000'] = (t1_lines['31000'] || 0) + cpp; total_credits += cpp; }
      const ei = pickField(f, EI_FIELDS);
      if (ei) { t1_lines['31200'] = (t1_lines['31200'] || 0) + ei; total_credits += ei; }
      const tax = pickField(f, TAX_WITHHELD);
      if (tax) { t1_lines['43700'] = (t1_lines['43700'] || 0) + tax; }
    } else if (type === 'T5') {
      const interest = pickField(f, T5_INTEREST_FIELDS);
      if (interest) { t1_lines['12100'] = (t1_lines['12100'] || 0) + interest; total_income += interest; }
      const div = pickField(f, T5_DIVIDEND_FIELDS);
      if (div) { t1_lines['12000'] = (t1_lines['12000'] || 0) + div; total_income += div; }
    } else if (type === 'Other' || type === 'BusinessExpense') {
      const biz = pickField(f, BUSINESS_INCOME);
      if (biz) { t1_lines['13500'] = (t1_lines['13500'] || 0) + biz; total_income += biz; }
    } else if (type === 'RRSP') {
      const contrib = f['contribution_amount'] || f['rrsp_contribution'] || 0;
      if (contrib) { t1_lines['20800'] = (t1_lines['20800'] || 0) + contrib; total_deductions += contrib; }
    }
  }

  // Round all values to 2dp
  for (const k of Object.keys(t1_lines)) {
    t1_lines[k] = Math.round(t1_lines[k] * 100) / 100;
  }

  return {
    summary: {
      total_income: Math.round(total_income * 100) / 100,
      total_deductions: Math.round(total_deductions * 100) / 100,
      total_credits: Math.round(total_credits * 100) / 100,
    },
    t1_lines,
    missing_documents: [],
    advice: [],
    fill_guide: { software: 'TurboTax Canada / Intuit TurboTax', sections: [], final_steps: [] },
  };
}

async function aggregateResults(documents, year, person) {
  // Always compute numbers deterministically (reliable, no LLM needed)
  const base = deriveAggregateFromDocs(documents);

  // LLM provides only the advisory content: advice, fill_guide, missing_documents
  const prompt = buildAdvisoryPrompt(documents, base.t1_lines, year, person);
  try {
    const responseText = await callLLM(prompt, SYSTEM_PROMPT, { stage: 'advisory', timeoutMs: 180000 });
    const parsed = extractJson(responseText);
    if (parsed) {
      return {
        ...base,
        missing_documents: parsed.missing_documents || base.missing_documents,
        advice: parsed.advice || base.advice,
        fill_guide: parsed.fill_guide || base.fill_guide,
      };
    }
  } catch {
    // fall through
  }

  process.stderr.write('[analyze] advisory LLM failed, returning deterministic results only\n');
  return base;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadDeductionGuide() {
  const guidePath = join(__dirname, '..', 'data', 'deduction-guide.json');
  try {
    const raw = await readFile(guidePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildFallbackAnalysis(extractions, guide) {
  const advice = guide
    ? guide.deductions.slice(0, 5).map(d => `Consider: ${d.name} — ${d.notes || ''}`)
    : ['LLM unavailable. Review your documents manually against CRA guidelines.'];

  return {
    documents: extractions.map(e => ({
      file: e.file,
      document_type: 'Unknown',
      issuer: '',
      fields: {},
      notes: 'LLM unavailable — manual classification required',
      needs_clarification: false,
      clarification_question: '',
    })),
    summary: { total_income: 0, total_deductions: 0, total_credits: 0 },
    t1_lines: {},
    missing_documents: ['LLM unavailable — review manually'],
    advice: ['LLM service was unavailable. Raw text was extracted successfully. Review documents manually.', ...advice],
    fill_guide: { software: 'TurboTax Canada / Intuit TurboTax', sections: [], final_steps: [] },
    llm_unavailable: true,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function classifyDocuments(extractions, year, person) {
  process.stderr.write(`[analyze] classifying ${extractions.length} document(s) in parallel\n`);

  const guide = await loadDeductionGuide();

  try {
    // Phase 1: parallel per-document classification
    const documents = await Promise.all(
      extractions.map(e => {
        process.stderr.write(`[analyze] → ${e.file}\n`);
        return classifyOne(e, year, person);
      })
    );

    process.stderr.write(`[analyze] all documents classified, aggregating\n`);

    // Phase 2: aggregate into summary/t1_lines/fill_guide/advice
    const aggregate = await aggregateResults(documents, year, person);

    process.stderr.write('[analyze] complete\n');
    return { documents, ...aggregate };
  } catch (err) {
    process.stderr.write(`[analyze] failed: ${err.message}\n`);
    return buildFallbackAnalysis(extractions, guide);
  }
}

export async function getDeductionChecklist(person, documents) {
  const guide = await loadDeductionGuide();
  if (!guide) return [];

  const checklist = [];
  for (const deduction of guide.deductions) {
    checklist.push({
      name: deduction.name,
      required_docs: deduction.required_docs,
      deadline: deduction.deadline || null,
      notes: deduction.notes || '',
      applicable: true,
    });
  }
  return checklist;
}
