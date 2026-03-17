import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { extractText } from '../src/extractor.js';

describe('extractText', () => {
  let tmpDir;

  before(async () => {
    tmpDir = join(tmpdir(), `taxfriend-extract-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('returns { type: "text", text: <content> } for .txt file', async () => {
    const filePath = join(tmpDir, 'payslip.txt');
    await writeFile(filePath, 'Employment income: 55000');

    const result = await extractText(filePath);

    assert.equal(result.type, 'text');
    assert.equal(result.text, 'Employment income: 55000');
    assert.equal(result.error, undefined);
  });

  test('returns { type: "text", text: <content> } for .csv file', async () => {
    const filePath = join(tmpDir, 'transactions.csv');
    const csvContent = 'date,amount\n2025-01-01,1000\n2025-02-01,2000';
    await writeFile(filePath, csvContent);

    const result = await extractText(filePath);

    assert.equal(result.type, 'text');
    assert.equal(result.text, csvContent);
    assert.equal(result.error, undefined);
  });

  test('returns { type: "image" } with IMAGE_FILE placeholder for .jpg file', async () => {
    const filePath = join(tmpDir, 'receipt.jpg');
    await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes

    const result = await extractText(filePath);

    assert.equal(result.type, 'image');
    assert.ok(result.text.includes('IMAGE_FILE'), 'text should contain IMAGE_FILE placeholder');
    assert.ok(result.text.includes('receipt.jpg'), 'text should reference the filename');
    assert.equal(result.error, undefined);
  });

  test('returns { type: "image" } for .png file', async () => {
    const filePath = join(tmpDir, 'scan.png');
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes

    const result = await extractText(filePath);

    assert.equal(result.type, 'image');
    assert.ok(result.text.includes('IMAGE_FILE'));
  });

  test('returns { type: "image" } for .jpeg file', async () => {
    const filePath = join(tmpDir, 'photo.jpeg');
    await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff]));

    const result = await extractText(filePath);

    assert.equal(result.type, 'image');
    assert.ok(result.text.includes('IMAGE_FILE'));
  });

  test('returns object with error field for unknown extension', async () => {
    const filePath = join(tmpDir, 'document.docx');
    await writeFile(filePath, 'some content');

    const result = await extractText(filePath);

    assert.ok(result.error, 'should have an error field');
    assert.ok(typeof result.error === 'string');
    assert.ok(result.error.toLowerCase().includes('.docx') || result.error.toLowerCase().includes('unsupported'));
  });

  test('returns object with error field for non-existent file', async () => {
    const filePath = join(tmpDir, 'doesnotexist.txt');

    const result = await extractText(filePath);

    assert.ok(result.error, 'should have an error field');
    assert.ok(typeof result.error === 'string');
  });
});
