import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadTaxLines() {
  const path = join(__dirname, '..', 'data', 'tax-lines.json');
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatCurrency(value) {
  if (typeof value !== 'number') return String(value);
  return `$${value.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildMarkdown(year, person, analysis, taxLines) {
  const lines = [];

  lines.push(`# TaxFriend Report — ${person} — Tax Year ${year}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Document Summary
  lines.push('## Document Summary');
  lines.push('');
  if (analysis.documents && analysis.documents.length > 0) {
    lines.push('| File | Type | Issuer | Key Amounts | Notes |');
    lines.push('|------|------|--------|-------------|-------|');
    for (const doc of analysis.documents) {
      const keyAmounts = Object.entries(doc.fields || {})
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${formatCurrency(v)}`)
        .join(', ') || '—';
      const issuer = doc.issuer || '—';
      const notes = (doc.notes || '').replace(/\|/g, '\\|');
      lines.push(`| ${doc.file} | ${doc.document_type} | ${issuer} | ${keyAmounts} | ${notes} |`);
    }
  } else {
    lines.push('No documents processed.');
  }
  lines.push('');

  // Summary totals
  if (analysis.summary) {
    lines.push('### Totals');
    lines.push('');
    lines.push(`- **Total Income:** ${formatCurrency(analysis.summary.total_income)}`);
    lines.push(`- **Total Deductions:** ${formatCurrency(analysis.summary.total_deductions)}`);
    lines.push(`- **Total Credits:** ${formatCurrency(analysis.summary.total_credits)}`);
    lines.push('');
  }

  // T1 Line Summary
  lines.push('## T1 Line Summary');
  lines.push('');
  const t1Lines = analysis.t1_lines || {};
  const sortedLines = Object.keys(t1Lines).sort((a, b) => Number(a) - Number(b));
  if (sortedLines.length > 0) {
    lines.push('| Line | Description | Value |');
    lines.push('|------|-------------|-------|');
    for (const lineNum of sortedLines) {
      const desc = taxLines[lineNum] || 'Unknown line';
      lines.push(`| ${lineNum} | ${desc} | ${formatCurrency(t1Lines[lineNum])} |`);
    }
  } else {
    lines.push('No T1 lines identified from documents.');
  }
  lines.push('');

  // Deductions & Credits Found
  lines.push('## Deductions & Credits Found');
  lines.push('');
  const deductions = Object.keys(t1Lines).filter(l => Number(l) >= 20000 && Number(l) < 40000);
  const credits = Object.keys(t1Lines).filter(l => Number(l) >= 30000 && Number(l) < 40000);
  if (deductions.length > 0 || credits.length > 0) {
    const allFound = [...new Set([...deductions, ...credits])].sort((a, b) => Number(a) - Number(b));
    for (const lineNum of allFound) {
      const desc = taxLines[lineNum] || `Line ${lineNum}`;
      lines.push(`- **Line ${lineNum}** — ${desc}: ${formatCurrency(t1Lines[lineNum])}`);
    }
  } else {
    lines.push('None identified from documents.');
  }
  lines.push('');

  // Missing Documents Checklist
  lines.push('## Missing Documents Checklist');
  lines.push('');
  const missing = analysis.missing_documents || [];
  if (missing.length > 0) {
    for (const item of missing) {
      lines.push(`- [ ] ${item}`);
    }
  } else {
    lines.push('No missing documents identified.');
  }
  lines.push('');

  // Advice
  lines.push('## Advice');
  lines.push('');
  const advice = analysis.advice || [];
  if (advice.length > 0) {
    for (const item of advice) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('No specific advice generated.');
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('> **Disclaimer:** This is not professional tax advice. Verify all figures with a tax professional before filing.');
  lines.push('');

  return lines.join('\n');
}

export async function generateReport(year, person, analysis) {
  const taxLines = await loadTaxLines();
  const markdown = buildMarkdown(year, person, analysis, taxLines);
  const json = JSON.stringify({ year, person, generatedAt: new Date().toISOString(), ...analysis }, null, 2);
  return { markdown, json };
}
