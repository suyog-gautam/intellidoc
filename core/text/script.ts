/**
 * Writing-system helpers: which scripts a text uses, how it splits into
 * user-perceived characters, and script properties that change how text may
 * be fitted and laid out (direction, joined letters). Environment-neutral.
 *
 * Which *font files* draw a character is a separate question, answered from
 * the font manifest (see typography/fontFaces.ts).
 */

/** Writing systems IntelliDoc can recognise and render. */
export type Script =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'devanagari'
  | 'bengali'
  | 'gurmukhi'
  | 'gujarati'
  | 'tamil'
  | 'telugu'
  | 'kannada'
  | 'malayalam'
  | 'thai'
  /** Chinese characters (also used in Japanese kanji and Korean hanja). */
  | 'han'
  /** Japanese hiragana and katakana. */
  | 'kana'
  | 'hangul';

/** Regional glyph conventions for Han characters: the same code point is drawn differently in each. */
export type CjkRegion = 'sc' | 'tc' | 'jp' | 'kr';

type Block = readonly [number, number, Script];

/** Unicode blocks per script, sorted by start. Anything else (digits, punctuation, symbols) is script-neutral. */
const BLOCKS: readonly Block[] = (
  [
    [0x0041, 0x005a, 'latin'],
    [0x0061, 0x007a, 'latin'],
    [0x00aa, 0x00aa, 'latin'],
    [0x00ba, 0x00ba, 'latin'],
    [0x00c0, 0x00d6, 'latin'],
    [0x00d8, 0x00f6, 'latin'],
    [0x00f8, 0x024f, 'latin'],
    [0x0250, 0x02af, 'latin'],
    [0x0370, 0x03ff, 'greek'],
    [0x0400, 0x052f, 'cyrillic'],
    [0x0590, 0x05ff, 'hebrew'],
    [0x0600, 0x06ff, 'arabic'],
    [0x0750, 0x077f, 'arabic'],
    [0x0870, 0x08ff, 'arabic'],
    [0x0900, 0x097f, 'devanagari'],
    [0x0980, 0x09ff, 'bengali'],
    [0x0a00, 0x0a7f, 'gurmukhi'],
    [0x0a80, 0x0aff, 'gujarati'],
    [0x0b80, 0x0bff, 'tamil'],
    [0x0c00, 0x0c7f, 'telugu'],
    [0x0c80, 0x0cff, 'kannada'],
    [0x0d00, 0x0d7f, 'malayalam'],
    [0x0e00, 0x0e7f, 'thai'],
    [0x1100, 0x11ff, 'hangul'],
    [0x1c80, 0x1c8f, 'cyrillic'],
    [0x1cd0, 0x1cff, 'devanagari'],
    [0x1e00, 0x1eff, 'latin'],
    [0x1f00, 0x1fff, 'greek'],
    [0x2c60, 0x2c7f, 'latin'],
    [0x2de0, 0x2dff, 'cyrillic'],
    [0x2e80, 0x2fdf, 'han'],
    [0x3000, 0x303f, 'han'],
    [0x3040, 0x30ff, 'kana'],
    [0x3130, 0x318f, 'hangul'],
    [0x31f0, 0x31ff, 'kana'],
    [0x3400, 0x4dbf, 'han'],
    [0x4e00, 0x9fff, 'han'],
    [0xa640, 0xa69f, 'cyrillic'],
    [0xa720, 0xa7ff, 'latin'],
    [0xa8e0, 0xa8ff, 'devanagari'],
    [0xa960, 0xa97f, 'hangul'],
    [0xab30, 0xab6f, 'latin'],
    [0xac00, 0xd7af, 'hangul'],
    [0xd7b0, 0xd7ff, 'hangul'],
    [0xf900, 0xfaff, 'han'],
    [0xfb1d, 0xfb4f, 'hebrew'],
    [0xfb50, 0xfdff, 'arabic'],
    [0xfe70, 0xfeff, 'arabic'],
    [0xff01, 0xff60, 'han'],
    [0xff66, 0xff9f, 'kana'],
    [0x20000, 0x3134f, 'han'],
  ] as Block[]
).sort((a, b) => a[0] - b[0]);

