import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, basename, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  let mupdf;
  try {
    mupdf = await import('mupdf');
  } catch {
    process.stderr.write('[pdfToImages] mupdf not available\n');
    return [];
  }

  try {
    const data = await readFile(pdfPath);
    const doc = mupdf.Document.openDocument(data, 'application/pdf');
    const numPages = Math.min(doc.countPages(), 10);

    await mkdir(outputDir, { recursive: true });

    const base = basename(pdfPath, extname(pdfPath));
    const paths = [];
    const scale = 2;
    const matrix = [scale, 0, 0, scale, 0, 0];

    for (let i = 0; i < numPages; i++) {
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pixmap.asPNG();
      const outPath = join(outputDir, `${base}-p${i + 1}.png`);
      await writeFile(outPath, png);
      paths.push(outPath);
      pixmap.destroy();
    }

    return paths;
  } catch (err) {
    process.stderr.write(`[pdfToImages] ${basename(pdfPath)}: ${err.message}\n`);
    return [];
  }
}
