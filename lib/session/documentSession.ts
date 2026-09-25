import type { EditCommand } from '@/core/document/history';
import type { IntellidocDocument, Page, TextElement } from '@/core/document/model';
import type { RasterImage } from '@/core/image/raster';
import { AUTO, normalizeLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import { chooseLanguages, HEADLINE_PROBE_LANGUAGES, MIN_HEADLINE_WORDS, type LanguageChoice } from '@/core/ocr/detectLanguages';
import { TesseractEngine } from '@/core/ocr/tesseractEngine';
import { mergeRecovered } from '@/core/ocr/recovery';
import { OcrError, scaleOcrResult, type OcrEngine, type OcrResult } from '@/core/ocr/types';
import { createDocumentSkeleton } from '@/core/pipeline/buildDocument';
import { MAX_PIXELS, sha256Hex, UploadError, validateUpload } from '@/lib/image/validateUpload';
import { imagePageSource, type PageSource } from '@/lib/pdf/pageSource';
import { DEFAULT_MAX_PIXELS_PER_PAGE, PdfInputError } from '@/lib/pdf/pdfPageSource';
import { vendorUrl } from '@/lib/browser/paths';
import { deviceBudgets } from '@/lib/browser/deviceProfile';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';
import { handwritingAvailable, HandwritingClient } from '@/lib/workers/handwritingClient';
import type { HandwritingReading } from '@/core/ocr/handwritingPass';
import type { Rect } from '@/core/geometry';

/** Background work the editor shows while it stays usable. */
export interface SessionActivity {
  handwriting?: { pageId: string; done: number; total: number };
}

export interface OpenProgress {
  stage: 'validating' | 'decoding' | 'rendering' | 'preprocessing' | 'detecting' | 'ocr' | 'recovery' | 'building';
  /** 0..1 within the stage, when known. */
  progress?: number;
  pageIndex?: number;
  pageCount?: number;
}

let sharedOcr: { key: string; engine: OcrEngine } | undefined;

/** Handwritten lines read per page at most (each takes about a second). */
const MAX_HANDWRITING_LINES = 40;

/** One Tesseract worker, re-created when the document languages change. */
function createEngine(languages: readonly string[]): TesseractEngine {
  return new TesseractEngine({
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/core'),
    langPath: vendorUrl('tesseract/lang'),
    languages: [...languages],
  });
}

/** Frees the OCR worker (its models and last page image) until the next document needs it. */
function releaseOcr(): void {
  void sharedOcr?.engine.dispose();
  sharedOcr = undefined;
}

function ocrEngine(languages: readonly string[]): OcrEngine {
  const key = languages.join('+');
  if (sharedOcr?.key !== key) {
    void sharedOcr?.engine.dispose();
    sharedOcr = { key, engine: createEngine(languages) };
  }
  return sharedOcr.engine;
}


function browserLocales(): string[] {
  try {
    return [...(navigator.languages ?? [navigator.language])].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * "Auto" language: detect page 1's script and choose the OCR languages
 * (see core/ocr/detectLanguages.ts). Only runs when the user left the
 * language on Auto; downloads the OSD engine (~9 MB, cached) and, for
 * headline scripts, three small recognition models.
 */
async function detectLanguages(ocrImage: Blob, headlines: { words: number; band?: Blob } | undefined): Promise<LanguageChoice> {
  const locales = browserLocales();
  // Released right after: the OSD worker holds its own copy of the page (hundreds of MB for upscaled photos).
  const detector = createEngine(['eng']);
  const osd = await detector
    .detectScript({ kind: 'blob', blob: ocrImage })
    .catch(() => undefined)
    .finally(() => void detector.dispose());
  let headlineProbeText: string | undefined;
  if (headlines && headlines.words >= MIN_HEADLINE_WORDS && headlines.band) {
    const probe = createEngine(HEADLINE_PROBE_LANGUAGES);
    try {
      const r = await probe.recognize({ kind: 'blob', blob: headlines.band });
      headlineProbeText = r.words.map((w) => w.text).join(' ');
    } catch {
      // No probe: OSD or the locale decides.
    } finally {
      void probe.dispose();
    }
  }
  return chooseLanguages({ osd, headlineWords: headlines?.words ?? 0, headlineProbeText, locales });
}

/** Decodes an uploaded image, downscaled to what this device can hold (`maxPixels`). */
async function decodeImage(blob: Blob, maxPixels: number, warnings: string[]): Promise<RasterImage> {
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
    const k = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * k));
    const height = Math.max(1, Math.round(bitmap.height * k));
    if (k < 1) warnings.push(`The image was reduced from ${bitmap.width}×${bitmap.height} to ${width}×${height} pixels to fit this device's memory.`);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    bitmap.close();
  }
}

