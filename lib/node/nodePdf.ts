/** Node-only PDF input for tests and scripts (pdf.js legacy build + @napi-rs/canvas). */
import './polyfills';
import { createCanvas } from '@napi-rs/canvas';
import path from 'node:path';
import type { PageSource } from '@/lib/pdf/pageSource';
import { openPdfSource, type PdfJsModule } from '@/lib/pdf/pdfPageSource';

export async function openNodePdf(bytes: Uint8Array): Promise<PageSource> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
  const dist = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  return openPdfSource(pdfjs, bytes, {
    standardFontDataUrl: `${dist}/standard_fonts/`,
    cMapUrl: `${dist}/cmaps/`,
    wasmUrl: `${dist}/wasm/`,
    iccUrl: `${dist}/iccs/`,
    createCanvas: (w, h) => createCanvas(w, h) as unknown as { getContext(type: '2d'): unknown },
  });
}
