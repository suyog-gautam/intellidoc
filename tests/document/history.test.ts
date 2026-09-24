import { describe, expect, it } from 'vitest';
import { createHistory, execute, redo, replacePresent, undo } from '@/core/document/history';
import { buildDocument } from '@/core/pipeline/buildDocument';
import type { OcrWord } from '@/core/ocr/types';

function word(text: string, x: number, y: number, w = 60, h = 20, confidence = 95): OcrWord {
  return { text, bbox: { x, y, width: w, height: h }, confidence, lineKey: '0' };
}

function doc() {
  return buildDocument({ fileName: 'a.png', mimeType: 'image/png', byteSize: 1, sha256: 'ab'.repeat(32), kind: 'image', pageCount: 1 }, [
    { sourceRef: 'p', physical: { widthPt: 240, heightPt: 120 }, width: 1000, height: 500, skew: 0, ocr: { engine: 't', languages: ['eng'], confidence: 90, words: [word('Date:', 10, 10), word('13-09-2024', 80, 10, 110)] } },
  ]);
}

describe('edit history', () => {
  it('undoes and redoes text edits without touching the source text', () => {
    let h = createHistory(doc());
    const id = h.present.pages[0].textElements[0].id;
    h = execute(h, { type: 'setText', elementId: id, text: 'Date: 19-07-2026' });
    expect(h.present.pages[0].textElements[0]).toMatchObject({ text: 'Date: 19-07-2026', sourceText: 'Date: 13-09-2024', state: 'edited' });
    h = undo(h);
    expect(h.present.pages[0].textElements[0]).toMatchObject({ text: 'Date: 13-09-2024', state: 'original' });
    h = redo(h);
    expect(h.present.pages[0].textElements[0].text).toBe('Date: 19-07-2026');
  });

  it('setting text back to the source returns to the original state', () => {
    let h = createHistory(doc());
    const id = h.present.pages[0].textElements[0].id;
    h = execute(h, { type: 'setText', elementId: id, text: 'x' });
    h = execute(h, { type: 'setText', elementId: id, text: 'Date: 13-09-2024' });
    expect(h.present.pages[0].textElements[0].state).toBe('original');
  });

  it('analysis sets the inferred alignment unless the user chose one', () => {
    const typography = { inferredAlignment: 'center' } as Parameters<typeof replacePresent>[1] extends { typography: infer T } ? T : never;
    let h = createHistory(doc());
    const id = h.present.pages[0].textElements[0].id;
    h = execute(h, { type: 'setText', elementId: id, text: 'edited before analysis finished' });
    h = replacePresent(h, { type: 'setTypography', elementId: id, typography });
    expect(h.present.pages[0].textElements[0].alignment).toBe('center');
    h = execute(h, { type: 'setAlignment', elementId: id, alignment: 'right' });
    h = replacePresent(h, { type: 'setTypography', elementId: id, typography });
    expect(h.present.pages[0].textElements[0].alignment).toBe('right');
  });

  it('page processing updates are not undo steps and survive undo', () => {
    let h = createHistory(doc());
    const id = h.present.pages[0].textElements[0].id;
    h = execute(h, { type: 'setText', elementId: id, text: 'x' });
    h = replacePresent(h, { type: 'updatePage', pageId: 'p0', patch: { statusMessage: 'hello' } });
    expect(h.past.length).toBe(1);
    h = undo(h);
    expect(h.present.pages[0].statusMessage).toBe('hello');
  });

  it('analysis results do not create undo steps', () => {
    let h = createHistory(doc());
    const id = h.present.pages[0].textElements[0].id;
    h = execute(h, { type: 'setText', elementId: id, text: 'x' });
    h = replacePresent(h, { type: 'setTypography', elementId: id, typography: undefined });
    expect(h.past.length).toBe(1);
  });
});
