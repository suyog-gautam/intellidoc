import { describe, expect, it } from 'vitest';
import { createHistory, execute, replacePresent } from '@/core/document/history';
import { acceptReading, applyHandwritingReadings, plausibleReading } from '@/core/ocr/handwritingReadings';
import { buildDocument } from '@/core/pipeline/buildDocument';
import type { OcrWord } from '@/core/ocr/types';
import { detokenize } from '@/lib/ocr/trocr';

function word(text: string, x: number, y: number, w: number, confidence: number, lineKey: string): OcrWord {
  return { text, bbox: { x, y, width: w, height: 30 }, confidence, lineKey };
}

/** A printed label and a handwritten entry Tesseract broke into fragments. */
function doc() {
  return buildDocument({ fileName: 'a.png', mimeType: 'image/png', byteSize: 1, sha256: 'ab'.repeat(32), kind: 'image', pageCount: 1 }, [
    {
      sourceRef: 'p',
      physical: { widthPt: 240, heightPt: 120 },
      width: 1000,
      height: 500,
      skew: 0,
      ocr: { engine: 't', languages: ['eng'], confidence: 60, words: [word('Name:', 10, 10, 80, 95, '0'), word('Va', 100, 100, 40, 30, '1'), word('m', 200, 100, 30, 20, '1')] },
    },
  ]);
}

const line = { x: 90, y: 90, width: 300, height: 50 };

function handwrittenIds(d: ReturnType<typeof doc>) {
  return d.pages[0].textElements.filter((e) => e.bbox.y >= 90).map((e) => e.id);
}

describe('handwriting readings', () => {
  it('rejects hallucinations: repeated words, one repeated letter, too many characters', () => {
    expect(plausibleReading('000 000 000', line)).toBe(false);
    expect(plausibleReading('mmmm', line)).toBe(false);
    expect(plausibleReading('x'.repeat(10) + 'y'.repeat(10), { x: 0, y: 0, width: 50, height: 50 })).toBe(false);
    expect(plausibleReading('Rival Bag House', line)).toBe(true);
  });

  it('accepts numbers at lower confidence than words, and short words only when sure', () => {
    expect(acceptReading({ text: '90001', confidence: 0.3 }, line)).toBe(true);
    expect(acceptReading({ text: '7', confidence: 0.5 }, line)).toBe(false);
    expect(acceptReading({ text: 'Gas', confidence: 0.5 }, line)).toBe(false);
    expect(acceptReading({ text: 'er', confidence: 0.9 }, line)).toBe(false);
    expect(acceptReading({ text: 'Rival Bag House', confidence: 0.5 }, line)).toBe(true);
    expect(acceptReading({ text: 'Rival Bag House', confidence: 0.3 }, line)).toBe(false);
  });

  it('replaces the fragments of a line with one element holding the reading', () => {
    const d = doc();
    const ids = handwrittenIds(d);
    expect(ids.length).toBeGreaterThan(0);
    const out = applyHandwritingReadings(d.pages[0], [{ elementIds: ids, rect: line }], [{ text: 'Rival Bag House', confidence: 0.9 }], 0, 'p0');
    const read = out.textElements.filter((e) => e.recognizer === 'handwriting');
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ text: 'Rival Bag House', sourceText: 'Rival Bag House', state: 'original', ocrConfidence: 75 });
    expect(out.textElements.find((e) => e.sourceText === 'Name:')).toBeDefined();
    expect(out.layout.lines.flatMap((l) => l.elementIds).filter((id) => ids.includes(id))).toEqual([ids[0]]);
  });

  it('adds text the page OCR missed as a new element and line', () => {
    const d = doc();
    const out = applyHandwritingReadings(d.pages[0], [{ elementIds: [], rect: { x: 100, y: 300, width: 200, height: 40 } }], [{ text: '208310610', confidence: 0.7 }], 0, 'p0');
    const added = out.textElements.find((e) => e.text === '208310610')!;
    expect(added).toMatchObject({ id: 'p0-hw100-300', recognizer: 'handwriting' });
    expect(out.layout.lines.some((l) => l.elementIds.includes(added.id))).toBe(true);
  });

  it('never replaces text the page OCR read in another script (the model reads English)', () => {
    const d = doc();
    const id = handwrittenIds(d)[0];
    const page = { ...d.pages[0], textElements: d.pages[0].textElements.map((e) => (e.id === id ? { ...e, sourceText: 'नेपाल' } : e)) };
    const out = applyHandwritingReadings(page, [{ elementIds: [id], rect: line }], [{ text: 'Rival Bag House', confidence: 0.9 }], 0, 'p0');
    expect(out).toBe(page);
  });

  it('does not add a missed line where another element already has text', () => {
    const d = doc();
    const out = applyHandwritingReadings(d.pages[0], [{ elementIds: [], rect: { x: 0, y: 0, width: 100, height: 50 } }], [{ text: 'Name here', confidence: 0.9 }], 0, 'p0');
    expect(out).toBe(d.pages[0]);
  });

  it('never overwrites text the page OCR read confidently', () => {
    const d = doc();
    const printed = d.pages[0].textElements.find((e) => e.sourceText === 'Name:')!;
    const page = { ...d.pages[0], textElements: d.pages[0].textElements.map((e) => (e.id === printed.id ? { ...e, sourceText: '-HDPE PIPES', ocrConfidence: 91 } : e)) };
    const out = applyHandwritingReadings(page, [{ elementIds: [printed.id], rect: line }], [{ text: 'RE.100 HOPE PIPES', confidence: 0.9 }], 0, 'p0');
    expect(out).toBe(page);
  });

  it('leaves elements alone when the reading agrees with the page OCR', () => {
    const d = doc();
    const ids = handwrittenIds(d);
    const same = d.pages[0].textElements.filter((e) => ids.includes(e.id)).map((e) => e.sourceText).join(' ');
    const out = applyHandwritingReadings(d.pages[0], [{ elementIds: ids, rect: line }], [{ text: same.toUpperCase(), confidence: 0.99 }], 0, 'p0');
    expect(out).toBe(d.pages[0]);
  });

  it('keeps doubtful readings out', () => {
    const d = doc();
    const out = applyHandwritingReadings(d.pages[0], [{ elementIds: handwrittenIds(d), rect: line }], [{ text: 'an', confidence: 0.4 }], 0, 'p0');
    expect(out).toBe(d.pages[0]);
  });

  it('is not an undo step and never overwrites a line the user already edited', () => {
    let h = createHistory(doc());
    const ids = handwrittenIds(h.present);
    h = execute(h, { type: 'setText', elementId: ids[0], text: 'typed by the user' });
    h = replacePresent(h, { type: 'readHandwriting', pageId: 'p0', groups: [{ elementIds: ids, rect: line }], readings: [{ text: 'Rival Bag House', confidence: 0.9 }] });
    expect(h.past.length).toBe(1);
    expect(h.present.pages[0].textElements.some((e) => e.recognizer === 'handwriting')).toBe(false);
    expect(h.present.pages[0].textElements.find((e) => e.id === ids[0])?.text).toBe('typed by the user');
  });
});

describe('TrOCR detokenizer', () => {
  it('joins SentencePiece pieces into words and drops special tokens', () => {
    const vocab = ['<s>', '<pad>', '</s>', '▁Rival', '▁B', 'ag', '▁House', '▁90', '001'];
    expect(detokenize([0, 3, 4, 5, 6, 2], vocab)).toBe('Rival Bag House');
    expect(detokenize([7, 8], vocab)).toBe('90001');
  });
});