/** Script of one code point, or undefined for script-neutral characters (basic digits, punctuation, symbols). */
export function scriptOf(codePoint: number): Script | undefined {
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, s] = BLOCKS[mid];
    if (codePoint < a) hi = mid - 1;
    else if (codePoint > b) lo = mid + 1;
    else return s;
  }
  return undefined;
}

/**
 * Scripts used by `text`. Basic digits, punctuation and spaces are shared by
 * every script and don't count, so "नेपाल 2081" is Devanagari and "17652"
 * is script-neutral (empty set). Script-specific digits and punctuation do
 * count ("२०८१", "٣٤", "।" are Devanagari / Arabic).
 */
export function scriptsOf(text: string): Set<Script> {
  const out = new Set<Script>();
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (s) out.add(s);
  }
  return out;
}

const RTL: ReadonlySet<Script> = new Set(['arabic', 'hebrew']);

/**
 * Scripts whose letters are joined: by a continuous headline (Devanagari
 * शिरोरेखा, Bengali, Gurmukhi) or by cursive joining (Arabic). Extra letter
 * spacing or per-letter drawing would break the joins, so fitting, layout
 * and handwriting variation treat such text as one unbroken run.
 */
const CONNECTED: ReadonlySet<Script> = new Set(['devanagari', 'bengali', 'gurmukhi', 'arabic']);

export function hasConnectedScript(text: string): boolean {
  for (const s of scriptsOf(text)) if (CONNECTED.has(s)) return true;
  return false;
}

export function isRtlScript(script: Script): boolean {
  return RTL.has(script);
}

/** Paragraph direction by the first strong character (like HTML dir="auto"). */
export function textDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (s) return RTL.has(s) ? 'rtl' : 'ltr';
  }
  return 'ltr';
}

/** Any right-to-left character at all (then per-cluster placement by logical order is wrong). */
export function hasRtl(text: string): boolean {
  for (const s of scriptsOf(text)) if (RTL.has(s)) return true;
  return false;
}

/** Viramas (halant) of the Indic scripts: a following consonant forms a conjunct with the preceding one. */
const VIRAMA = /[्্੍્୍்్್്]/u;
const JOINER = /[‌‍]/u;
const MARK = /\p{M}/u;

type SegmenterLike = { segment(text: string): Iterable<{ segment: string }> };
let segmenter: SegmenterLike | null | undefined;

function graphemeSegmenter(): SegmenterLike | null {
  if (segmenter !== undefined) return segmenter;
  const Seg = (Intl as unknown as { Segmenter?: new (locale?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
  segmenter = Seg ? new Seg(undefined, { granularity: 'grapheme' }) : null;
  return segmenter;
}

/**
 * Split text into clusters that must be drawn as one unit: grapheme clusters
 * (a letter with its combining marks, Thai vowel and tone marks, emoji
 * sequences) and, for Indic scripts, whole conjuncts (क्ष, त्रि), whose
 * glyphs the font shapes together. Drawing a matra or virama on its own
 * shows a dotted circle.
 *
 * Unicode 15.1 grapheme rules already keep conjuncts together; the explicit
 * virama merge makes that independent of the runtime's ICU version.
 */
export function clusters(text: string): string[] {
  const seg = graphemeSegmenter();
  const base: string[] = [];
  if (seg) for (const s of seg.segment(text)) base.push(s.segment);
  else {
    for (const ch of text) {
      if (base.length && (MARK.test(ch) || JOINER.test(ch))) base[base.length - 1] += ch;
      else base.push(ch);
    }
  }
  const out: string[] = [];
  for (const c of base) {
    const prev = out[out.length - 1];
    const joins = prev !== undefined && /\p{L}/u.test(c) && (VIRAMA.test(prev.slice(-1)) || (JOINER.test(prev.slice(-1)) && VIRAMA.test(prev.slice(-2, -1))));
    if (joins) out[out.length - 1] = prev + c;
    else out.push(c);
  }
  return out;
}
