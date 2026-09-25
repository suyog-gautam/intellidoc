import { describe, expect, it } from 'vitest';
import { runText, segmentWords } from '@/core/layout/segment';
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

describe('text assembly for other writing systems', () => {
  const w = (text: string, x: number, y: number, width: number, height: number) => ({ text, bbox: { x, y, width, height }, confidence: 90, lineKey: '0' });

  it('reads right-to-left runs from the rightmost word', () => {
    expect(runText([w('ضريبية', 0, 0, 60, 20), w('فاتورة', 70, 0, 60, 20)])).toBe('فاتورة ضريبية');
    expect(runText([w('17652', 0, 0, 50, 20), w('الفاتورة', 60, 0, 60, 20), w('رقم', 130, 0, 30, 20)])).toBe('رقم الفاتورة 17652');
    expect(runText([w('Invoice', 0, 0, 60, 20), w('17652', 70, 0, 50, 20)])).toBe('Invoice 17652');
  });

  it('joins Chinese, Japanese and Thai without spaces', () => {
    expect(runText([w('开票', 0, 0, 40, 20), w('日期', 45, 0, 40, 20), w('2024', 90, 0, 40, 20), w('年', 132, 0, 20, 20), w('9', 154, 0, 10, 20), w('月', 166, 0, 20, 20)])).toBe('开票日期2024年9月');
    expect(runText([w('ใบแจ้งหนี้', 0, 0, 80, 20), w('เลขที่', 90, 0, 40, 20)])).toBe('ใบแจ้งหนี้เลขที่');
    expect(runText([w('세금', 0, 0, 40, 20), w('계산서', 50, 0, 60, 20)])).toBe('세금 계산서');
  });

  it('keeps nested and tightly packed CJK boxes on one line', () => {
    // Tesseract boxes as measured on a synthetic VAT invoice: "增值" spans the whole heading and contains "税".
    const heading = segmentWords([w('增值', 82, 69, 332, 46), w('税', 203, 65, 48, 69), w('专用', 250, 69, 92, 46), w('发', 341, 65, 52, 69), w('票', 392, 65, 27, 69)]);
    expect(heading.map((l) => l.runs.map((r) => r.text).join('|'))).toEqual(['增值税专用发票']);
    const date = segmentWords([w('2024', 242, 318, 173, 35), w('年', 326, 318, 56, 35), w('9', 374, 314, 26, 50), w('月', 386, 320, 29, 33), w('14', 425, 322, 38, 28), w('日', 471, 321, 25, 32)]);
    expect(date.map((l) => l.runs.map((r) => r.text).join('|'))).toEqual(['2024年9月14日']);
  });
});
