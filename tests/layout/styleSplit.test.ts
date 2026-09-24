import { describe, expect, it } from 'vitest';
import type { OcrWord } from '@/core/ocr/types';
import { segmentWords } from '@/core/layout/segment';
import { measureWordStyles } from '@/core/layout/wordStyle';
import { estimateTextHeight } from '@/core/vision/preprocess';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { defaultParams, drawText, syntheticPaper } from '../helpers/synthetic';

const word = (text: string, x: number, y: number, width: number, height: number): OcrWord => ({ text, bbox: { x, y, width, height }, confidence: 95, lineKey: '0' });
const runsOf = (lines: ReturnType<typeof segmentWords>) => lines.flatMap((l) => l.runs.map((r) => r.text));

describe('style-aware run splitting', () => {
  it('keeps table header cells whole when OCR boxes swallow the rule above them', () => {
    const r = createNodeRasterizer();
    const W = 900;
    const page = syntheticPaper(W, 200, 9);
    const frame = { cx: W / 2, cy: 100, width: W, height: 200, angle: 0 };
    const words: OcrWord[] = [];
    let x = 30;
    for (const t of ['Suggested', 'Due', 'Date', 'of', 'Calibration']) {
      const params = defaultParams({ fontSize: 24, weight: 700, originX: x, baselineY: 110 });
      drawText(page, r, t, frame, params);
      const adv = r.measure(t, params);
      // Like Tesseract on real scans: the first word's box includes the table rule 12 px above.
      words.push(word(t, x, t === 'Suggested' ? 78 : 92, adv, t === 'Suggested' ? 38 : 22));
      x += adv + r.measure(' ', params);
    }
    for (let xx = 10; xx < W - 10; xx++) for (let t = 0; t < 2; t++) {
      const o = ((80 + t) * W + xx) * 4;
      page.data[o] = page.data[o + 1] = page.data[o + 2] = 60;
    }
    const styled = measureWordStyles(page, words, estimateTextHeight(page) || 18);
    expect(runsOf(segmentWords(styled))).toEqual(['Suggested Due Date of Calibration']);
  });

  for (const size of [34, 12]) {
    it(`splits bold/regular but keeps uniform lines whole (${size}px text)`, () => {
      const r = createNodeRasterizer();
      const W = Math.round(size * 30);
      const lineH = Math.round(size * 2.2);
      const page = syntheticPaper(W, lineH * 6, 5);
      const words: OcrWord[] = [];
      const addLine = (row: number, parts: Array<{ text: string; weight: number }>) => {
        let x = size;
        for (const part of parts) {
          for (const t of part.text.split(' ')) {
            const params = defaultParams({ fontSize: size, weight: part.weight, originX: x, baselineY: row * lineH + size * 1.3, blur: size < 20 ? 0.5 : 0.8 });
            const full = { cx: W / 2, cy: (lineH * 6) / 2, width: W, height: lineH * 6, angle: 0 };
            drawText(page, r, t, full, params);
            const adv = r.measure(t, params);
            words.push(word(t, x, row * lineH + size * 1.3 - size * 0.75, adv, size * 0.95));
            x += adv + r.measure(' ', params);
          }
        }
      };
      addLine(0, [{ text: 'Certificate No.', weight: 700 }, { text: 'SCS/000000/001', weight: 400 }]);
      addLine(1, [{ text: 'NAME AND ADDRESS OF CUSTOMER', weight: 700 }]);
      addLine(2, [{ text: 'The above readings are average of five sets', weight: 400 }]);
      addLine(3, [{ text: 'Temperature Sensor with Indicator', weight: 400 }]);
      addLine(4, [{ text: 'DETAILS OF REFERENCE STANDARD', weight: 700 }]);
      const styled = measureWordStyles(page, words, estimateTextHeight(page));
      const runs = runsOf(segmentWords(styled));
      expect(runs).toEqual([
        'Certificate No.',
        'SCS/000000/001',
        'NAME AND ADDRESS OF CUSTOMER',
        'The above readings are average of five sets',
        'Temperature Sensor with Indicator',
        'DETAILS OF REFERENCE STANDARD',
      ]);
    });
  }
});
