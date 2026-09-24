import { describe, expect, it } from 'vitest';
import type { Page, TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { createMask } from '@/core/image/filters';
import { cloneRaster, createRaster } from '@/core/image/raster';
import { pushPullFill } from '@/core/reconstruction/inpaint';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const rasterizer = createNodeRasterizer();

describe('push-pull inpainting', () => {
  it('reconstructs a smooth gradient under a hole', () => {
    const w = 120;
    const h = 60;
    const img = createRaster(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 100 + x;
      img.data[o + 3] = 255;
    }
    const known = createMask(w, h);
    known.data.fill(1);
    for (let y = 20; y < 40; y++) for (let x = 40; x < 80; x++) known.data[y * w + x] = 0;
    const out = pushPullFill(img, known);
    let maxErr = 0;
    for (let y = 20; y < 40; y++) for (let x = 40; x < 80; x++) maxErr = Math.max(maxErr, Math.abs(out.data[(y * w + x) * 4] - (100 + x)));
    expect(maxErr).toBeLessThan(8);
  });
});

describe('text replacement', () => {
  function setup() {
    const page = syntheticPaper(800, 220, 11);
    // A table rule just below the text that must survive the edit.
    for (let x = 20; x < 780; x++) for (let y = 150; y < 152; y++) {
      const o = (y * 800 + x) * 4;
      page.data[o] = page.data[o + 1] = page.data[o + 2] = 70;
    }
    const text = '13-09-2024';
    const frame = { cx: 400, cy: 110, width: 700, height: 140, angle: 0 };
    const box = drawText(page, rasterizer, text, frame, defaultParams({ originX: 200, baselineY: 70 }));
    const el: TextElement = {
      id: 'e1', pageId: 'p0', sourceText: text, text, bbox: orientedBoundingRect(box), box, ocrConfidence: 95,
      readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left',
    };
    el.typography = analyzeElement(page, el, rasterizer);
    const pageModel: Page = { id: 'p0', index: 0, sourceRef: 's', width: 800, height: 220, skew: 0, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', layout: { lines: [] }, textElements: [el] };
    return { page, el, pageModel };
  }

  it('never mutates the original and leaves distant pixels untouched', () => {
    const { page, el, pageModel } = setup();
    const before = cloneRaster(page);
    const out = renderPage(page, { ...pageModel, textElements: [{ ...el, text: '19-07-2026', state: 'edited' }] }, rasterizer).image;
    expect(page.data).toEqual(before.data);
    // Far corner is identical.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      const o = (y * 800 + x) * 4;
      expect(out.data[o]).toBe(page.data[o]);
    }
  });

  it('keeps ruling lines intact when deleting text', () => {
    const { page, el, pageModel } = setup();
    const out = renderPage(page, { ...pageModel, textElements: [{ ...el, state: 'deleted' }] }, rasterizer).image;
    for (let x = 30; x < 770; x += 7) {
      const o = (150 * 800 + x) * 4;
      expect(out.data[o]).toBeLessThan(100);
    }
    // Text area is now paper-bright.
    let dark = 0;
    for (let y = 40; y < 80; y++) for (let x = 190; x < 400; x++) if (out.data[(y * 800 + x) * 4] < 150) dark++;
    expect(dark).toBe(0);
  });
});
