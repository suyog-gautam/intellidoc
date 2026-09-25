import { describe, expect, it } from 'vitest';
import type { Page, TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { planEdit } from '@/core/rendering/partialEdit';
import { layoutReplacement } from '@/core/typography/layoutReplacement';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const r = createNodeRasterizer();
const W = 700;
const H = 160;

function setup(text: string, fontId = 'arimo') {
  const paper = syntheticPaper(W, H, 7);
  const box = drawText(paper, r, text, { cx: W / 2, cy: H / 2, width: 660, height: 120, angle: 0 }, defaultParams({ fontId, fontSize: 34, originX: 40, baselineY: 75 }), { inkBox: true });
  const el: TextElement = { id: 'e1', pageId: 'p0', sourceText: text, text, bbox: orientedBoundingRect(box), box, ocrConfidence: 95, readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left' };
  return { paper, el: { ...el, typography: analyzeElement(paper, el, r)! } };
}

const page = (el: TextElement): Page => ({ id: 'p0', index: 0, sourceRef: 'p0', width: W, height: H, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', skew: 0, textElements: [el], layout: { lines: [] } });

function plan(el: TextElement, next: string) {
  const e = { ...el, text: next, state: 'edited' as const };
  return planEdit(e, layoutReplacement(e.typography!, e.sourceText, e.text, e.alignment, r, e.styleOverrides), r);
}

/** Columns of the page that differ from the original. */
function changedColumns(a: Uint8ClampedArray, b: Uint8ClampedArray): [number, number] {
  let x0 = W;
  let x1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(a[(y * W + x) * 4] - b[(y * W + x) * 4]) > 12) [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
  return [x0, x1];
}

describe('minimal edits: unchanged characters keep the scan', () => {
  it('changes only the digit that changed ("17652" → "17653")', () => {
    const { paper, el } = setup('Invoice 17652');
    const p = plan(el, 'Invoice 17653');
    expect(p.text).toBe('3');
    const out = renderPage(paper, page({ ...el, text: 'Invoice 17653', state: 'edited' }), r).image;
    const [x0] = changedColumns(paper.data, out.data);
    // Everything left of the last digit is untouched scan.
    const lastDigitX = el.typography!.params.originX + r.measure('Invoice 1765', el.typography!.params);
    expect(x0).toBeGreaterThan(el.typography!.frame.cx - el.typography!.frame.width / 2 + lastDigitX - 6);
  });

  it('keeps a matching suffix in place when the changed part has the same width', () => {
    const { el } = setup('Total 4250.00');
    const p = plan(el, 'Total 4380.00');
    expect(p.text).toBe('38');
    expect(Number.isFinite(p.erase![0]) && Number.isFinite(p.erase![1])).toBe(true);
  });

  it('cuts Devanagari between digits and words, never inside a headline word', () => {
    const { el } = setup('मिति २०८०-०३-०१', 'mukta');
    expect(plan(el, 'मिति २०८१-०४-१५').text).toBe('१-०४-१५');
    const name = setup('अजय कुमार पाण्डेय', 'mukta').el;
    expect(plan(name, 'अजय कुमार शर्मा').text).toBe('शर्मा');
    // Changing a vowel sign inside a word re-renders the whole word.
    expect(plan(name, 'अजय कुमारी पाण्डेय').text).toBe('कुमारी पाण्डेय');
  });

  it('re-renders everything when the style changes or the text moves', () => {
    const { el } = setup('Invoice 17652');
    const styled = { ...el, styleOverrides: { fontId: 'tinos' } };
    expect(plan(styled, 'Invoice 17653').erase).toBeUndefined();
    const right = { ...el, alignment: 'right' as const };
    // Right-aligned and longer: the prefix moves, so only the suffix could stay; here nothing is common at the end.
    expect(plan(right, 'Invoice 176520').erase).toBeUndefined();
  });
});
