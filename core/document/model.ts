import type { OrientedBox, Rect } from '../geometry';

/**
 * IntelliDoc document model: the single source of truth.
 *
 * The original source raster is never stored or mutated here; pages refer to
 * it by `sourceRef`. Everything visible in the output is derived from
 * (original source + this model), so edits are always reversible.
 */
export const DOCUMENT_SCHEMA_VERSION = 1;

export type Id = string;

export interface DocumentSource {
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** SHA-256 of the original file bytes (hex). Used for provenance/caching. */
  sha256: string;
  kind: 'image' | 'pdf';
  /** Pages in the file (may exceed `pages.length` when limits applied). */
  pageCount: number;
}

export interface ProcessingInfo {
  /** Version of the IntelliDoc pipeline that produced the model. */
  pipelineVersion: string;
  ocrEngine: string;
  ocrLanguages: string[];
  createdAt: string;
}

export interface IntellidocDocument {
  schemaVersion: number;
  id: Id;
  source: DocumentSource;
  processing: ProcessingInfo;
  pages: Page[];
}

export type PageStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Page {
  id: Id;
  index: number;
  /** Key of the immutable source raster for this page (storage/worker cache key). */
  sourceRef: string;
  /** Pixel size of the page raster (0 until the page has been rendered). */
  width: number;
  height: number;
  /** Physical size for export, in PDF points. From the PDF, or assumed DPI for images. */
  physical: { widthPt: number; heightPt: number };
  /** Pages are processed progressively; only 'ready' pages have OCR content. */
  status: PageStatus;
  statusMessage?: string;
  /** Dominant text skew of the page, radians. */
  skew: number;
  textElements: TextElement[];
  /** Detected ruling lines etc. Reserved for tables/forms (phase 3). */
  layout: PageLayout;
}

export interface PageLayout {
  lines: LayoutLine[];
}

export interface LayoutLine {
  id: Id;
  elementIds: Id[];
  bbox: Rect;
}

export interface WordInfo {
  text: string;
  bbox: Rect;
  confidence: number;
}

export type EditState = 'original' | 'edited' | 'deleted';

export type TextAlignment = 'left' | 'center' | 'right';

/**
 * One editable text run: a sequence of words on a line whose spacing implies
 * they belong together (e.g. a table cell or a "label: value" half).
 */
export interface TextElement {
  id: Id;
  pageId: Id;
  /** What the scan actually says. Starts as OCR output; the user may correct it. */
  sourceText: string;
  /** Desired text. Differs from `sourceText` once edited. */
  text: string;
  /** Axis-aligned bounds of the OCR words. */
  bbox: Rect;
  /** Rotated box tightly aligned to the text baseline direction. */
  box: OrientedBox;
  ocrConfidence: number;
  readingOrder: number;
  lineId: Id;
  words: WordInfo[];
  state: EditState;
  /** 'ocr' = recognised in the scan (default); 'added' = a new text box placed by the user. */
  origin?: 'ocr' | 'added';
  /** Element whose style was applied (copy/paste or "match style"), for the UI. */
  styleSourceId?: Id;
  alignment: TextAlignment;
  /** True once the user chose the alignment; analysis then stops overriding it. */
  alignmentLocked?: boolean;
  /** Quick style measured from pixels at layout time (median over the run's words). */
  visualStyle?: { strokeWidth: number; glyphHeight: number; inkColor: [number, number, number] };
  /** Filled by typography analysis; absent until analysed. */
  typography?: TypographyEstimate;
  /** Manual overrides applied on top of the estimate. */
  styleOverrides?: Partial<RenderParams>;
}

export type FontCategory = 'sans' | 'serif' | 'mono' | 'condensed' | 'handwriting';

/**
 * Parameters that fully determine how text is rasterised. Coordinates are in
 * the element's upright analysis frame (see {@link TypographyEstimate.frame}).
 */
export interface RenderParams {
  fontId: string;
  weight: number;
  italic: boolean;
  /** CSS pixel size of the font. */
  fontSize: number;
  /** Horizontal scale applied to glyphs (1 = natural). */
  scaleX: number;
  /** Extra space after each glyph, in px. */
  letterSpacing: number;
  /** Extra space for each space character, in px. */
  wordSpacing: number;
  /** Synthetic slant, tan(angle). */
  skewX: number;
  /** Synthetic emboldening: stroke width added around glyphs, px. */
  embolden: number;
  /** Gaussian blur sigma emulating scanner/camera optics, px. */
  blur: number;
  /** Pen origin x of the first glyph, local frame. */
  originX: number;
  /** Baseline y, local frame. */
  baselineY: number;
  /** Ink colour (sRGB 0..255). */
  color: [number, number, number];
  /** 0..1 multiplier on coverage. */
  opacity: number;
  /**
   * Glyph variants: character (cluster) → candidate font that draws it,
   * scaled to this font's size of that character and centred in its advance
   * (layout is unchanged). Fonts disagree on details such as a foot under
   * "1" or a two-storey "g"; the fitter picks, per character, the variant
   * the scan shows. A value equal to `fontId` means "the font's own glyph".
   */
  glyphFonts?: Record<string, string>;
  /**
   * Natural variation 0..1 for handwriting: small per-character baseline,
   * size and angle wobble (deterministic per text), so replacements don't
   * look typeset. 0 or absent for print.
   */
  jitter?: number;
}

export interface FidelityMetrics {
  /** Mean absolute RGB error over the text region, 0..255. Lower is better. */
  photometricError: number;
  /** Intersection-over-union of ink silhouettes, 0..1. */
  silhouetteIoU: number;
  widthRatio: number;
  heightRatio: number;
  strokeRatio: number;
  /** Combined 0..1 similarity (1 = perfect). */
  score: number;
}

export interface FontCandidateScore {
  fontId: string;
  weight: number;
  italic: boolean;
  score: number;
}

export interface TypographyEstimate {
  /**
   * Upright analysis frame on the page. `RenderParams` coordinates are local
   * to this frame, which is larger than the text to include margins.
   */
  frame: OrientedBox;
  /** OCR text box inside the frame (local coordinates). */
  textBox: Rect;
  /**
   * Free horizontal space around the text in local coordinates, bounded by
   * detected ruling lines (table cells, form boxes) where present.
   */
  slot: { left: number; right: number; leftBounded: boolean; rightBounded: boolean };
  inferredAlignment: TextAlignment;
  /** 'light' for light text on a dark background. Absent in older estimates = 'dark'. */
  polarity?: 'dark' | 'light';
  params: RenderParams;
  /** Font category guessed from the best candidates. */
  category: FontCategory;
  /** Ranked alternatives, best first. The font is an estimate, never a claim. */
  candidates: FontCandidateScore[];
  /** Measured from pixels. */
  measured: {
    inkHeight: number;
    inkWidth: number;
    strokeWidth: number;
    background: [number, number, number];
    noiseSigma: number;
  };
  fidelity: FidelityMetrics;
  /** 0..1 confidence that the reconstruction will look right. */
  confidence: number;
  analyzerVersion: string;
}

export function elementIsModified(el: TextElement): boolean {
  if (el.origin === 'added') return el.state !== 'deleted' && el.text.trim() !== '';
  return el.state === 'deleted' || (el.state === 'edited' && (el.text !== el.sourceText || el.styleOverrides !== undefined));
}

export function findElement(doc: IntellidocDocument, elementId: Id): { page: Page; element: TextElement } | undefined {
  for (const page of doc.pages) {
    const element = page.textElements.find((e) => e.id === elementId);
    if (element) return { page, element };
  }
  return undefined;
}
