import { describe, expect, it } from 'vitest';
import { createAddedElement } from '@/core/document/addedText';
import { applyCommand, createHistory, execute, undo } from '@/core/document/history';
import type { Page, TextElement } from '@/core/document/model';
import { elementIsModified } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { cloneRaster } from '@/core/image/raster';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { resolveParams } from '@/core/typography/styleTransfer';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const rasterizer = createNodeRasterizer();

function setup() {
  const page = syntheticPaper(900, 360, 4);
  const frame = { cx: 450, cy: 180, width: 900, height: 360, angle: 0 };
  const box = drawText(page, rasterizer, 'Heading Text', frame, defaultParams({ fontSize: 40, weight: 700, color: [20, 60, 140], originX: 60, baselineY: 90 }));
  const el: TextElement = {
    id: 'h1', pageId: 'p0', sourceText: 'Heading Text', text: 'Heading Text', bbox: orientedBoundingRect(box), box, ocrConfidence: 95,
    readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left',
  };
  el.typography = analyzeElement(page, el, rasterizer);
  const pageModel: Page = { id: 'p0', index: 0, sourceRef: 's', width: 900, height: 360, skew: 0, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', layout: { lines: [] }, textElements: [el] };
  const doc = { schemaVersion: 1, id: 'd', source: { fileName: 'x', mimeType: 'image/png', byteSize: 1, sha256: '0', kind: 'image' as const, pageCount: 1 }, processing: { pipelineVersion: 't', ocrEngine: 't', ocrLanguages: [], createdAt: '' }, pages: [pageModel] };
  return { page, el, doc };
}

describe('user text boxes and style transfer', () => {
  it('adds a text box that copies the source style and only paints new ink', () => {
    const { page, el, doc } = setup();
    const added = createAddedElement({ id: 'a1', pageId: 'p0', at: { x: 80, y: 260 }, text: 'Added line', source: { id: el.id, typography: el.typography! } });
    const next = applyCommand(doc, { type: 'addElement', pageId: 'p0', element: added });
    expect(elementIsModified(next.pages[0].textElements[1])).toBe(true);
    const before = cloneRaster(page);
    const out = renderPage(page, next.pages[0], rasterizer).image;
    // The original heading is untouched (nothing removed).
    let diffHeading = 0;
    for (let y = 40; y < 110; y++) for (let x = 40; x < 500; x++) diffHeading += Math.abs(out.data[(y * 900 + x) * 4] - before.data[(y * 900 + x) * 4]);
    expect(diffHeading).toBe(0);
    // New ink appears near the click point, in the heading's blue.
    let bluish = 0;
    for (let y = 225; y < 265; y++) for (let x = 80; x < 400; x++) {
      const o = (y * 900 + x) * 4;
      if (out.data[o + 2] - out.data[o] > 50) bluish++;
    }
    expect(bluish).toBeGreaterThan(200);
  });

  it('moves added boxes and undoes the move', () => {
    const { el, doc } = setup();
    const added = createAddedElement({ id: 'a1', pageId: 'p0', at: { x: 80, y: 260 }, text: 'x', source: { id: el.id, typography: el.typography! } });
    let h = createHistory(applyCommand(doc, { type: 'addElement', pageId: 'p0', element: added }));
    const cx = h.present.pages[0].textElements[1].typography!.frame.cx;
    h = execute(h, { type: 'moveElement', elementId: 'a1', dx: 25, dy: -10 });
    expect(h.present.pages[0].textElements[1].typography!.frame.cx).toBeCloseTo(cx + 25);
    h = undo(h);
    expect(h.present.pages[0].textElements[1].typography!.frame.cx).toBeCloseTo(cx);
    expect(() => applyCommand(h.present, { type: 'moveElement', elementId: 'h1', dx: 1, dy: 1 })).toThrow();
  });

  it('applies a chosen colour and font; switching font keeps the cap height', () => {
    const { el, doc } = setup();
    const next = applyCommand(doc, { type: 'applyStyle', elementId: 'h1', style: { color: [200, 0, 0], fontId: 'tinos', weight: 400 } });
    const e = next.pages[0].textElements[0];
    expect(e.state).toBe('edited');
    expect(elementIsModified(e)).toBe(true);
    const p = resolveParams(el.typography!.params, e.styleOverrides, rasterizer);
    expect(p.color).toEqual([200, 0, 0]);
    expect(p.fontId).toBe('tinos');
    // Tinos caps are smaller per em than Arimo's, so the size grows to compensate.
    expect(p.fontSize).toBeGreaterThan(el.typography!.params.fontSize);
    expect(p.scaleX).toBe(1);
  });
});

describe('larger user-chosen sizes', () => {
  it('renders the full glyph height when the size grows beyond the original frame', () => {
    const { page, el, doc } = setup();
    const added = createAddedElement({ id: 'a1', pageId: 'p0', at: { x: 80, y: 300 }, text: 'BIG', source: { id: el.id, typography: el.typography! } });
    let next = applyCommand(doc, { type: 'addElement', pageId: 'p0', element: added });
    next = applyCommand(next, { type: 'applyStyle', elementId: 'a1', style: { fontSize: 160 } });
    const out = renderPage(page, next.pages[0], rasterizer).image;
    // Cap height of 160px Arimo is ~115px: ink must reach well above the original ~60px frame.
    let topInk = 360;
    for (let y = 0; y < 300; y++) for (let x = 80; x < 400; x++) {
      const o = (y * 900 + x) * 4;
      if (out.data[o + 2] - out.data[o] > 50 && y < topInk) topInk = y;
    }
    expect(300 - topInk).toBeGreaterThan(100);
  });
});
