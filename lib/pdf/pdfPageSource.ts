import type * as PdfJs from 'pdfjs-dist';
import type { RasterImage } from '@/core/image/raster';
import type { PageSource, PhysicalSize } from './pageSource';

/**
 * PDF input via pdf.js.
 *
 * Scanned PDFs are usually one full-page image per page. We detect that
 * image's native resolution from the page's drawing operations and render at
 * exactly that scale, so the raster we analyse has the scan's own pixels
 * instead of a resampled (softer) version: that matters for typography and
 * noise matching. Vector/text pages fall back to a fixed DPI.
 */

export type PdfJsModule = typeof PdfJs;

export interface PdfSourceOptions {
  /** URL/path prefixes for pdf.js resources (same-origin in the browser). */
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  iccUrl?: string;
  /** Creates a 2D canvas (OffscreenCanvas in browsers, @napi-rs/canvas in Node). */
  createCanvas(width: number, height: number): { getContext(type: '2d'): unknown };
  maxPages?: number;
  maxPixelsPerPage?: number;
}

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_PIXELS_PER_PAGE = 16_000_000;
const FALLBACK_DPI = 300;
const MIN_DPI = 150;
const MAX_DPI = 600;

export class PdfInputError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'PdfInputError';
  }
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * Pixels per PDF point of the highest-resolution image covering a significant
 * part of the page, or undefined when the page has no such image.
 */
async function nativeImageScale(pdfjs: PdfJsModule, page: PdfJs.PDFPageProxy): Promise<number | undefined> {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;
  const [, , pageW, pageH] = page.view;
  const pageArea = Math.abs((pageW - page.view[0]) * (pageH - page.view[1]));
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let best: number | undefined;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const w = typeof args[1] === 'number' ? args[1] : (args[0] as { width?: number } | undefined)?.width;
      const h = typeof args[2] === 'number' ? args[2] : (args[0] as { height?: number } | undefined)?.height;
      if (!w || !h) continue;
      // The image occupies the unit square mapped by the CTM.
      const drawnW = Math.hypot(ctm[0], ctm[1]);
      const drawnH = Math.hypot(ctm[2], ctm[3]);
      if (drawnW * drawnH < pageArea * 0.25) continue; // logos, stamps
      const scale = Math.max(w / drawnW, h / drawnH);
      if (Number.isFinite(scale)) best = Math.max(best ?? 0, scale);
    }
  }
  return best;
}

export async function openPdfSource(pdfjs: PdfJsModule, bytes: Uint8Array, opts: PdfSourceOptions): Promise<PageSource> {
  let doc: PdfJs.PDFDocumentProxy;
  const task = pdfjs.getDocument({
    data: bytes,
    enableXfa: false,
    useSystemFonts: false,
    disableAutoFetch: true,
    stopAtErrors: false,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: opts.standardFontDataUrl,
    wasmUrl: opts.wasmUrl,
    iccUrl: opts.iccUrl,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new PdfInputError(String(e), 'This PDF is password-protected. Please remove the password and try again.');
    throw new PdfInputError(String(e), 'This PDF could not be read. It may be damaged or use an unsupported format.');
  }

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxPixels = opts.maxPixelsPerPage ?? DEFAULT_MAX_PIXELS_PER_PAGE;
  const pageCount = Math.min(doc.numPages, maxPages);
  if (pageCount === 0) throw new PdfInputError('PDF has no pages', 'This PDF has no pages.');

  const scaleCache = new Map<number, number>();
  const renderScale = async (page: PdfJs.PDFPageProxy): Promise<number> => {
    const cached = scaleCache.get(page.pageNumber);
    if (cached) return cached;
    const native = await nativeImageScale(pdfjs, page).catch(() => undefined);
    let scale = native ?? FALLBACK_DPI / 72;
    scale = Math.min(MAX_DPI / 72, Math.max(MIN_DPI / 72, scale));
    const vp = page.getViewport({ scale: 1 });
    const pixels = vp.width * vp.height * scale * scale;
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
    scaleCache.set(page.pageNumber, scale);
    return scale;
  };

  return {
    kind: 'pdf',
    pageCount,
    skippedPages: doc.numPages - pageCount,
    async physicalSize(index: number): Promise<PhysicalSize> {
      const page = await doc.getPage(index + 1);
      // Includes /Rotate, so width/height match the upright render.
      const vp = page.getViewport({ scale: 1 });
      return { widthPt: vp.width, heightPt: vp.height };
    },
    async render(index: number): Promise<RasterImage> {
      const page = await doc.getPage(index + 1);
      try {
        const viewport = page.getViewport({ scale: await renderScale(page) });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const canvas = opts.createCanvas(width, height);
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx,
          viewport,
          background: '#ffffff',
          annotationMode: pdfjs.AnnotationMode.ENABLE,
        }).promise;
        const data = ctx.getImageData(0, 0, width, height);
        return { width, height, data: new Uint8ClampedArray(data.data.buffer, data.data.byteOffset, data.data.byteLength) };
      } catch (e) {
        throw new PdfInputError(String(e), `Page ${index + 1} of this PDF could not be rendered.`);
      } finally {
        page.cleanup();
      }
    },
    async dispose() {
      await task.destroy();
    },
  };
}
