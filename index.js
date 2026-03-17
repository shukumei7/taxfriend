import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPerson, discoverPersons } from './src/scanner.js';
import { extractText } from './src/extractor.js';
import { classifyDocuments } from './src/analyzer.js';
import { generateReport } from './src/reporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function safeName(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
}

async function processPerson(year, person) {
  process.stderr.write(`\n[taxfriend] Processing ${year}/${person}\n`);

  const files = await scanPerson(year, person, __dirname);

  if (files.length === 0) {
    process.stderr.write(`[taxfriend] No supported files found for ${year}/${person}\n`);
    return;
  }

  const extractions = await Promise.all(files.map(extractText));

  const analysis = await classifyDocuments(extractions, year, person);

  const { markdown, json } = await generateReport(year, person, analysis);

  const outDir = join(__dirname, 'output', String(year), safeName(person));
  await mkdir(outDir, { recursive: true });

  const mdPath = join(outDir, 'report.md');
  const jsonPath = join(outDir, 'report.json');

  await writeFile(mdPath, markdown, 'utf-8');
  await writeFile(jsonPath, json, 'utf-8');

  process.stderr.write(`[taxfriend] Report saved to ${outDir}\n`);

  // Print markdown to stdout
  process.stdout.write(markdown);
  process.stdout.write('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const [year, person] = args;

  let targets = [];

  if (year && person) {
    targets = [{ year, person }];
  } else if (year) {
    const all = await discoverPersons(__dirname);
    targets = all.filter(t => String(t.year) === String(year));
    if (targets.length === 0) {
      process.stderr.write(`[taxfriend] No persons found under input/${year}/\n`);
    }
  } else {
    targets = await discoverPersons(__dirname);
    if (targets.length === 0) {
      process.stderr.write('[taxfriend] No tax documents found in input/. Create input/(year)/(person)/ and add documents.\n');
    }
  }

  for (const target of targets) {
    await processPerson(target.year, target.person);
  }
}

main().catch(err => {
  process.stderr.write(`[taxfriend] Fatal error: ${err.message}\n`);
  process.exit(1);
});
