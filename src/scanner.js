import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.csv']);

async function scanDir(dir) {
  let results = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory() && entry !== '.taxfriend') {
      results = results.concat(await scanDir(fullPath));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function scanPerson(year, person, baseDir) {
  const personDir = join(baseDir, 'input', String(year), person);
  const files = await scanDir(personDir);
  process.stderr.write(`[scan] ${year}/${person}: found ${files.length} file(s)\n`);
  return files;
}

export async function discoverPersons(baseDir) {
  const inputDir = join(baseDir, 'input');
  const results = [];

  let years;
  try {
    years = await readdir(inputDir);
  } catch {
    return results;
  }

  for (const year of years) {
    const yearPath = join(inputDir, year);
    const yearStat = await stat(yearPath).catch(() => null);
    if (!yearStat || !yearStat.isDirectory()) continue;

    let persons;
    try {
      persons = await readdir(yearPath);
    } catch {
      continue;
    }

    for (const person of persons) {
      const personPath = join(yearPath, person);
      const personStat = await stat(personPath).catch(() => null);
      if (!personStat || !personStat.isDirectory()) continue;

      const files = await scanDir(personPath);
      if (files.length > 0) {
        results.push({ year, person });
      }
    }
  }

  return results;
}
