import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);
const TEXT_EXTS = new Set(['.txt', '.csv']);

export async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  const file = basename(filePath);

  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = await readFile(filePath);
      const data = await pdfParse(buffer);
      process.stderr.write(`[extract] ${file}: ${data.text.length} chars from PDF\n`);
      return { file, type: 'pdf', text: data.text };
    } catch (err) {
      process.stderr.write(`[extract] ${file}: PDF parse error — ${err.message}\n`);
      return { file, type: 'pdf', text: '', error: err.message };
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    process.stderr.write(`[extract] ${file}: image — manual review required\n`);
    return {
      file,
      type: 'image',
      text: `IMAGE_FILE: ${file} — manual review required`,
    };
  }

  if (TEXT_EXTS.has(ext)) {
    try {
      const text = await readFile(filePath, 'utf-8');
      process.stderr.write(`[extract] ${file}: ${text.length} chars from text file\n`);
      return { file, type: 'text', text };
    } catch (err) {
      process.stderr.write(`[extract] ${file}: read error — ${err.message}\n`);
      return { file, type: 'text', text: '', error: err.message };
    }
  }

  return { file, type: 'unknown', text: '', error: `Unsupported file type: ${ext}` };
}
