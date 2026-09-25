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
  /** Dominant script of a page (orientation and script detection), when the engine supports it. */
  detectScript?(input: OcrInput): Promise<ScriptDetection | undefined>;
  dispose(): Promise<void>;
}

export interface ScriptDetection {
  /** Engine script name, e.g. "Latin", "Devanagari", "Han", "Japanese", "Arabic". */
  script: string;
  /** Engine-specific confidence (Tesseract OSD: roughly 0–30; above ~1.5 is dependable). */
  confidence: number;
  /** Clockwise page rotation the text appears to have, degrees. */
  orientation: number;
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
