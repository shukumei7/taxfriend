import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractJson, callClaude } from './spawn-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are an expert Canadian tax assistant with deep knowledge of the CRA T1 General return, all common tax slips (T4, T4A, T4E, T5, T5008, T3, T2202, RRSP receipts), deductions, and credits for the current tax year. You help taxpayers identify what documents they have, what amounts go on which T1 lines, and what deductions or credits they may be missing. Always respond with valid JSON only — no markdown, no explanations outside the JSON structure.`;

function buildClassifyPrompt(extractions, year, person) {
  const docSections = extractions.map((e, i) => {
    const label = `--- Document ${i + 1}: ${e.file} (${e.type}) ---`;
    const content = e.error
      ? `[Error reading file: ${e.error}]`
      : e.text.slice(0, 3000);
    return `${label}\n${content}`;
  });

  return `Tax year: ${year}\nTaxpayer: ${person}\n\nAnalyze the following tax documents and return a JSON object with this exact structure:\n{\n  "documents": [\n    {\n      "file": "filename",\n      "document_type": "T4|T4A|T4E|T5|T5008|RRSP|Donation|Medical|Tuition|PropertyTax|RentReceipt|ChildCare|HomeOffice|BusinessExpense|Other|Unknown",\n      "issuer": "name of employer or institution if found",\n      "fields": { "box_14_employment_income": 0 },\n      "notes": "any warnings or observations",\n      "needs_clarification": false,\n      "clarification_question": ""\n    }\n  ],\n  "summary": {\n    "total_income": 0,\n    "total_deductions": 0,\n    "total_credits": 0\n  },\n  "t1_lines": {\n    "10100": 0\n  },\n  "missing_documents": ["list of commonly needed documents NOT found"],\n  "advice": ["actionable deduction and credit recommendations"],\n  "fill_guide": {\n    "software": "TurboTax Canada / Intuit TurboTax",\n    "sections": [\n      {\n        "section": "Employment Income",\n        "steps": [\n          "Navigate to Income > Employment Income > T4 Slips",\n          "Click Add a T4 slip",\n          "Employer name: [from document]",\n          "Box 14 (Employment income): [amount]",\n          "Box 22 (Income tax deducted): [amount]",\n          "Box 52 (Pension adjustment): [amount or 0.00]"\n        ]\n      }\n    ],\n    "final_steps": [\n      "Review your RRSP deduction limit in RRSP & Savings Plans",\n      "Complete the Review & Optimize section before filing"\n    ]\n  }\n}\n\nIf a document is unclear, unreadable, ambiguous about type or amounts, or appears to be an image that couldn't be read, set needs_clarification to true and clarification_question to a specific question for the taxpayer (e.g. 'This appears to be a T4 but Box 14 is illegible — can you confirm your employment income from Acme Corp?').\n\nFor the fill_guide, map ALL data found across documents to the correct TurboTax Canada navigation paths. Use these section names matching TurboTax Canada: Employment Income (T4 slips), Other Income (T4A/T4E/T5/T3), RRSP & Savings Plans, Deductions (union dues, professional fees, moving expenses), Credits (medical, donations, tuition T2202, transit), Review & Optimize. Include real amounts and employer/institution names from the documents.\n\nDocuments to analyze:\n\n${docSections.join('\n\n')}`;
}

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

export async function classifyDocuments(extractions, year, person) {
  process.stderr.write(`[analyze] calling LLM to classify ${extractions.length} document(s)\n`);

  const guide = await loadDeductionGuide();

  try {
    const prompt = buildClassifyPrompt(extractions, year, person);
    const responseText = await callClaude(prompt, SYSTEM_PROMPT);
    const parsed = extractJson(responseText);

    if (!parsed) {
      process.stderr.write('[analyze] LLM response did not contain valid JSON, using fallback\n');
      return buildFallbackAnalysis(extractions, guide);
    }

    process.stderr.write('[analyze] LLM classification complete\n');
    return parsed;
  } catch (err) {
    process.stderr.write(`[analyze] LLM unavailable: ${err.message}\n`);
    return buildFallbackAnalysis(extractions, guide);
  }
}

export async function getDeductionChecklist(person, documents) {
  const guide = await loadDeductionGuide();
  if (!guide) return [];

  const foundTypes = new Set(documents.map(d => d.document_type));
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
