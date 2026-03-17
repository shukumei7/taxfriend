import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getDeductionChecklist, classifyDocuments } from '../src/analyzer.js';

describe('getDeductionChecklist', () => {
  test('returns an array', async () => {
    const result = await getDeductionChecklist('Alice', []);
    assert.ok(Array.isArray(result), 'should return an array');
  });

  test('returns an array with empty document list', async () => {
    const result = await getDeductionChecklist('Bob', []);
    assert.ok(Array.isArray(result));
  });

  test('each checklist item has name, required_docs, and notes fields', async () => {
    const result = await getDeductionChecklist('Alice', []);
    // If the deduction guide is loaded, items should have the expected shape
    // If guide is missing, returns [] — both are valid
    for (const item of result) {
      assert.ok('name' in item, 'item should have name field');
      assert.ok('required_docs' in item, 'item should have required_docs field');
      assert.ok('notes' in item, 'item should have notes field');
    }
  });

  test('checklist items have applicable field', async () => {
    const result = await getDeductionChecklist('Alice', [{ document_type: 'T4' }]);
    for (const item of result) {
      assert.ok('applicable' in item, 'item should have applicable field');
    }
  });
});

describe('classifyDocuments', () => {
  const EXPECTED_KEYS = ['documents', 'summary', 't1_lines', 'missing_documents', 'advice', 'fill_guide'];

  test('returns object with expected shape when LLM unavailable', async (t) => {
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const extractions = [
        { file: 'T4.txt', type: 'text', text: 'Employment income 55000' },
      ];

      const result = await classifyDocuments(extractions, '2024', 'TestPerson');

      assert.ok(result && typeof result === 'object', 'result should be an object');

      for (const key of EXPECTED_KEYS) {
        assert.ok(key in result, `result should have "${key}" field`);
      }

      assert.ok(Array.isArray(result.documents), 'documents should be an array');
      assert.ok(typeof result.summary === 'object' && result.summary !== null, 'summary should be an object');
      assert.ok(typeof result.t1_lines === 'object' && result.t1_lines !== null, 't1_lines should be an object');
      assert.ok(Array.isArray(result.missing_documents), 'missing_documents should be an array');
      assert.ok(Array.isArray(result.advice), 'advice should be an array');
      assert.ok(typeof result.fill_guide === 'object' && result.fill_guide !== null, 'fill_guide should be an object');
    } finally {
      process.env.PATH = origPath;
    }
  });

  test('summary object has total_income, total_deductions, total_credits fields', async (t) => {
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const extractions = [
        { file: 'T4.txt', type: 'text', text: 'T4 slip data' },
      ];

      const result = await classifyDocuments(extractions, '2024', 'TestPerson');

      assert.ok('total_income' in result.summary, 'summary should have total_income');
      assert.ok('total_deductions' in result.summary, 'summary should have total_deductions');
      assert.ok('total_credits' in result.summary, 'summary should have total_credits');
    } finally {
      process.env.PATH = origPath;
    }
  });

  test('fill_guide has software, sections, and final_steps fields', async (t) => {
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const extractions = [];

      const result = await classifyDocuments(extractions, '2024', 'TestPerson');

      assert.ok('software' in result.fill_guide, 'fill_guide should have software');
      assert.ok('sections' in result.fill_guide, 'fill_guide should have sections');
      assert.ok('final_steps' in result.fill_guide, 'fill_guide should have final_steps');
      assert.ok(Array.isArray(result.fill_guide.sections), 'sections should be an array');
      assert.ok(Array.isArray(result.fill_guide.final_steps), 'final_steps should be an array');
    } finally {
      process.env.PATH = origPath;
    }
  });

  test('documents array length matches extractions length in fallback mode', async (t) => {
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const extractions = [
        { file: 'slip1.txt', type: 'text', text: 'data' },
        { file: 'slip2.txt', type: 'text', text: 'data' },
      ];

      const result = await classifyDocuments(extractions, '2024', 'TestPerson');

      // With PATH='', claude is unfindable, so fallback is always triggered
      assert.ok(result.llm_unavailable, 'should be in fallback mode');
      assert.equal(result.documents.length, extractions.length,
        'fallback documents array should match extraction count');
    } finally {
      process.env.PATH = origPath;
    }
  });
});
