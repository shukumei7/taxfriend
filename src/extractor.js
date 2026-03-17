import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, basename, join } from 'node:path';
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

/**
 * Converts a PDF to an array of PNG image paths (one per page, max 10 pages).
 * Images are saved to outputDir as `<basename>-p<n>.png`.
 * Returns [] if pdfjs-dist or canvas is unavailable.
 */
export async function pdfToImages(pdfPath, outputDir) {
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    try {
      pdfjsLib = await import('pdfjs-dist');
    } catch {
      return [];
    }
  }

  let createCanvas;
  try {
    ({ createCanvas } = await import('canvas'));
  } catch {
    return [];
  }

  try {
    // Disable worker for Node.js environment
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    }

    const data = await readFile(pdfPath);
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data), disableWorker: true }).promise;
    const numPages = Math.min(pdf.numPages, 10);

    await mkdir(outputDir, { recursive: true });

    const base = basename(pdfPath, extname(pdfPath));
    const paths = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const scale = 2.0;
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const outPath = join(outputDir, `${base}-p${i}.png`);
      const buffer = canvas.toBuffer('image/png');
      await writeFile(outPath, buffer);
      paths.push(outPath);
    }

    return paths;
  } catch (err) {
    process.stderr.write(`[pdfToImages] ${basename(pdfPath)}: ${err.message}\n`);
    return [];
  }
}
