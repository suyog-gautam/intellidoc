import type { Rect } from '../geometry';

/**
 * Engine-neutral OCR contract. The rest of IntelliDoc only depends on these
 * types, so Tesseract can be swapped for another browser OCR engine without
 * touching layout, typography or reconstruction code.
 */
export type OcrInput = { kind: 'blob'; blob: Blob } | { kind: 'bytes'; bytes: Uint8Array };

export interface OcrWord {
  text: string;
  bbox: Rect;
  /** 0..100 */
  confidence: number;
  /** Engine's own line grouping; layout analysis may regroup. */
  lineKey: string;
}

export interface OcrResult {
  engine: string;
  languages: string[];
  words: OcrWord[];
  /** Overall page confidence 0..100. */
  confidence: number;
}

export interface OcrProgress {
  stage: string;
  /** 0..1 */
  progress: number;
}

export interface OcrEngine {
  readonly id: string;
  recognize(input: OcrInput, onProgress?: (p: OcrProgress) => void): Promise<OcrResult>;
  /**
   * Recognise an image known to contain a single line of text (a crop).
   * Used to re-read words the page pass got wrong or missed entirely.
   */
  recognizeLine(input: OcrInput): Promise<OcrResult>;
  dispose(): Promise<void>;
}

export class OcrError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OcrError';
  }
}

/** Map OCR output from a scaled working copy back to page coordinates. */
export function scaleOcrResult(result: OcrResult, factor: number): OcrResult {
  if (factor === 1) return result;
  return {
    ...result,
    words: result.words.map((w) => ({
      ...w,
      bbox: { x: w.bbox.x * factor, y: w.bbox.y * factor, width: w.bbox.width * factor, height: w.bbox.height * factor },
    })),
  };
}
