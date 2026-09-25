import { describe, expect, it } from 'vitest';
import type { Page, TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import type { RasterImage } from '@/core/image/raster';
import { mergeRecovered, type RecoveryCropMeta } from '@/core/ocr/recovery';
import type { OcrResult } from '@/core/ocr/types';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { getFont } from '@/core/typography/fontCatalog';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const r = createNodeRasterizer();
const W = 700;
const H = 160;

function element(text: string, box: ReturnType<typeof drawText>): TextElement {
  return { id: 'e1', pageId: 'p0', sourceText: text, text, bbox: orientedBoundingRect(box), box, ocrConfidence: 90, readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left' };
}

function page(el: TextElement): Page {
  return { id: 'p0', index: 0, sourceRef: 'p0', width: W, height: H, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', skew: 0, textElements: [el], layout: { lines: [] } };
}

/** Strongest darkening of any row inside `el`'s box, versus the clean paper. */
function residue(out: RasterImage, clean: RasterImage, el: TextElement): number {
  const b = el.bbox;
  let worst = 0;
  for (let y = Math.floor(b.y); y < b.y + b.height; y++) {
    let sum = 0;
    let n = 0;
    for (let x = Math.floor(b.x); x < b.x + b.width; x++, n++) sum += clean.data[(y * W + x) * 4] - out.data[(y * W + x) * 4];
    worst = Math.max(worst, sum / n);
  }
  return worst;
}

describe('Devanagari (Nepali, Hindi)', () => {
  const cases = [
    { name: 'Nepali, humanist sans', fontId: 'mukta', text: 'नेपाल सरकार' },
    { name: 'Nepali date, serif, Devanagari digits', fontId: 'noto-serif-devanagari', text: 'मिति २०८१/०५/१२' },
    { name: 'Hindi with Latin digits', fontId: 'hind', text: 'कुल रकम रु. 17652' },
  ];
  for (const c of cases) {
    it(`fits ${c.name} with a Devanagari font and no tracking`, () => {
      const paper = syntheticPaper(W, H, 7);
      const truth = defaultParams({ fontId: c.fontId, fontSize: 34, originX: 40, baselineY: 75 });
      const box = drawText(paper, r, c.text, { cx: W / 2, cy: H / 2, width: 660, height: 120, angle: 0.006 }, truth);
      const est = analyzeElement(paper, element(c.text, box), r, { contextScripts: ['devanagari', 'latin'] })!;
      expect(est).toBeDefined();
      expect(est.params.fontId).toBe(c.fontId);
      expect(getFont(est.params.fontId).subsets).toContain('devanagari');
      // Tracking would cut the headline.
      expect(est.params.letterSpacing).toBe(0);
      expect(est.fidelity.silhouetteIoU).toBeGreaterThan(0.7);
      expect(Math.abs(est.params.fontSize - truth.fontSize) / truth.fontSize).toBeLessThan(0.08);
    });
  }

  it('removes the headline together with the letters (no ghost line left behind)', () => {
    const paper = syntheticPaper(W, H, 7);
    const clean = syntheticPaper(W, H, 7);
    const text = 'नेपालमा सरकारको';
    const box = drawText(paper, r, text, { cx: W / 2, cy: H / 2, width: 660, height: 120, angle: 0 }, defaultParams({ fontId: 'mukta', fontSize: 40, originX: 40, baselineY: 75 }));
    const el = element(text, box);
    const deleted: TextElement = { ...el, text: '', state: 'deleted', typography: analyzeElement(paper, el, r)! };
    const out = renderPage(paper, page(deleted), r).image;
    // Measured: 0.2 with headline detection, 25.7 when the headline is mistaken for a table rule.
    expect(residue(out, clean, deleted)).toBeLessThan(3);
  });

  it('renders an edit with conjuncts shaped, in the fitted font', () => {
    const paper = syntheticPaper(W, H, 7);
    const text = 'नेपाल सरकार';
    const box = drawText(paper, r, text, { cx: W / 2, cy: H / 2, width: 660, height: 120, angle: 0 }, defaultParams({ fontId: 'mukta', fontSize: 34, originX: 40, baselineY: 75 }));
    const el = element(text, box);
    const typography = analyzeElement(paper, el, r)!;
    const out = renderPage(paper, page({ ...el, text: 'नेपाल राष्ट्र', state: 'edited', typography }), r);
    expect(out.pending).toEqual([]);
    expect(out.overflowing).toEqual([]);
    // Same ink in the unchanged first word; new ink where the second word changed.
    let changed = 0;
    for (let i = 0; i < out.image.data.length; i += 4) if (Math.abs(out.image.data[i] - paper.data[i]) > 40) changed++;
    expect(changed).toBeGreaterThan(200);
  });

  it('OCR recovery keeps Devanagari words (vowel signs are marks, not noise)', () => {
    const ocr: OcrResult = { engine: 't', languages: ['nep'], confidence: 80, words: [{ text: 'नमस्ते', bbox: { x: 10, y: 10, width: 90, height: 30 }, confidence: 0, lineKey: '0' }] };
    const meta: RecoveryCropMeta = { region: { kind: 'reread', rect: { x: 10, y: 10, width: 90, height: 30 }, wordIndices: [0] }, originX: 10, originY: 10, scale: 1, border: 0 };
    const merged = mergeRecovered(ocr, [meta], [{ ...ocr, words: [{ text: 'स्ते', bbox: { x: 0, y: 0, width: 50, height: 30 }, confidence: 92, lineKey: '0' }] }]);
    expect(merged.words.map((w) => w.text)).toContain('स्ते');
  });
});

describe('handwriting', () => {
  it('fits handwriting with a handwriting font and natural variation; print gets none', () => {
    for (const [fontId, jitter] of [
      ['caveat', 0.8],
      ['arimo', 0],
    ] as const) {
      const paper = syntheticPaper(W, H, 9);
      const text = 'Paid Rs 4250 cash';
      const box = drawText(paper, r, text, { cx: W / 2, cy: H / 2, width: 660, height: 120, angle: 0.01 }, defaultParams({ fontId, fontSize: 40, originX: 40, baselineY: 75, jitter, color: [30, 40, 120] }));
      const est = analyzeElement(paper, element(text, box), r)!;
      if (jitter) {
        expect(getFont(est.params.fontId).category).toBe('handwriting');
        expect(est.params.jitter).toBeGreaterThan(0.4);
        // Blue ballpoint ink is kept.
        expect(est.params.color[2]).toBeGreaterThan(est.params.color[0] + 40);
      } else {
        expect(est.params.fontId).toBe('arimo');
        expect(est.params.jitter).toBeUndefined();
      }
    }
  });

  it('natural variation is deterministic and local to each character', () => {
    const p = defaultParams({ fontId: 'caveat', fontSize: 40, originX: 20, baselineY: 70, jitter: 0.7 });
    const a = r.coverage('4250', p, 200, 100).data.slice();
    const b = r.coverage('4250', p, 200, 100).data.slice();
    expect(a).toEqual(b);
    // Changing the last digit leaves the first ones exactly where they were.
    const c = r.coverage('4258', p, 200, 100).data;
    const firstCell = Math.floor(20 + r.measure('42', p));
    let diff = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < firstCell - 4; x++) diff += Math.abs(a[y * 200 + x] - c[y * 200 + x]);
    expect(diff).toBe(0);
  });
});
