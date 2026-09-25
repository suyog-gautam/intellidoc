import { describe, expect, it } from 'vitest';
import { normalizeLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import { clusters, hasConnectedScript, scriptsOf, subsetsOf } from '@/core/text/script';
import { candidateFonts, fontStack, getFont } from '@/core/typography/fontCatalog';

describe('scripts and clusters', () => {
  it('keeps Devanagari conjuncts and vowel signs with their consonants', () => {
    expect(clusters('क्षत्रिय')).toEqual(['क्ष', 'त्रि', 'य']);
    expect(clusters('नमस्ते')).toEqual(['न', 'म', 'स्ते']);
    expect(clusters('राष्ट्र')).toEqual(['रा', 'ष्ट्र']);
    expect(clusters('Bill 17')).toEqual(['B', 'i', 'l', 'l', ' ', '1', '7']);
  });

  it('classifies scripts; basic digits and punctuation are neutral', () => {
    expect([...scriptsOf('नेपाल 2081')]).toEqual(['devanagari']);
    expect([...scriptsOf('२०८१')]).toEqual(['devanagari']);
    expect([...scriptsOf('17652.00')]).toEqual([]);
    expect([...scriptsOf('Привет')]).toEqual(['cyrillic']);
    expect([...scriptsOf('Łódź')]).toEqual(['latin']);
    expect([...subsetsOf('Łódź')].sort()).toEqual(['latin', 'latin-ext']);
    expect([...subsetsOf('₹ 500')].sort()).toEqual(['latin', 'latin-ext']);
    expect(hasConnectedScript('नेपाल')).toBe(true);
    expect(hasConnectedScript('Nepal 2081')).toBe(false);
  });
});

describe('font candidates per script', () => {
  it('fits Devanagari text only with fonts that draw it', () => {
    const ids = candidateFonts('नेपाल सरकार').map((f) => f.id);
    expect(ids).toContain('mukta');
    expect(ids).toContain('noto-sans-devanagari');
    expect(ids).toContain('kalam');
    expect(ids).not.toContain('arimo');
  });

  it('widens numbers to Devanagari families in a Nepali document, not in an English one', () => {
    expect(candidateFonts('17652', scriptsOfLanguages(['nep', 'eng'])).map((f) => f.id)).toContain('mukta');
    const english = candidateFonts('17652', scriptsOfLanguages(['eng'])).map((f) => f.id);
    expect(english).toContain('arimo');
    expect(english).not.toContain('mukta');
  });

  it('falls back per character to a same-style font for scripts a family lacks', () => {
    expect(fontStack('arimo')).toContain('"IDF Noto Sans Devanagari devanagari"');
    expect(fontStack('tinos')).toContain('"IDF Noto Serif Devanagari devanagari"');
    expect(fontStack('lato')).toContain('"IDF Noto Sans cyrillic"');
    expect(fontStack('mukta').startsWith('"IDF Mukta", "IDF Mukta latin-ext", "IDF Mukta devanagari"')).toBe(true);
    expect(getFont('tiro-devanagari-hindi').weights).toEqual([400]);
  });

  it('normalises OCR language choices', () => {
    expect(normalizeLanguages(['nep', 'eng', 'nep', 'xx'])).toEqual(['nep', 'eng']);
    expect(normalizeLanguages([])).toEqual(['eng']);
    expect(normalizeLanguages(['eng', 'hin', 'nep', 'mar'])).toHaveLength(3);
    expect(scriptsOfLanguages(['hin', 'eng']).sort()).toEqual(['devanagari', 'latin']);
  });
});