async function openPdf(bytes: Uint8Array, maxPixelsPerPage: number): Promise<PageSource> {
  // Loaded on demand so image-only users never download pdf.js.
  const [pdfjs, { openPdfSource }] = await Promise.all([import('pdfjs-dist'), import('@/lib/pdf/pdfPageSource')]);
  pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');
  return openPdfSource(pdfjs, bytes, {
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    wasmUrl: vendorUrl('pdfjs/wasm/'),
    iccUrl: vendorUrl('pdfjs/iccs/'),
    createCanvas: (w, h) => new OffscreenCanvas(w, h),
    maxPixelsPerPage,
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
  private activityListener: ((a: SessionActivity) => void) | undefined;
  private activity: SessionActivity = {};
  private backlog: EditCommand[] = [];
  private disposed = false;
  private readonly budgets = deviceBudgets();
  private handwriting: HandwritingClient | undefined;
  /** Handwriting passes run one page at a time, after OCR (the model is slow: ~1 s per line). */
  private handwritingQueue: Promise<void> = Promise.resolve();
  private finishOcr!: () => void;
  /** Resolves once every page is read (and, on smaller devices, the OCR worker is freed). */
  private readonly ocrFinished = new Promise<void>((resolve) => (this.finishOcr = resolve));

  private constructor(
    readonly initial: IntellidocDocument,
    private readonly source: PageSource,
    private readonly client: ReconstructionClient,
    /** Tesseract language codes, e.g. ['nep', 'eng'], or ['auto'] until page 1 has been detected. */
    private langs: readonly string[],
  ) {}

  /** OCR languages of the document (detected ones once page 1 is read in Auto mode). */
  get languages(): readonly string[] {
    return this.langs;
  }

  /** How Auto chose the languages, if it did. */
  detection: LanguageChoice | undefined;

  static async open(file: File, client: ReconstructionClient, onProgress: (p: OpenProgress) => void, languageCodes: Iterable<string> = ['eng']): Promise<DocumentSession> {
    const languages = normalizeLanguages(languageCodes);
    onProgress({ stage: 'validating' });
    const format = await validateUpload(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes.slice().buffer);

    onProgress({ stage: 'decoding' });
    const budgets = deviceBudgets();
    const warnings: string[] = [];
    const source =
      format === 'application/pdf'
        ? await openPdf(bytes, Math.min(DEFAULT_MAX_PIXELS_PER_PAGE, budgets.imagePixels))
        : imagePageSource(await decodeImage(new Blob([bytes], { type: format }), budgets.imagePixels, warnings));

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
    session.warnings.push(...warnings);
    if (source.skippedPages > 0) session.warnings.push(`Only the first ${source.pageCount} pages were loaded (${source.skippedPages} more in the file).`);

    try {
      const patch = await session.processPage(doc.pages[0], (p) => onProgress({ ...p, pageIndex: 0, pageCount: source.pageCount }));
      session.initial.pages[0] = { ...doc.pages[0], ...patch };
      session.queueHandwriting(session.initial.pages[0]);
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

  /** Receive background activity (e.g. handwriting reading progress); called with the current state at once. */
  subscribeActivity(listener: (a: SessionActivity) => void): () => void {
    this.activityListener = listener;
    listener(this.activity);
    return () => {
      if (this.activityListener === listener) this.activityListener = undefined;
    };
  }

  private setActivity(a: SessionActivity) {
    this.activity = a;
    if (!this.disposed) this.activityListener?.(a);
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
    const auto = this.langs[0] === AUTO;
    const { ocrImage, skew, ocrScale, headlines } = await this.client.preprocess(page.sourceRef, auto, this.budgets.ocrPixels);
    if (auto) {
      onProgress({ stage: 'detecting' });
      this.detection = await detectLanguages(ocrImage, headlines);
      this.langs = this.detection.languages;
      this.initial.processing.ocrLanguages = [...this.langs];
    }

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
        this.queueHandwriting({ ...page, ...patch });
      } catch (e) {
        console.error(e);
        this.emit({ type: 'updatePage', pageId: page.id, patch: { status: 'failed', statusMessage: userMessage(e) } });
      }
    }
    // Every page is read: on smaller devices give the OCR worker's memory back to editing.
    if (this.budgets.tier !== 'high' && !this.disposed) releaseOcr();
    this.finishOcr();
  }

  /** A shared handwriting reader (for the editor's "Read as handwriting"), or undefined if the model isn't deployed. */
  async handwritingReader(): Promise<HandwritingClient | undefined> {
    if (this.disposed || !(await handwritingAvailable())) return undefined;
    return (this.handwriting ??= new HandwritingClient());
  }

  /** Is handwriting read automatically after OCR on this device? */
  get autoHandwriting(): boolean {
    return this.budgets.autoHandwriting;
  }

  /** Can "Read as handwriting" be offered? (English model deployed, Latin-script document.) */
  async canReadHandwriting(): Promise<boolean> {
    return scriptsOfLanguages(this.langs).includes('latin') && (await handwritingAvailable());
  }

  /** Read one page area with the handwriting model, e.g. an element Tesseract misread. */
  async readHandwriting(pageKey: string, rect: Rect): Promise<HandwritingReading | undefined> {
    const reader = await this.handwritingReader();
    if (!reader) return undefined;
    // Margins as the background pass uses: the model expects some paper around the ink.
    const m = rect.height * 0.3;
    return reader.recognize(await this.client.handwritingCrop(pageKey, { x: rect.x - m, y: rect.y - m / 2, width: rect.width + 2 * m, height: rect.height + m }));
  }

  /**
   * Re-read handwritten lines with the handwriting model in the background.
   * Tesseract is trained on print and returns fragments for handwriting; the
   * readings arrive as a `readHandwriting` command that replaces only lines
   * the user hasn't touched meanwhile. English-only model, so Latin documents only.
   */
  private queueHandwriting(page: Page): void {
    if (!this.budgets.autoHandwriting || !scriptsOfLanguages(this.langs).includes('latin')) return;
    const elements: TextElement[] = page.textElements;
    this.handwritingQueue = this.handwritingQueue.then(async () => {
      try {
        // Low-end devices never hold the OCR worker and the handwriting model (~300 MB) at once.
        if (this.budgets.tier === 'low') await this.ocrFinished;
        const reader = await this.handwritingReader();
        if (!reader) return;
        const lines = (await this.client.handwritingLines(page.sourceRef, elements)).slice(0, MAX_HANDWRITING_LINES);
        if (!lines.length || this.disposed) return;
        // Each line is applied as soon as it is read, so the text improves while the user works.
        for (const [i, { image, ...group }] of lines.entries()) {
          if (this.disposed) return;
          this.setActivity({ handwriting: { pageId: page.id, done: i, total: lines.length } });
          const reading = await reader.recognize(image);
          if (reading) this.emit({ type: 'readHandwriting', pageId: page.id, groups: [group], readings: [reading] });
        }
      } catch (e) {
        // Handwriting reading only improves results; never fail a page because of it.
        console.warn('Handwriting pass skipped', e);
      } finally {
        this.setActivity({});
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listener = undefined;
    this.handwriting?.dispose();
    await this.source.dispose();
  }
}
