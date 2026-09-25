import { describe, expect, it } from 'vitest';
import type { RenderParams, TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { resolveParams } from '@/core/typography/styleTransfer';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, drawTextFootlessOnes, syntheticPaper } from '../helpers/synthetic';

const r = createNodeRasterizer();

function element(text: string, box: ReturnType<typeof drawText>): TextElement {
  return { id: 'e1', pageId: 'p0', sourceText: text, text, bbox: orientedBoundingRect(box), box, ocrConfidence: 95, readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left' };
}

function fit(text: string, fontId: string, footless: boolean) {
  const page = syntheticPaper(600, 160, 7);
  const frame = { cx: 300, cy: 80, width: 560, height: 120, angle: 0.004 };
  const params = defaultParams({ fontId, fontSize: 30, originX: 40, baselineY: 75 });
  const box = (footless ? drawTextFootlessOnes : drawText)(page, r, text, frame, params);
  return analyzeElement(page, element(text, box), r)!;
}

/** Width of the bottom rows of a rendered "1" relative to its stem: ≈1 without a foot, 3+ with one. */
function footRatio(p: RenderParams): number {
  const size = 80;
  const q = { ...p, fontSize: size, scaleX: 1, letterSpacing: 0, skewX: 0, embolden: 0, originX: 20, baselineY: 110 };
  const W = 120;
  const cov = r.coverage('1', q, W, 130).data;
  const rowWidth = (y: number) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (cov[y * W + x] > 0.5) n++;
    return n;
  };
  let bottom = 129;
  while (bottom > 0 && rowWidth(bottom) === 0) bottom--;
  return Math.max(rowWidth(bottom - 1), rowWidth(bottom - 2)) / rowWidth(Math.round(110 - size * 0.35));
}

describe('glyph variants', () => {
  it('keeps the "1" of an Arial document footless, although Arimo draws one', () => {
    const est = fit('Invoice 17652', 'arimo', true);
    expect(est.params.fontId).toBe('arimo');
    expect(est.params.glyphFonts?.['1']).toBeDefined();
    expect(est.params.glyphFonts!['1']).not.toBe('arimo');
    // Arimo's own "1" has a foot; the rendered replacement must not.
    expect(footRatio({ ...est.params, glyphFonts: undefined })).toBeGreaterThan(2.5);
    expect(footRatio(est.params)).toBeLessThan(1.6);
  });

  it("keeps the font's own glyph when the scan shows it (evidence beats the catalogue default)", () => {
    const est = fit('Invoice 17652', 'arimo', false);
    expect(est.params.fontId).toBe('arimo');
    expect(est.params.glyphFonts?.['1']).toBe('arimo');
    expect(footRatio(est.params)).toBeGreaterThan(2.5);
  });

  it('uses the catalogue default for a "1" that is not in the scanned text', () => {
    const est = fit('Invoice 23465', 'arimo', false);
    expect(est.params.fontId).toBe('arimo');
    expect(est.params.glyphFonts?.['1']).not.toBe('arimo');
    expect(footRatio(est.params)).toBeLessThan(1.6);
  });

  it('does not swap glyphs of a correctly identified font', () => {
    for (const [fontId, text] of [
      ['carlito', '17652'],
      ['roboto', 'Total 1,245.10'],
      ['tinos', 'No. 17652'],
      ['lato', 'Ref 41170'],
    ]) {
      const est = fit(text, fontId, false);
      expect(est.params.fontId).toBe(fontId);
      const swaps = Object.entries(est.params.glyphFonts ?? {}).filter(([, id]) => id !== fontId);
      expect(swaps, `${fontId}: ${JSON.stringify(swaps)}`).toEqual([]);
    }
  });

  it('switching the font resets glyph variants to the new font', () => {
    const est = fit('Invoice 17652', 'arimo', true);
    const switched = resolveParams(est.params, { fontId: 'tinos' }, r);
    expect(switched.glyphFonts).toBeUndefined();
    const back = resolveParams({ ...est.params, fontId: 'tinos', glyphFonts: undefined }, { fontId: 'arimo' }, r);
    expect(back.glyphFonts).toEqual({ '1': 'roboto' });
  });
});
