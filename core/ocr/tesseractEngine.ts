import Tesseract from 'tesseract.js';
import { OcrError, type OcrEngine, type OcrInput, type OcrProgress, type OcrResult, type OcrWord } from './types';

export interface TesseractEngineOptions {
  languages?: string[];
  /** Where worker.min.js lives. Browser: same-origin vendor path. Omit in Node. */
  workerPath?: string;
  /** Directory containing tesseract-core*.wasm(.js). */
  corePath?: string;
  /** Directory containing <lang>.traineddata.gz. */
  langPath: string;
  /** Node only: where to cache decompressed language data. */
  cachePath?: string;
  /** Tesseract page segmentation mode. '3' = automatic, '11' = sparse text. */
  pageSegMode?: string;
}

/**
 * Tesseract.js adapter.
 *
 * Tesseract.js runs recognition inside its own dedicated Web Worker (WASM),
 * so the UI thread stays responsive. All assets are loaded from paths we
 * control (same origin in the browser), so no document-related request ever
 * leaves the device.
 */
export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract.js';
  private worker: Tesseract.Worker | undefined;
  private progressListener: ((p: OcrProgress) => void) | undefined;

  constructor(private readonly options: TesseractEngineOptions) {}

  private async getWorker(): Promise<Tesseract.Worker> {
    if (this.worker) return this.worker;
    const { languages = ['eng'], workerPath, corePath, langPath, cachePath } = this.options;
    try {
      this.worker = await Tesseract.createWorker(languages, Tesseract.OEM.LSTM_ONLY, {
        ...(workerPath ? { workerPath } : {}),
        ...(corePath ? { corePath } : {}),
        ...(cachePath ? { cachePath } : {}),
        langPath,
        gzip: true,
        logger: (m) => this.progressListener?.({ stage: m.status, progress: m.progress }),
        errorHandler: () => undefined,
      });
      await this.worker.setParameters({
        tessedit_pageseg_mode: (this.options.pageSegMode ?? '3') as Tesseract.PSM,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return this.worker;
    } catch (cause) {
      this.worker = undefined;
      throw new OcrError('Failed to initialise Tesseract', 'The text recognition engine could not be started. Please retry.', { cause });
    }
  }

  async recognize(input: OcrInput, onProgress?: (p: OcrProgress) => void): Promise<OcrResult> {
    const worker = await this.getWorker();
    this.progressListener = onProgress;
    const image = (input.kind === 'blob' ? input.blob : input.bytes) as Tesseract.ImageLike;
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
      return {
        engine: this.id,
        languages: this.options.languages ?? ['eng'],
        words: flattenWords(data),
        confidence: data.confidence,
      };
    } catch (cause) {
      throw new OcrError('Tesseract recognition failed', 'Text recognition failed for this page. You can retry or edit manually.', { cause });
    } finally {
      this.progressListener = undefined;
    }
  }

  async recognizeLine(input: OcrInput): Promise<OcrResult> {
    const worker = await this.getWorker();
    const image = (input.kind === 'blob' ? input.blob : input.bytes) as Tesseract.ImageLike;
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
      return { engine: this.id, languages: this.options.languages ?? ['eng'], words: flattenWords(data), confidence: data.confidence };
    } catch (cause) {
      throw new OcrError('Tesseract line recognition failed', 'Text recognition failed for part of this page.', { cause });
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: (this.options.pageSegMode ?? '3') as Tesseract.PSM });
    }
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}

function flattenWords(page: Tesseract.Page): OcrWord[] {
  const words: OcrWord[] = [];
  (page.blocks ?? []).forEach((block, bi) =>
    block.paragraphs.forEach((para, pi) =>
      para.lines.forEach((line, li) => {
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text) continue;
          words.push({
            text,
            bbox: { x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 },
            confidence: w.confidence,
            lineKey: `${bi}.${pi}.${li}`,
          });
        }
      }),
    ),
  );
  return words;
}
