/**
 * Writing-system helpers: which font subsets a text needs, how it splits into
 * user-perceived characters, and script properties that change how text may
 * be fitted and laid out. Environment-neutral (no DOM, no Node).
 */

/** Font file subsets shipped per candidate family (fontsource / Google Fonts naming). */
export type FontSubset = 'latin' | 'latin-ext' | 'cyrillic' | 'greek' | 'devanagari';

/** Writing systems IntelliDoc can recognise and render. */
export type Script = 'latin' | 'cyrillic' | 'greek' | 'devanagari';

type Range = readonly [number, number];

/**
 * Unicode ranges of each subset, exactly as the font files are cut
 * (fontsource `unicode-range` descriptors). Ordered by preference: a code
 * point covered by several subsets (e.g. ₹ is in latin-ext and devanagari)
 * belongs to the first.
 */
const SUBSET_RANGES: ReadonlyArray<readonly [FontSubset, readonly Range[]]> = [
  [
    'latin',
    [
      [0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6], [0x02da, 0x02da], [0x02dc, 0x02dc],
      [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191],
      [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd],
    ],
  ],
  [
    'latin-ext',
    [
      [0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7], [0x02dd, 0x02ff], [0x1d00, 0x1dbf], [0x1e00, 0x1e9f],
      [0x1ef2, 0x1eff], [0x2020, 0x2020], [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113], [0x2c60, 0x2c7f], [0xa720, 0xa7ff],
    ],
  ],
  ['cyrillic', [[0x0301, 0x0301], [0x0400, 0x045f], [0x0490, 0x0491], [0x04b0, 0x04b1], [0x2116, 0x2116]]],
  ['greek', [[0x0370, 0x0377], [0x037a, 0x037f], [0x0384, 0x038a], [0x038c, 0x038c], [0x038e, 0x03a1], [0x03a3, 0x03ff]]],
  [
    'devanagari',
    [[0x0900, 0x097f], [0x1cd0, 0x1cf9], [0x200c, 0x200d], [0x20a8, 0x20a8], [0x20b9, 0x20b9], [0x20f0, 0x20f0], [0x25cc, 0x25cc], [0xa830, 0xa839], [0xa8e0, 0xa8ff]],
  ],
];

export const FONT_SUBSETS: readonly FontSubset[] = SUBSET_RANGES.map(([s]) => s);

/** The font subset a code point is drawn from, or undefined when no shipped subset covers it. */
export function subsetOf(codePoint: number): FontSubset | undefined {
  for (const [subset, ranges] of SUBSET_RANGES) {
    for (const [a, b] of ranges) if (codePoint >= a && codePoint <= b) return subset;
  }
  return undefined;
}

/** Font subsets needed to draw `text`. */
export function subsetsOf(text: string): Set<FontSubset> {
  const out = new Set<FontSubset>();
  for (const ch of text) {
    const s = subsetOf(ch.codePointAt(0)!);
    if (s) out.add(s);
  }
  return out;
}

export function scriptOfSubset(subset: FontSubset): Script {
  return subset === 'latin-ext' ? 'latin' : subset;
}

/** Subsets a script's text can draw from. */
export function subsetsOfScript(script: Script): FontSubset[] {
  return script === 'latin' ? ['latin', 'latin-ext'] : [script];
}

/**
 * Scripts used by `text`. Basic Latin digits, punctuation and spaces are
 * shared by every script and don't count, so "नेपाल 2081" is Devanagari and
 * "17652" is script-neutral (empty set). Script-specific digits and
 * punctuation do count ("२०८१", "।" are Devanagari).
 */
export function scriptsOf(text: string): Set<Script> {
  const out = new Set<Script>();
  for (const ch of text) {
    const s = subsetOf(ch.codePointAt(0)!);
    if (!s || (s === 'latin' && !/\p{L}/u.test(ch))) continue;
    out.add(scriptOfSubset(s));
  }
  return out;
}

/**
 * Scripts whose letters are joined by a continuous stroke (the Devanagari
 * headline, shirorekha). Extra letter spacing would cut that stroke into
 * pieces, so fitting and layout must leave tracking alone for them.
 */
const CONNECTED: ReadonlySet<Script> = new Set(['devanagari']);

export function hasConnectedScript(text: string): boolean {
  for (const s of scriptsOf(text)) if (CONNECTED.has(s)) return true;
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
 * (a letter with its combining marks, emoji sequences) and, for Indic
 * scripts, whole conjuncts (क्ष, त्रि), whose glyphs the font shapes
 * together. Drawing a matra or virama on its own shows a dotted circle.
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
