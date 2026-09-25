import { describe, expect, it } from 'vitest';
import { chooseLanguages, dominantScript } from '@/core/ocr/detectLanguages';
import { cjkRegionsOfLanguages, languagesForScript, languagesFromLocales, normalizeLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import { clusters, hasConnectedScript, scriptsOf, textDirection } from '@/core/text/script';
import { getFont } from '@/core/typography/fontCatalog';
import { candidateFonts, facesFor, fontCovers, fontStack, fontWeights } from '@/core/typography/fontFaces';

const ids = (text: string, langs: string[] = ['eng']) => candidateFonts(text, { scripts: scriptsOfLanguages(langs), cjkRegions: cjkRegionsOfLanguages(langs) }).map((f) => f.id);

describe('scripts and clusters', () => {
  it('keeps Devanagari conjuncts and vowel signs with their consonants', () => {
    expect(clusters('क्षत्रिय')).toEqual(['क्ष', 'त्रि', 'य']);
    expect(clusters('नमस्ते')).toEqual(['न', 'म', 'स्ते']);
    expect(clusters('राष्ट्र')).toEqual(['रा', 'ष्ट्र']);
    expect(clusters('Bill 17')).toEqual(['B', 'i', 'l', 'l', ' ', '1', '7']);
    // Thai vowel and tone marks stay on their consonant.
    expect(clusters('ที่')).toHaveLength(1);
  });

  it('classifies scripts of the most spoken languages; basic digits and punctuation are neutral', () => {
    const cases: [string, string[]][] = [
      ['नेपाल 2081', ['devanagari']],
      ['२०८१', ['devanagari']],
      ['17652.00', []],
      ['Привет', ['cyrillic']],
      ['Łódź Tiếng Việt', ['latin']],
      ['发票号码', ['han']],
      ['請求書のお知らせ', ['han', 'kana']],
      ['세금 계산서', ['hangul']],
      ['فاتورة ١٧٦٥٢', ['arabic']],
      ['اردو', ['arabic']],
      ['চালান', ['bengali']],
      ['தமிழ்', ['tamil']],
      ['తెలుగు', ['telugu']],
      ['ગુજરાતી', ['gujarati']],
      ['ਪੰਜਾਬੀ', ['gurmukhi']],
      ['ಕನ್ನಡ', ['kannada']],
      ['മലയാളം', ['malayalam']],
      ['ใบแจ้งหนี้', ['thai']],
      ['עברית', ['hebrew']],
      ['Ελληνικά', ['greek']],
    ];
    for (const [text, scripts] of cases) expect([...scriptsOf(text)].sort(), text).toEqual(scripts.sort());
    expect(hasConnectedScript('नेपाल')).toBe(true);
    expect(hasConnectedScript('فاتورة')).toBe(true);
    expect(hasConnectedScript('Nepal 2081')).toBe(false);
    expect(textDirection('فاتورة 17652')).toBe('rtl');
    expect(textDirection('17652 Invoice')).toBe('ltr');
  });
});

describe('font coverage and candidates', () => {
  it('every catalogue font is in the manifest and draws its own scripts', () => {
    const samples: Record<string, string> = {
      latin: 'Invoice', cyrillic: 'Счёт', greek: 'Ελλάδα', hebrew: 'חשבונית', devanagari: 'नेपाल', bengali: 'চালান', gurmukhi: 'ਪੰਜਾਬ',
      gujarati: 'ગુજરાત', tamil: 'தமிழ்', telugu: 'తెలుగు', kannada: 'ಕನ್ನಡ', malayalam: 'മലയാളം', thai: 'ไทย', arabic: 'فاتورة', han: '发票', kana: 'のお', hangul: '한국',
    };
    for (const id of candidateFonts('x').map((f) => f.id)) expect(fontWeights(id).length).toBeGreaterThan(0);
    for (const s of ['devanagari', 'arabic', 'han', 'thai', 'hangul', 'tamil'] as const) {
      const fonts = candidateFonts(samples[s]);
      expect(fonts.length, s).toBeGreaterThan(1);
      for (const f of fonts) expect(fontCovers(f.id, samples[s]), `${f.id} ${s}`).toBe(true);
    }
  });

  it('fits text only with fonts meant for its script', () => {
    expect(ids('नेपाल सरकार')).toEqual(expect.arrayContaining(['mukta', 'noto-sans-devanagari', 'kalam']));
    expect(ids('नेपाल सरकार')).not.toContain('arimo');
    expect(ids('فاتورة رقم')).toEqual(expect.arrayContaining(['noto-naskh-arabic', 'amiri', 'aref-ruqaa']));
    expect(ids('ใบแจ้งหนี้')).toContain('sarabun');
    const english = ids('Invoice 17652');
    expect(english).toContain('arimo');
    for (const other of ['mukta', 'noto-sans-sc', 'amiri', 'sarabun', 'noto-sans-kr']) expect(english).not.toContain(other);
  });

  it('widens numbers to the document script, and uses the document region for Han', () => {
    expect(ids('17652', ['nep', 'eng'])).toContain('mukta');
    expect(ids('17652', ['eng'])).not.toContain('mukta');
    const zh = ids('发票号码', ['chi_sim']);
    expect(zh).toContain('noto-sans-sc');
    expect(zh).not.toContain('noto-sans-jp');
    const ja = ids('番号', ['jpn']);
    expect(ja).toContain('noto-sans-jp');
    expect(ja).not.toContain('noto-sans-sc');
  });

  it('lists only the slices a text needs, with same-style fallbacks for other scripts', () => {
    const zh = facesFor(['noto-sans-sc'], '发票 17652');
    expect(zh.length).toBeLessThan(8); // a few of ~100 slices
    expect(fontStack('arimo', 'Bill नेपाल')).toContain('IDF Noto Sans Devanagari');
    expect(fontStack('tinos', 'Bill नेपाल')).toContain('IDF Noto Serif Devanagari');
    expect(fontStack('arimo', 'Invoice')).not.toContain('Devanagari');
    expect(fontWeights('tiro-devanagari-hindi')).toEqual([400]);
    expect(getFont('aref-ruqaa').category).toBe('handwriting');
  });
});

describe('languages and auto-detection', () => {
  it('normalises choices; Auto stands alone', () => {
    expect(normalizeLanguages(['nep', 'eng', 'nep', 'xx'])).toEqual(['nep', 'eng']);
    expect(normalizeLanguages([])).toEqual(['auto']);
    expect(normalizeLanguages(['eng', 'auto'])).toEqual(['auto']);
    expect(normalizeLanguages(['eng', 'hin', 'nep', 'mar'])).toHaveLength(3);
    expect(scriptsOfLanguages(['jpn', 'eng']).sort()).toEqual(['han', 'kana', 'latin']);
  });

  it('maps a detected script to languages, picking the language within the script from the browser locale', () => {
    expect(languagesForScript('Devanagari', ['ne-NP', 'en'])).toEqual(['nep', 'eng']);
    expect(languagesForScript('Devanagari', ['en-US'])).toEqual(['hin', 'eng']);
    expect(languagesForScript('Han', ['zh-TW'])).toEqual(['chi_tra', 'eng']);
    expect(languagesForScript('Han', ['en'])).toEqual(['chi_sim', 'eng']);
    expect(languagesForScript('Japanese', [])).toEqual(['jpn', 'eng']);
    expect(languagesForScript('Korean', [])).toEqual(['kor', 'eng']);
    expect(languagesForScript('Arabic', ['ur-PK'])).toEqual(['urd', 'eng']);
    expect(languagesForScript('Latin', ['es-MX'])).toEqual(['spa', 'eng']);
    expect(languagesForScript('Latin', ['en-GB'])).toEqual(['eng']);
    expect(languagesForScript('Klingon', [])).toBeUndefined();
    expect(languagesFromLocales(['bn-BD'])).toEqual(['ben', 'eng']);
  });

  it('combines OSD, headline evidence and locale', () => {
    // OSD can't see headline scripts; the probe text decides between them.
    expect(chooseLanguages({ headlineWords: 12, headlineProbeText: 'চালান নম্বর abc', locales: [] })).toMatchObject({ languages: ['ben', 'eng'], source: 'headline' });
    expect(chooseLanguages({ osd: { script: 'Latin', confidence: 9, orientation: 0 }, headlineWords: 9, headlineProbeText: 'नेपाल सरकार', locales: ['ne'] })).toMatchObject({ languages: ['nep', 'eng'] });
    expect(chooseLanguages({ osd: { script: 'Arabic', confidence: 70, orientation: 0 }, headlineWords: 0, locales: [] })).toMatchObject({ languages: ['ara', 'eng'], source: 'script' });
    // Unsure OSD falls back to the browser language.
    expect(chooseLanguages({ osd: { script: 'Thai', confidence: 0.3, orientation: 0 }, headlineWords: 0, locales: ['fr-FR'] })).toMatchObject({ languages: ['fra', 'eng'], source: 'locale' });
    expect(dominantScript('ਪੰਜਾਬੀ ab')).toBe('gurmukhi');
    // A noisy phone-photo probe (measured on a real challan): the Nepali locale settles it; a clear probe doesn't need it.
    expect(chooseLanguages({ headlineWords: 7, headlineProbeText: 'दे. ৭, ् ১১১৮ 4. ਦੱ थक ली, कै . 0 ਨ রণ', locales: ['ne-NP'] }).languages).toEqual(['nep', 'eng']);
    expect(chooseLanguages({ headlineWords: 9, headlineProbeText: 'চালান নম্বর তারিখ', locales: ['ne-NP'] }).languages).toEqual(['ben', 'eng']);
  });
});
