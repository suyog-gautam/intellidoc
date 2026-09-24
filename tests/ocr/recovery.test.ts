import { describe, expect, it } from 'vitest';
import { cropForLineOcr, findRecoveryRegions, mergeRecovered, type RecoveryCropMeta } from '@/core/ocr/recovery';
import type { OcrResult, OcrWord } from '@/core/ocr/types';
import { normalizeIllumination } from '@/core/vision/preprocess';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const word = (text: string, x: number, y: number, width: number, height: number, confidence = 95): OcrWord => ({
  text,
  bbox: { x, y, width, height },
  confidence,
  lineKey: '0',
});
const result = (words: OcrWord[]): OcrResult => ({ engine: 't', languages: ['eng'], confidence: 90, words });

/** A page with a 2-cell table: "Valid up to" header (OCR'd) and a date value (missed by OCR). */
function tablePage() {
  const r = createNodeRasterizer();
  const page = syntheticPaper(900, 300, 3);
  const frame = { cx: 450, cy: 150, width: 900, height: 300, angle: 0 };
  drawText(page, r, 'Valid up to', frame, defaultParams({ fontSize: 30, weight: 700, originX: 330, baselineY: 90 }));
  drawText(page, r, '12-03-2024', frame, defaultParams({ fontSize: 30, originX: 320, baselineY: 190 }));
  // Table rules: cell borders around both rows.
  const ink = (x: number, y: number) => {
    const o = (y * 900 + x) * 4;
    page.data[o] = page.data[o + 1] = page.data[o + 2] = 60;
  };
  for (const y of [40, 130, 230]) for (let x = 280; x < 620; x++) for (let t = 0; t < 3; t++) ink(x, y + t);
  for (const x of [280, 617]) for (let y = 40; y < 233; y++) for (let t = 0; t < 3; t++) ink(x + t, y);
  return page;
}

describe('OCR recovery', () => {
  it('finds text in a table cell that the page OCR missed, but not the table rules', () => {
    const page = tablePage();
    const ocr = result([word('Valid', 330, 68, 70, 23), word('up', 408, 72, 30, 26), word('to', 445, 69, 25, 22)]);
    const regions = findRecoveryRegions(page, ocr, 22);
    const missed = regions.filter((r) => r.kind === 'missed');
    expect(missed).toHaveLength(1);
    const r = missed[0].rect;
    // Covers the date (x 320..~470, baseline 190), nothing else.
    expect(r.x).toBeGreaterThan(300);
    expect(r.x + r.width).toBeLessThan(500);
    expect(r.y).toBeGreaterThan(150);
    expect(r.y + r.height).toBeLessThan(200);
  });

  it('re-reads low-confidence words and erases rules from the crop', () => {
    const page = tablePage();
    const ocr = result([word('Valid', 330, 68, 70, 23), word('12-Da-20es', 320, 168, 150, 23, 0)]);
    const regions = findRecoveryRegions(page, ocr, 22);
    const reread = regions.find((r) => r.kind === 'reread');
    expect(reread?.wordIndices).toEqual([1]);
    const crop = cropForLineOcr(page, normalizeIllumination(page), reread!, 22);
    // Crop is enlarged and padded with white.
    expect(crop.scale).toBeGreaterThanOrEqual(1);
    expect(crop.image.data[0]).toBe(255);
  });

  it('merges only credible improvements', () => {
    const ocr = result([word('Valid', 330, 68, 70, 23), word('12-Da-20es', 320, 168, 150, 23, 0), word('gc', 700, 250, 20, 20, 0)]);
    const meta = (kind: 'reread' | 'missed', idx: number[], x: number, y: number, w: number, h: number): RecoveryCropMeta => ({
      region: { kind, rect: { x, y, width: w, height: h }, wordIndices: idx },
      originX: x,
      originY: y,
      scale: 1,
      border: 0,
    });
    const crops = [
      meta('reread', [1], 320, 168, 150, 23), // garbled date
      meta('reread', [2], 700, 250, 20, 20), // signature squiggle
      meta('missed', [], 600, 10, 200, 30), // uncovered ink
    ];
    const merged = mergeRecovered(ocr, crops, [
      // Crop coordinates (scale 1, border 0 => offset by origin). Context word "Valid" slipped in and must be ignored.
      result([word('12-03-2024', 0, 0, 150, 23, 95), word('Valid', 10, -100, 70, 23, 96)]),
      result([word('B', 0, 0, 20, 20, 66)]),
      result([word('Druck', 0, 0, 80, 25, 96), word('f=', 100, 0, 20, 25, 77)]),
    ]);
    const texts = merged.words.map((w) => w.text);
    expect(texts).toContain('12-03-2024');
    expect(texts).not.toContain('12-Da-20es');
    expect(texts.filter((t) => t === 'Valid')).toHaveLength(1);
    expect(texts).toContain('gc'); // "B" is not credible enough to replace it
    expect(texts).not.toContain('B');
    expect(texts).toContain('Druck');
    expect(texts).not.toContain('f=');
    const date = merged.words.find((w) => w.text === '12-03-2024')!;
    expect(date.bbox).toMatchObject({ x: 320, y: 168 });
  });
});
