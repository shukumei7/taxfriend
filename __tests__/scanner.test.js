import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { scanPerson, discoverPersons } from '../src/scanner.js';

describe('discoverPersons', () => {
  let baseDir;

  before(async () => {
    baseDir = join(tmpdir(), `taxfriend-scan-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
  });

  after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test('returns [] for empty input dir', async () => {
    const emptyBase = join(tmpdir(), `taxfriend-empty-${randomUUID()}`);
    await mkdir(join(emptyBase, 'input'), { recursive: true });
    const result = await discoverPersons(emptyBase);
    assert.deepEqual(result, []);
    await rm(emptyBase, { recursive: true, force: true });
  });

  test('returns [] when input dir does not exist', async () => {
    const noInput = join(tmpdir(), `taxfriend-noinput-${randomUUID()}`);
    await mkdir(noInput, { recursive: true });
    const result = await discoverPersons(noInput);
    assert.deepEqual(result, []);
    await rm(noInput, { recursive: true, force: true });
  });

  test('finds expected year/person combos from real tmp dirs', async () => {
    // Setup: input/2024/alice/doc.txt and input/2023/bob/doc.csv
    const personDir1 = join(baseDir, 'input', '2024', 'alice');
    const personDir2 = join(baseDir, 'input', '2023', 'bob');
    await mkdir(personDir1, { recursive: true });
    await mkdir(personDir2, { recursive: true });
    await writeFile(join(personDir1, 'T4.txt'), 'employment income');
    await writeFile(join(personDir2, 'T5.csv'), 'dividend income');

    const result = await discoverPersons(baseDir);

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);

    const alice = result.find(r => r.person === 'alice');
    const bob = result.find(r => r.person === 'bob');

    assert.ok(alice, 'should find alice');
    assert.equal(alice.year, '2024');

    assert.ok(bob, 'should find bob');
    assert.equal(bob.year, '2023');
  });

  test('skips person dirs with no supported files', async () => {
    const emptyPersonDir = join(baseDir, 'input', '2024', 'emptyPerson');
    await mkdir(emptyPersonDir, { recursive: true });
    await writeFile(join(emptyPersonDir, 'notes.docx'), 'unsupported');

    const result = await discoverPersons(baseDir);
    const emptyPerson = result.find(r => r.person === 'emptyPerson');
    assert.equal(emptyPerson, undefined);
  });
});

describe('scanPerson', () => {
  let baseDir;

  before(async () => {
    baseDir = join(tmpdir(), `taxfriend-scanperson-${randomUUID()}`);
  });

  after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test('returns [] when directory does not exist', async () => {
    const result = await scanPerson('2024', 'nobody', baseDir);
    assert.deepEqual(result, []);
  });

  test('returns only supported file extensions', async () => {
    const personDir = join(baseDir, 'input', '2024', 'charlie');
    await mkdir(personDir, { recursive: true });

    const supported = ['doc.pdf', 'photo.png', 'scan.jpg', 'scan2.jpeg', 'data.txt', 'data.csv'];
    const unsupported = ['notes.docx', 'archive.zip', 'script.js', '.DS_Store'];

    for (const f of [...supported, ...unsupported]) {
      await writeFile(join(personDir, f), 'content');
    }

    const result = await scanPerson('2024', 'charlie', baseDir);

    assert.equal(result.length, supported.length, 'should return exactly the supported file count');

    for (const f of supported) {
      assert.ok(result.some(r => r.endsWith(f)), `should include ${f}`);
    }
    for (const f of unsupported) {
      assert.ok(!result.some(r => r.endsWith(f)), `should exclude ${f}`);
    }
  });

  test('skips .taxfriend/ hidden subdirectory', async () => {
    const personDir = join(baseDir, 'input', '2024', 'diana');
    const hiddenDir = join(personDir, '.taxfriend');
    await mkdir(hiddenDir, { recursive: true });

    await writeFile(join(personDir, 'T4.txt'), 'real file');
    await writeFile(join(hiddenDir, 'cache.txt'), 'should be skipped');

    const result = await scanPerson('2024', 'diana', baseDir);

    // Should find the real file but not the one in .taxfriend
    assert.ok(result.some(r => r.endsWith('T4.txt')), 'should find T4.txt');
    assert.ok(!result.some(r => r.includes('.taxfriend')), 'should not include .taxfriend files');
  });

  test('finds files recursively in subdirectories', async () => {
    const personDir = join(baseDir, 'input', '2024', 'edgar');
    const subDir = join(personDir, 'bank_statements');
    await mkdir(subDir, { recursive: true });

    await writeFile(join(personDir, 'T4.txt'), 'T4 slip');
    await writeFile(join(subDir, 'statement.pdf'), 'bank pdf');

    const result = await scanPerson('2024', 'edgar', baseDir);
    assert.equal(result.length, 2);
    assert.ok(result.some(r => r.endsWith('T4.txt')));
    assert.ok(result.some(r => r.endsWith('statement.pdf')));
  });
});
