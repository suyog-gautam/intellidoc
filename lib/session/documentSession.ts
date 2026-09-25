import type { EditCommand } from '@/core/document/history';
import type { IntellidocDocument, Page } from '@/core/document/model';
import type { RasterImage } from '@/core/image/raster';
import { normalizeLanguages } from '@/core/ocr/languages';
import { TesseractEngine } from '@/core/ocr/tesseractEngine';
import { mergeRecovered } from '@/core/ocr/recovery';
import { OcrError, scaleOcrResult, type OcrEngine, type OcrResult } from '@/core/ocr/types';
import { createDocumentSkeleton } from '@/core/pipeline/buildDocument';
import { MAX_PIXELS, sha256Hex, UploadError, validateUpload } from '@/lib/image/validateUpload';
import { imagePageSource, type PageSource } from '@/lib/pdf/pageSource';
import { PdfInputError } from '@/lib/pdf/pdfPageSource';
import { vendorUrl } from '@/lib/browser/paths';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';

export interface OpenProgress {
  stage: 'validating' | 'decoding' | 'rendering' | 'preprocessing' | 'ocr' | 'recovery' | 'building';
  /** 0..1 within the stage, when known. */
  progress?: number;
  pageIndex?: number;
  pageCount?: number;
}

let sharedOcr: { key: string; engine: OcrEngine } | undefined;

/** One Tesseract worker, re-created when the document languages change. */
function ocrEngine(languages: readonly string[]): OcrEngine {
  const key = languages.join('+');
  if (sharedOcr?.key !== key) {
    void sharedOcr?.engine.dispose();
    sharedOcr = {
      key,
      engine: new TesseractEngine({
        workerPath: vendorUrl('tesseract/worker.min.js'),
        corePath: vendorUrl('tesseract/core'),
        langPath: vendorUrl('tesseract/lang'),
        languages: [...languages],
      }),
    };
  }
  return sharedOcr.engine;
}

async function decodeImage(blob: Blob): Promise<RasterImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new UploadError('The image could not be decoded. It may be corrupted.');
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      throw new UploadError(`The image is too large (${bitmap.width}x${bitmap.height}). Please use a scan under ${MAX_PIXELS / 1e6} megapixels.`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    bitmap.close();
  }
}

async function openPdf(bytes: Uint8Array): Promise<PageSource> {
  // Loaded on demand so image-only users never download pdf.js.
  const [pdfjs, { openPdfSource }] = await Promise.all([import('pdfjs-dist'), import('@/lib/pdf/pdfPageSource')]);
  pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');
  return openPdfSource(pdfjs, bytes, {
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    wasmUrl: vendorUrl('pdfjs/wasm/'),
    iccUrl: vendorUrl('pdfjs/iccs/'),
    createCanvas: (w, h) => new OffscreenCanvas(w, h),
  });
}

function userMessage(e: unknown): string {
  if (e instanceof UploadError || e instanceof PdfInputError || e instanceof OcrError) return e.userMessage;
  return 'Processing failed for this page.';
}

/**
 * One open document. Page 1 is fully processed before the editor opens; the
 * rest are rendered and recognised in the background, one at a time, and
 * reported as `updatePage` commands so the UI stays usable throughout.
 * Everything runs locally: pdf.js and Tesseract in their own workers,
 * preprocessing in the reconstruction worker.
 */
export class DocumentSession {
  readonly warnings: string[] = [];
  private listener: ((cmd: EditCommand) => void) | undefined;
  private backlog: EditCommand[] = [];
  private disposed = false;

  private constructor(
    readonly initial: IntellidocDocument,
    private readonly source: PageSource,
    private readonly client: ReconstructionClient,
    /** Tesseract language codes, e.g. ['nep', 'eng']. */
    readonly languages: readonly string[],
  ) {}

