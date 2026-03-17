import { extractJson } from './spawn-utils.js';
import { callLLM } from './llm-providers.js';

const SYSTEM_PROMPT = `You are an expert CRA tax filing assistant for Canada. Given a tax analysis, produce a comprehensive filing checklist for this taxpayer. The checklist must be exhaustive — include every document, slip, form, and step needed to file accurately. Expand the checklist based on what documents were found (e.g. T4 found → include all T4 boxes, employer confirmation). Flag missing critical items. Group by category. Return valid JSON only.`;

export async function generateChecklist(analysis, year, person) {
  process.stderr.write(`[checklist] generating checklist for ${person}/${year}\n`);

  const analysisJson = JSON.stringify(analysis, null, 2);

  const prompt = `Tax year: ${year}
Taxpayer: ${person}

Based on this tax analysis, generate a filing checklist. Return a JSON object with this exact structure:
{
  "generated_at": "ISO timestamp",
  "tax_year": "${year}",
  "person": "${person}",
  "summary": {
    "total_items": 0,
    "required_done": 0,
    "required_total": 0,
    "optional_done": 0,
    "optional_total": 0,
    "ready_to_file": false
  },
  "categories": [
    {
      "id": "income_slips",
      "name": "Income Slips",
      "icon": "💼",
      "items": [
        {
          "id": "t4_employment",
          "label": "T4 slip — employment income",
          "detail": "From each employer. Box 14 = employment income",
          "status": "done|missing|optional|not_applicable|needs_clarification",
          "priority": "required|recommended|optional",
          "found_in": "filename.pdf or null",
          "value": "$55,000 (Box 14) or null",
          "action": "What to do if missing — e.g. 'Request from employer or download from CRA My Account'",
          "cra_line": "10100"
        }
      ]
    }
  ],
  "next_steps": [
    "Specific actionable next step for the taxpayer"
  ],
  "filing_blockers": [
    "Critical items that MUST be resolved before filing"
  ]
}

Use these categories (include only relevant ones, add others if needed):
- income_slips (T4, T4A, T4E, T5, T3, T5008, T4RSP, T4RIF)
- rrsp_tfsa (RRSP contribution receipts, TFSA room check)
- deductions (union dues, professional fees, moving expenses, child care, home office, carrying charges)
- credits (medical expenses, charitable donations, tuition T2202, disability T2201, Canada Training Credit)
- forms_required (Schedule 3 for capital gains, T778 child care, T2125 self-employment, T776 rental)
- prior_year_carryforwards (RRSP unused room, capital losses, tuition credits)
- filing_steps (review NOA from prior year, NETFILE registration, sign and file)

Set status based on analysis:
- "done" if found in documents with clear amounts
- "missing" if expected based on situation but not found
- "optional" if may apply but not confirmed
- "not_applicable" if clearly does not apply
- "needs_clarification" if found but unclear

Set ready_to_file: true only if all required items are "done" and there are no filing_blockers.

Full analysis:
${analysisJson}`;

  try {
    const responseText = await callLLM(prompt, SYSTEM_PROMPT, { stage: 'checklist', timeoutMs: 120000 });
    const parsed = extractJson(responseText);
    if (!parsed) {
      process.stderr.write('[checklist] LLM response did not contain valid JSON\n');
      return null;
    }
    process.stderr.write('[checklist] checklist generated successfully\n');
    return parsed;
  } catch (err) {
    process.stderr.write(`[checklist] failed to generate checklist: ${err.message}\n`);
    return null;
  }
}

export async function refreshChecklist(existingChecklist, chatHistory, analysis) {
  process.stderr.write('[checklist] refreshing checklist with chat context\n');

  const recentChat = chatHistory.slice(-6);
  const chatText = recentChat.length > 0
    ? recentChat.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
    : '(no recent chat messages)';

  const prompt = `You are updating an existing tax filing checklist based on new information from a recent conversation.

Existing checklist:
${JSON.stringify(existingChecklist, null, 2)}

Recent conversation (last 6 messages):
${chatText}

Current analysis summary:
${JSON.stringify(analysis.summary || {}, null, 2)}

Instructions:
- Keep all existing items
- Update statuses based on new info revealed in the conversation (e.g. if user confirmed employment income, mark T4 as done)
- Add new checklist items/categories if the conversation revealed new tax situations (e.g. user mentions rental income → add T776 category)
- Update next_steps and filing_blockers based on the conversation
- Recalculate the summary counts
- Update generated_at to current ISO timestamp
- Return the full updated checklist JSON in the same structure as the existing checklist`;

  try {
    const responseText = await callLLM(prompt, SYSTEM_PROMPT, { stage: 'checklist', timeoutMs: 120000 });
    const parsed = extractJson(responseText);
    if (!parsed) {
      process.stderr.write('[checklist] refresh response did not contain valid JSON, returning existing\n');
      return existingChecklist;
    }
    process.stderr.write('[checklist] checklist refreshed successfully\n');
    return parsed;
  } catch (err) {
    process.stderr.write(`[checklist] refresh failed: ${err.message}\n`);
    return existingChecklist;
  }
}
