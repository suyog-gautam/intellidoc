/// <reference lib="webworker" />
/**
 * Reconstruction worker: preprocessing, typography analysis, background
 * reconstruction, page rendering and export encoding all run here, off the
 * UI thread. Original page rasters live in a memory-bounded PageStore.
 */
import { cloneRaster, type RasterImage } from '@/core/image/raster';
import { analyzeElement, clipSlotToNeighbours } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { CanvasTextRasterizer, type CanvasLike } from '@/core/rendering/textRasterizer';
import { pageContentFromOcr } from '@/core/pipeline/buildDocument';
import { cropForLineOcr, findRecoveryRegions } from '@/core/ocr/recovery';
import { estimatePageSkew, estimateTextHeight, grayToRaster, normalizeIllumination, prepareOcrImage } from '@/core/vision/preprocess';
import { findHeadlineWords } from '@/core/vision/headlines';
import { cropRaster } from '@/core/image/raster';
import { cjkRegionsOfLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import type { Page } from '@/core/document/model';
import { elementIsModified } from '@/core/document/model';
import { candidateFonts } from '@/core/typography/fontFaces';
import { loadFontsFor } from '@/lib/browser/fonts';
import { PageStore } from './pageStore';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope & { fonts: FontFaceSet };

// Fonts are only needed once text is analysed or rendered, not for OCR, and
// then only the slices of the fonts and characters at hand (a page of
// Chinese loads a few of Noto Sans SC's ~100 slices).
/** "HXE": capital height reference used when the user switches fonts (styleTransfer.capHeight). */
const REFERENCE = 'HXE';

/** Fonts each modified element renders with (detected, chosen, glyph-variant donors) and their texts. */
function pageFontsReady(page: Page): Promise<unknown> {
  const loads: Promise<void>[] = [];
  for (const el of page.textElements) {
    if (!elementIsModified(el) || !el.typography) continue;
    const p = { ...el.typography.params, ...el.styleOverrides };
    const ids = new Set([el.typography.params.fontId, p.fontId, ...Object.values(p.glyphFonts ?? {})]);
    loads.push(loadFontsFor(self.fonts, ids, [el.text, el.sourceText, REFERENCE]));
  }
  return Promise.all(loads);
}
const rasterizer = new CanvasTextRasterizer((w, h) => {
  const canvas = new OffscreenCanvas(w, h);
  return {
    get width() {
      return canvas.width;
    },
    get height() {
      return canvas.height;
    },
    getContext: () => canvas.getContext('2d', { willReadFrequently: true }),
  } as CanvasLike;
});

async function encode(img: RasterImage, type: string, quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type, quality });
}

const store = new PageStore({
  encode: (img) => encode(img, 'image/png'),
  async decode(blob) {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: d.width, height: d.height, data: d.data };
  },
});

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function postRaster(id: number, img: RasterImage, pending: string[] = [], overflowing: string[] = []) {
  const buffer = img.data.buffer as ArrayBuffer;
  post({ type: 'raster', id, width: img.width, height: img.height, buffer, pending, overflowing }, [buffer]);
}

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case 'loadPage':
      await store.put(req.pageKey, { width: req.width, height: req.height, data: new Uint8ClampedArray(req.buffer) });
      post({ type: 'ok', id: req.id });
      return;
    case 'preprocess': {
      const page = await store.get(req.pageKey);
      const skew = estimatePageSkew(page);
      const working = prepareOcrImage(page);
      const ocrRaster = grayToRaster(working.image);
      const ocrImage = await encode(ocrRaster, 'image/png');
      let headlines: { words: number; band?: Blob } | undefined;
      if (req.findHeadlines) {
        const found = findHeadlineWords(page, working.textHeight);
        const band = found.band && {
          x: 0,
          y: Math.floor(found.band.y * working.scale),
          width: ocrRaster.width,
          height: Math.min(ocrRaster.height - Math.floor(found.band.y * working.scale), Math.ceil(found.band.height * working.scale)),
        };
        headlines = { words: found.words, band: band && band.height > 0 ? await encode(cropRaster(ocrRaster, band), 'image/png') : undefined };
      }
      post({ type: 'preprocessed', id: req.id, ocrImage, skew: skew.angle, ocrScale: working.scale, headlines });
      return;
    }
    case 'recoveryCrops': {
      const page = await store.get(req.pageKey);
      const textHeight = estimateTextHeight(page);
      const regions = findRecoveryRegions(page, req.ocr, textHeight);
      const normalized = regions.length ? normalizeIllumination(page) : undefined;
      const crops = [];
      for (const region of regions) {
        const { image, ...meta } = cropForLineOcr(page, normalized!, region, textHeight);
        crops.push({ meta, image: await encode(image, 'image/png') });
      }
      post({ type: 'recoveryCrops', id: req.id, crops });
      return;
    }
    case 'buildPage': {
      const content = pageContentFromOcr(req.pageId, req.ocr, req.skew, await store.get(req.pageKey));
      post({ type: 'pageBuilt', id: req.id, ...content });
      return;
    }
    case 'analyze': {
      const languages = req.languages ?? [];
      const contextScripts = scriptsOfLanguages(languages);
      const cjkRegions = cjkRegionsOfLanguages(languages);
      // Candidates for numbers in, say, a Nepali document include Devanagari families.
      const candidates = candidateFonts(req.element.sourceText.trim(), { scripts: contextScripts, cjkRegions }).map((f) => f.id);
      await loadFontsFor(self.fonts, candidates, [req.element.sourceText, req.element.text, REFERENCE]);
      const est = analyzeElement(await store.get(req.pageKey), req.element, rasterizer, { contextScripts, cjkRegions });
      post({ type: 'analyzed', id: req.id, typography: est && clipSlotToNeighbours(est, req.page, req.element) });
      return;
    }
    case 'render': {
      await pageFontsReady(req.page);
      const result = renderPage(await store.get(req.pageKey), req.page, rasterizer);
      postRaster(req.id, result.image, result.pending, result.overflowing);
      return;
    }
    case 'thumbnail': {
      const page = await store.get(req.pageKey);
      const w = Math.max(16, Math.round(req.width));
      const h = Math.max(16, Math.round((page.height * w) / page.width));
      const full = await createImageBitmap(new ImageData(new Uint8ClampedArray(page.data), page.width, page.height));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, 0, 0, w, h);
      full.close();
      post({ type: 'encoded', id: req.id, blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) });
      return;
    }
    case 'getOriginal':
      // A copy: the stored original must stay intact for later reconstruction.
      postRaster(req.id, cloneRaster(await store.get(req.pageKey)));
      return;
    case 'encodePage': {
      await pageFontsReady(req.page);
      const result = renderPage(await store.get(req.pageKey), req.page, rasterizer);
      post({ type: 'encoded', id: req.id, blob: await encode(result.image, req.mimeType, req.quality) });
      return;
    }
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  handle(ev.data).catch((err: unknown) => {
    post({ type: 'error', id: ev.data.id, message: err instanceof Error ? err.message : String(err) });
  });
};
