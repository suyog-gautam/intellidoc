import { describe, expect, it } from 'vitest';
import type { Page, TextElement } from '@/core/document/model';
import { orientedBoundingRect } from '@/core/geometry';
import { cjkRegionsOfLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import { analyzeElement } from '@/core/pipeline/analyzeElement';
import { renderPage } from '@/core/rendering/pageRenderer';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const r = createNodeRasterizer();
const W = 800;
const H = 140;

function setup(fontId: string, text: string, langs: string[]) {
  const paper = syntheticPaper(W, H, 7);
  // Ink-based boxes, as Tesseract reports them (Nastaliq and stacked marks aren't Latin-shaped).
  const box = drawText(paper, r, text, { cx: W / 2, cy: H / 2, width: 760, height: 120, angle: 0.004 }, defaultParams({ fontId, fontSize: 34, originX: 40, baselineY: 75 }), { inkBox: true });
  const el: TextElement = { id: 'e1', pageId: 'p0', sourceText: text, text, bbox: orientedBoundingRect(box), box, ocrConfidence: 90, readingOrder: 0, lineId: 'l0', words: [], state: 'original', alignment: 'left' };
  const est = analyzeElement(paper, el, r, { contextScripts: scriptsOfLanguages(langs), cjkRegions: cjkRegionsOfLanguages(langs) })!;
  return { paper, el, est };
}

function page(el: TextElement): Page {
  return { id: 'p0', index: 0, sourceRef: 'p0', width: W, height: H, physical: { widthPt: 0, heightPt: 0 }, status: 'ready', skew: 0, textElements: [el], layout: { lines: [] } };
}

describe('the most spoken languages: font identification and edits', () => {
  // Measured (synthetic, 34 px): all exact, silhouette IoU 0.65–0.89.
  const cases: [string, string, string, string, string[]][] = [
    ['Arabic (RTL, joined)', 'noto-naskh-arabic', 'فاتورة رقم 17652', 'فاتورة رقم 17653', ['ara', 'eng']],
    ['Urdu (Nastaliq)', 'noto-nastaliq-urdu', 'کل رقم روپے', 'کل رقم ڈالر', ['urd', 'eng']],
    ['Chinese', 'noto-sans-sc', '发票号码 17652', '发票号码 17653', ['chi_sim', 'eng']],
    ['Japanese', 'noto-sans-jp', '請求書番号のお知らせ', '領収書番号のお知らせ', ['jpn', 'eng']],
    ['Thai', 'sarabun', 'ใบแจ้งหนี้ เลขที่ 17652', 'ใบเสร็จ เลขที่ 17653', ['tha', 'eng']],
    ['Bengali', 'hind-siliguri', 'চালান নম্বর ১৭৬৫২', 'চালান নম্বর ১৭৬৫৩', ['ben', 'eng']],
    ['Tamil', 'noto-sans-tamil', 'விலைப்பட்டியல் எண்', 'ரசீது எண்', ['tam', 'eng']],
    ['Hebrew (RTL)', 'frank-ruhl-libre', 'חשבונית מספר 17652', 'קבלה מספר 17653', ['heb', 'eng']],
  ];
  for (const [name, fontId, text, next, langs] of cases) {
    it(`${name}: finds ${fontId} and renders an edit`, () => {
      const { paper, el, est } = setup(fontId, text, langs);
      expect(est.params.fontId).toBe(fontId);
      expect(est.fidelity.silhouetteIoU).toBeGreaterThan(0.6);
      expect(Math.abs(est.params.fontSize - 34) / 34).toBeLessThan(0.1);
      const out = renderPage(paper, page({ ...el, text: next, state: 'edited', typography: est }), r);
      expect(out.pending).toEqual([]);
      let changed = 0;
      for (let i = 0; i < out.image.data.length; i += 4) if (Math.abs(out.image.data[i] - paper.data[i]) > 40) changed++;
      expect(changed).toBeGreaterThan(50);
    });
  }

  it('removes faint hairlines of high-contrast CJK serif glyphs with the text', () => {
    const { paper, el, est } = setup('noto-serif-sc', '中华人民共和国', ['chi_sim']);
    const clean = syntheticPaper(W, H, 7);
    const out = renderPage(paper, page({ ...el, text: '', state: 'deleted', typography: est }), r).image;
    let worst = 0;
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = 20; y < 120; y++) s += Math.max(0, clean.data[(y * W + x) * 4] - out.data[(y * W + x) * 4]);
      worst = Math.max(worst, s / 100);
    }
    // Measured: 1.3 with faint-stroke removal, 4.5 without (hairlines of 国 left behind).
    expect(worst).toBeLessThan(2.5);
  });
});