  static async open(file: File, client: ReconstructionClient, onProgress: (p: OpenProgress) => void, languageCodes: Iterable<string> = ['eng']): Promise<DocumentSession> {
    const languages = normalizeLanguages(languageCodes);
    onProgress({ stage: 'validating' });
    const format = await validateUpload(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes.slice().buffer);

    onProgress({ stage: 'decoding' });
    const source = format === 'application/pdf' ? await openPdf(bytes) : imagePageSource(await decodeImage(new Blob([bytes], { type: format })));

    const skeleton = await Promise.all(
      Array.from({ length: source.pageCount }, async (_, i) => ({ sourceRef: `${sha256.slice(0, 16)}-p${i}`, physical: await source.physicalSize(i) })),
    );
    const doc = createDocumentSkeleton(
      { fileName: file.name.slice(0, 200), mimeType: format, byteSize: file.size, sha256, kind: source.kind, pageCount: source.pageCount + source.skippedPages },
      skeleton,
      'tesseract.js',
      languages,
    );
    const session = new DocumentSession(doc, source, client, languages);
    if (source.skippedPages > 0) session.warnings.push(`Only the first ${source.pageCount} pages were loaded (${source.skippedPages} more in the file).`);

    try {
      const patch = await session.processPage(doc.pages[0], (p) => onProgress({ ...p, pageIndex: 0, pageCount: source.pageCount }));
      session.initial.pages[0] = { ...doc.pages[0], ...patch };
    } catch (e) {
      await source.dispose();
      throw e instanceof UploadError || e instanceof PdfInputError ? e : new UploadError(userMessage(e));
    }
    void session.processRemaining();
    return session;
  }

  get pageCount(): number {
    return this.source.pageCount;
  }

  /** Receive background page updates. Updates emitted before subscribing are replayed. */
  subscribe(listener: (cmd: EditCommand) => void): () => void {
    this.listener = listener;
    for (const cmd of this.backlog) listener(cmd);
    this.backlog = [];
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  private emit(cmd: EditCommand) {
    if (this.disposed) return;
    if (this.listener) this.listener(cmd);
    else this.backlog.push(cmd);
  }

  private async processPage(page: Page, onProgress: (p: OpenProgress) => void): Promise<Partial<Page>> {
    onProgress({ stage: this.source.kind === 'pdf' ? 'rendering' : 'decoding' });
    const raster = await this.source.render(page.index);
    await this.client.loadPage(page.sourceRef, raster);

    onProgress({ stage: 'preprocessing' });
    const { ocrImage, skew, ocrScale } = await this.client.preprocess(page.sourceRef);

    onProgress({ stage: 'ocr', progress: 0 });
    const ocr = await ocrEngine(this.languages).recognize({ kind: 'blob', blob: ocrImage }, (p) =>
      onProgress({ stage: 'ocr', progress: p.stage === 'recognizing text' ? p.progress : undefined }),
    );
    // Second look at doubtful words and text the page pass missed (e.g. values in table cells).
    onProgress({ stage: 'recovery' });
    const pageOcr = await this.recover(page.sourceRef, scaleOcrResult(ocr, 1 / ocrScale));

    onProgress({ stage: 'building' });
    const content = await this.client.buildPage(page.sourceRef, page.id, pageOcr, skew);
    return { status: 'ready', statusMessage: undefined, width: raster.width, height: raster.height, skew, ...content };
  }

  private async recover(pageKey: string, ocr: OcrResult): Promise<OcrResult> {
    try {
      const crops = await this.client.recoveryCrops(pageKey, ocr);
      const results: (OcrResult | undefined)[] = [];
      for (const crop of crops) results.push(await ocrEngine(this.languages).recognizeLine({ kind: 'blob', blob: crop.image }).catch(() => undefined));
      return mergeRecovered(
        ocr,
        crops.map((c) => c.meta),
        results,
      );
    } catch (e) {
      // Recovery only improves results; never fail a page because of it.
      console.warn('OCR recovery skipped', e);
      return ocr;
    }
  }

  private async processRemaining(): Promise<void> {
    for (const page of this.initial.pages.slice(1)) {
      if (this.disposed) return;
      this.emit({ type: 'updatePage', pageId: page.id, patch: { status: 'processing' } });
      try {
        const patch = await this.processPage(page, () => undefined);
        this.emit({ type: 'updatePage', pageId: page.id, patch });
      } catch (e) {
        console.error(e);
        this.emit({ type: 'updatePage', pageId: page.id, patch: { status: 'failed', statusMessage: userMessage(e) } });
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listener = undefined;
    await this.source.dispose();
  }
}
