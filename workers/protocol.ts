import type { Page, PageLayout, TextElement, TypographyEstimate } from '@/core/document/model';
import type { RecoveryCropMeta } from '@/core/ocr/recovery';
import type { OcrResult } from '@/core/ocr/types';

/**
 * Message protocol of the reconstruction worker. Page rasters are transferred
 * once (`loadPage`) and stay in the worker; later requests only carry small
 * document-model objects.
 */
export type WorkerRequest =
  | { type: 'loadPage'; id: number; pageKey: string; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'preprocess'; id: number; pageKey: string }
  /** Layout from OCR words + page pixels (word styles, style-aware runs). OCR in page coordinates. */
  | { type: 'buildPage'; id: number; pageKey: string; pageId: string; ocr: OcrResult; skew: number }
  /** OCR recovery: crops of low-confidence words and uncovered text, for single-line re-recognition. */
  | { type: 'recoveryCrops'; id: number; pageKey: string; ocr: OcrResult }
  | { type: 'analyze'; id: number; pageKey: string; page: Page; element: TextElement }
  | { type: 'render'; id: number; pageKey: string; page: Page }
  | { type: 'getOriginal'; id: number; pageKey: string }
  /** Small JPEG preview of the original page for the thumbnail rail. */
  | { type: 'thumbnail'; id: number; pageKey: string; width: number }
  /** Render a page and encode it (for export). */
  | { type: 'encodePage'; id: number; pageKey: string; page: Page; mimeType: 'image/png' | 'image/jpeg'; quality?: number };

export type WorkerResponse =
  | { type: 'ok'; id: number }
  | { type: 'preprocessed'; id: number; ocrImage: Blob; skew: number; ocrScale: number }
  | { type: 'pageBuilt'; id: number; textElements: TextElement[]; layout: PageLayout }
  | { type: 'recoveryCrops'; id: number; crops: Array<{ meta: RecoveryCropMeta; image: Blob }> }
  | { type: 'analyzed'; id: number; typography: TypographyEstimate | undefined }
  | { type: 'raster'; id: number; width: number; height: number; buffer: ArrayBuffer; pending: string[]; overflowing: string[] }
  | { type: 'encoded'; id: number; blob: Blob }
  | { type: 'error'; id: number; message: string };
