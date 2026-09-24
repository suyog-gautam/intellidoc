import { describe, expect, it } from 'vitest';
import { segmentWords } from '@/core/layout/segment';
import type { OcrWord } from '@/core/ocr/types';

function word(text: string, x: number, y: number, w: number, h = 24, confidence = 95): OcrWord {
  return { text, bbox: { x, y, width: w, height: h }, confidence, lineKey: '0' };
}

describe('layout segmentation', () => {
  it('splits a form line into label, colon and value runs', () => {
    const lines = segmentWords([
      word('1.0', 10, 100, 40),
      word('NAME', 120, 100, 70),
      word('OF', 200, 100, 30),
      word('CUSTOMER', 240, 100, 140),
      word(':', 600, 100, 8),
      word('ACME', 700, 100, 130),
      word('PIPE', 840, 100, 60),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].runs.map((r) => r.text)).toEqual(['1.0', 'NAME OF CUSTOMER', ':', 'ACME PIPE']);
  });

  it('follows a skewed baseline and separates stacked lines', () => {
    const words = [word('alpha', 0, 100, 80), word('beta', 90, 104, 80), word('gamma', 180, 108, 80), word('below', 0, 160, 80)];
    const lines = segmentWords(words);
    expect(lines.map((l) => l.runs.map((r) => r.text).join('|'))).toEqual(['alpha beta gamma', 'below']);
  });

  it('drops table borders read as pipes and punctuation noise', () => {
    const lines = segmentWords([word('|', 0, 100, 4, 40, 90), word('Date', 30, 100, 60), word('~~', 300, 100, 20, 10, 20)]);
    expect(lines.flatMap((l) => l.runs.map((r) => r.text))).toEqual(['Date']);
  });
});
