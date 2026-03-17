import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateReport } from '../src/reporter.js';

const mockAnalysis = {
  documents: [
    {
      file: 'T4_2025.pdf',
      document_type: 'T4',
      issuer: 'Acme Corp',
      fields: { box_14_employment_income: 55000 },
      notes: '',
    },
  ],
  summary: { total_income: 55000, total_deductions: 0, total_credits: 0 },
  t1_lines: { '10100': 55000 },
  missing_documents: ['RRSP receipt'],
  advice: ['Consider contributing to RRSP'],
  fill_guide: { software: 'TurboTax Canada', sections: [], final_steps: [] },
};

describe('generateReport', () => {
  test('returns an object with markdown and json string fields', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);

    assert.ok(result && typeof result === 'object', 'result should be an object');
    assert.ok(typeof result.markdown === 'string', 'markdown should be a string');
    assert.ok(typeof result.json === 'string', 'json should be a string');
  });

  test('markdown contains the person name', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    assert.ok(result.markdown.includes('Alice Smith'), 'markdown should contain person name');
  });

  test('markdown contains the year', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    assert.ok(result.markdown.includes('2025'), 'markdown should contain the year');
  });

  test('markdown contains the document type T4', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    assert.ok(result.markdown.includes('T4'), 'markdown should contain T4');
  });

  test('markdown contains disclaimer text mentioning professional advice', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    const lower = result.markdown.toLowerCase();
    const hasDisclaimer = lower.includes('professional') || lower.includes('advice') || lower.includes('disclaimer');
    assert.ok(hasDisclaimer, 'markdown should contain disclaimer text');
  });

  test('json parses as valid JSON', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.json);
    }, 'json field should parse without error');
    assert.ok(parsed !== null && typeof parsed === 'object');
  });

  test('parsed JSON contains documents array with 1 item', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    const parsed = JSON.parse(result.json);
    assert.ok(Array.isArray(parsed.documents), 'parsed JSON should have documents array');
    assert.equal(parsed.documents.length, 1);
  });

  test('parsed JSON contains year and person fields', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    const parsed = JSON.parse(result.json);
    assert.equal(parsed.year, '2025');
    assert.equal(parsed.person, 'Alice Smith');
  });

  test('markdown contains the issuer name', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    assert.ok(result.markdown.includes('Acme Corp'), 'markdown should contain issuer name');
  });

  test('markdown lists missing documents', async () => {
    const result = await generateReport('2025', 'Alice Smith', mockAnalysis);
    assert.ok(result.markdown.includes('RRSP receipt'), 'markdown should list missing RRSP receipt');
  });
});
