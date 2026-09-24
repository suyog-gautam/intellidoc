import { describe, expect, it } from 'vitest';
import type { TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { cloneRaster } from '@/core/image/raster';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const rasterizer = createNodeRasterizer();

function element(text: string, box: ReturnType<typeof drawText>): TextElement {
  return {
    id: 'e1',
    pageId: 'p0',
    sourceText: text,
    text,
    bbox: orientedBoundingRect(box),
    box,
    ocrConfidence: 95,
    readingOrder: 0,
    lineId: 'l0',
    words: [],
    state: 'original',
    alignment: 'left',
  };
}

describe('typography fitting (ground truth)', () => {
  const cases = [
    { name: 'sans regular', fontId: 'arimo', weight: 400, angle: 0 },
    { name: 'sans bold, rotated', fontId: 'arimo', weight: 700, angle: (2 * Math.PI) / 180 },
    { name: 'serif regular', fontId: 'tinos', weight: 400, angle: (-1.5 * Math.PI) / 180 },
  ];

  for (const c of cases) {
    it(`recovers ${c.name}`, () => {
      const page = syntheticPaper(700, 200, 7);
      const text = 'Calibration 14-09-2023';
      const frame = { cx: 350, cy: 100, width: 600, height: 120, angle: c.angle };
      const truth = defaultParams({ fontId: c.fontId, weight: c.weight, fontSize: 34, originX: 40, baselineY: 75 });
      const box = drawText(page, rasterizer, text, frame, truth);

      const est = analyzeElement(page, element(text, box), rasterizer);
      expect(est).toBeDefined();
      const p = est!.params;
      const effectiveSize = p.fontSize;
      expect(Math.abs(effectiveSize - truth.fontSize) / truth.fontSize).toBeLessThan(0.08);
      expect(est!.category).toBe(c.fontId === 'tinos' ? 'serif' : 'sans');
      expect(est!.fidelity.silhouetteIoU).toBeGreaterThan(0.7);
      // Ink colour within a few levels of the truth.
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(p.color[ch] - truth.color[ch])).toBeLessThan(25);
    });
  }

  it('re-renders its own text nearly identically (self-reconstruction)', () => {
    const page = syntheticPaper(700, 200, 3);
    const text = 'Satisfactory';
    const frame = { cx: 350, cy: 100, width: 600, height: 120, angle: 0.01 };
    const box = drawText(page, rasterizer, text, frame, defaultParams({ originX: 120, baselineY: 75 }));
    const el = element(text, box);
    const typography = analyzeElement(page, el, rasterizer)!;
    const original = cloneRaster(page);
    const out = renderPage(
      original,
      { id: 'p0', index: 0, sourceRef: 's', width: 700, height: 200, skew: 0, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', layout: { lines: [] }, textElements: [{ ...el, typography, state: 'edited', styleOverrides: {} }] },
      rasterizer,
    ).image;
    let err = 0;
    let n = 0;
    for (let y = 60; y < 140; y++) {
      for (let x = 100; x < 400; x++) {
        const o = (y * 700 + x) * 4;
        for (let ch = 0; ch < 3; ch++) err += Math.abs(out.data[o + ch] - original.data[o + ch]);
        n += 3;
      }
    }
    expect(err / n).toBeLessThan(6);
  });
});
