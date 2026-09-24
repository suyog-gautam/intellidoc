import {
  DOCUMENT_SCHEMA_VERSION,
  type DocumentSource,
  type IntellidocDocument,
  type LayoutLine,
  type Page,
  type PageLayout,
  type TextElement,
} from '../document/model';
import { orientedFromAxisAligned } from '../geometry';
import type { RasterImage } from '../image/raster';
import { segmentWords, type SegmentedRun } from '../layout/segment';
import { measureWordStyles } from '../layout/wordStyle';
import { estimateTextHeight } from '../vision/preprocess';
import type { OcrResult } from '../ocr/types';

export const PIPELINE_VERSION = '0.2.0';

export interface PageSkeleton {
  sourceRef: string;
  physical: { widthPt: number; heightPt: number };
}

export interface ProcessedPage {
  width: number;
  height: number;
  skew: number;
  ocr: OcrResult;
  /** Page pixels; enables word-style measurement and style-aware splitting. */
  raster?: RasterImage;
}

export function pageIdFor(index: number): string {
  return `p${index}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runStyle(run: SegmentedRun): TextElement['visualStyle'] {
  const styles = run.words.map((w) => w.style).filter((s) => s !== undefined);
  if (styles.length === 0) return undefined;
  return {
    strokeWidth: median(styles.map((s) => s.strokeWidth)),
    glyphHeight: median(styles.map((s) => s.glyphHeight)),
    inkColor: [0, 1, 2].map((c) => median(styles.map((s) => s.inkColor[c]))) as [number, number, number],
  };
}

/**
 * Text elements and layout for one page from its OCR result. With the page
 * raster, word boxes are tightened to their ink and runs are also split where
 * the visual style changes (e.g. a bold label followed by a regular value).
 */
export function pageContentFromOcr(pageId: string, ocr: OcrResult, skew: number, raster?: RasterImage): { textElements: TextElement[]; layout: PageLayout } {
  const words = raster ? measureWordStyles(raster, ocr.words, estimateTextHeight(raster)) : ocr.words;
  const lines = segmentWords(words);
  const textElements: TextElement[] = [];
  const layoutLines: LayoutLine[] = [];
  lines.forEach((line, li) => {
    const lineId = `${pageId}-l${li}`;
    const elementIds: string[] = [];
    for (const run of line.runs) {
      const id = `${pageId}-e${textElements.length}`;
      elementIds.push(id);
      textElements.push({
        id,
        pageId,
        sourceText: run.text,
        text: run.text,
        bbox: run.bbox,
        box: orientedFromAxisAligned(run.bbox, skew),
        ocrConfidence: run.confidence,
        readingOrder: textElements.length,
        lineId,
        words: run.words.map((w) => ({ text: w.text, bbox: w.bbox, confidence: w.confidence })),
        state: 'original',
        alignment: 'left',
        visualStyle: runStyle(run),
      });
    }
    layoutLines.push({ id: lineId, elementIds, bbox: line.bbox });
  });
  return { textElements, layout: { lines: layoutLines } };
}

/** A document whose pages are known but not processed yet (progressive loading). */
export function createDocumentSkeleton(source: DocumentSource, pages: readonly PageSkeleton[], ocrEngine: string, ocrLanguages: string[]): IntellidocDocument {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: `doc-${source.sha256.slice(0, 16)}`,
    source,
    processing: { pipelineVersion: PIPELINE_VERSION, ocrEngine, ocrLanguages, createdAt: new Date().toISOString() },
    pages: pages.map(
      (p, index): Page => ({
        id: pageIdFor(index),
        index,
        sourceRef: p.sourceRef,
        width: 0,
        height: 0,
        physical: p.physical,
        status: 'pending',
        skew: 0,
        textElements: [],
        layout: { lines: [] },
      }),
    ),
  };
}

/** Patch that turns a pending page into a ready one. */
export function readyPagePatch(pageId: string, processed: ProcessedPage): Partial<Page> {
  return { status: 'ready', statusMessage: undefined, width: processed.width, height: processed.height, skew: processed.skew, ...pageContentFromOcr(pageId, processed.ocr, processed.skew, processed.raster) };
}

/** Convenience for tests/scripts: build a fully processed document in one go. */
export function buildDocument(source: DocumentSource, pages: Array<PageSkeleton & ProcessedPage>): IntellidocDocument {
  const first = pages[0];
  const doc = createDocumentSkeleton(source, pages, first?.ocr.engine ?? 'none', first?.ocr.languages ?? []);
  return { ...doc, pages: doc.pages.map((p, i) => ({ ...p, ...readyPagePatch(p.id, pages[i]) })) };
}
