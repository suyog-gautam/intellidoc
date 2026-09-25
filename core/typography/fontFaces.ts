import { scriptOf, scriptsOf, type CjkRegion, type Script } from '../text/script';
import { FONT_CATALOG, getFont, type CandidateFont } from './fontCatalog';
import manifest from './fontFaces.json';

/**
 * Font files and coverage, from the generated manifest
 * (scripts/build-font-manifest.mjs). Fonts come in slices ("latin",
 * "arabic", or ~100 numbered slices for CJK), each registered as its own
 * CSS family. For a given text, the font string lists only the slices that
 * text needs, followed by same-style fallbacks for characters the font
 * can't draw. The browser then downloads only those slices, and Node
 * (@napi-rs/canvas, which can't pick between files sharing one family name)
 * renders identically.
 */

export type Weight = 400 | 700;

/** One font file to register: CSS family, weight, file name and its unicode ranges (CSS syntax). */
export interface FaceRef {
  /** fontsource package holding the file. */
  pkg: string;
  family: string;
  weight: Weight;
  file: string;
  unicodeRange: string;
}

interface Slice {
  id: string;
  /** Sorted inclusive [start, end] code point pairs. */
  ranges: Int32Array;
  css: string;
}

interface FontFiles {
  weights: Weight[];
  slices: Slice[];
}

const M = manifest as unknown as { ranges: string[]; fonts: Record<string, { weights: number[]; slices: [string, number][] }> };
const parsed = new Map<string, FontFiles>();
const rangeCache = new Map<number, { ranges: Int32Array; css: string }>();

function parseRanges(index: number): { ranges: Int32Array; css: string } {
  let r = rangeCache.get(index);
  if (r) return r;
  const parts = M.ranges[index].split(',');
  const pairs: [number, number][] = parts.map((p) => {
    const [a, b] = p.split('-');
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
  pairs.sort((x, y) => x[0] - y[0]);
  const ranges = new Int32Array(pairs.length * 2);
  pairs.forEach(([a, b], i) => {
    ranges[2 * i] = a;
    ranges[2 * i + 1] = b;
  });
  r = { ranges, css: parts.map((p) => `U+${p}`).join(',') };
  rangeCache.set(index, r);
  return r;
}

function files(font: CandidateFont): FontFiles {
  let f = parsed.get(font.pkg);
  if (f) return f;
  const entry = M.fonts[font.pkg];
  if (!entry) throw new Error(`Font ${font.pkg} is missing from fontFaces.json; run npm run fonts:manifest`);
  f = { weights: entry.weights as Weight[], slices: entry.slices.map(([id, idx]) => ({ id, ...parseRanges(idx) })) };
  parsed.set(font.pkg, f);
  return f;
}

function inRanges(r: Int32Array, cp: number): boolean {
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[2 * mid]) hi = mid - 1;
    else if (cp > r[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Index of the slice drawing a code point, or -1. */
function sliceFor(font: CandidateFont, cp: number): number {
  const s = files(font).slices;
  for (let i = 0; i < s.length; i++) if (inRanges(s[i].ranges, cp)) return i;
  return -1;
}

/** Weights the font ships (400 and/or 700). */
export function fontWeights(fontId: string): readonly Weight[] {
  return files(getFont(fontId)).weights;
}

/** The shipped weight closest to the requested one. */
export function nearestWeight(fontId: string, weight: number): Weight {
  const ws = fontWeights(fontId);
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0]);
}

export function sliceFamily(font: CandidateFont, sliceId: string): string {
  return `${font.family} ${sliceId}`;
}

/** Characters whose absence would be visible (letters, digits, punctuation), not spaces or joiners. */
function needsGlyph(cp: number): boolean {
  return !(cp <= 0x20 || cp === 0xa0 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff || (cp >= 0xfe00 && cp <= 0xfe0f));
}

/** Can this font draw every visible character of `text` itself? */
export function fontCovers(fontId: string, text: string): boolean {
  const font = getFont(fontId);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (needsGlyph(cp) && sliceFor(font, cp) < 0) return false;
  }
  return true;
}

/** Same-style fonts for characters a family can't draw, per script: [sans, serif, handwriting]. */
const FALLBACKS: Partial<Record<Script | 'neutral', readonly [string, string, string]>> = {
  latin: ['noto-sans', 'noto-serif', 'caveat'],
  cyrillic: ['noto-sans', 'noto-serif', 'caveat'],
  greek: ['noto-sans', 'noto-serif', 'noto-sans'],
  neutral: ['noto-sans', 'noto-serif', 'noto-sans'],
  devanagari: ['noto-sans-devanagari', 'noto-serif-devanagari', 'kalam'],
  bengali: ['noto-sans-bengali', 'noto-serif-bengali', 'noto-sans-bengali'],
  gurmukhi: ['noto-sans-gurmukhi', 'noto-serif-gurmukhi', 'noto-sans-gurmukhi'],
  gujarati: ['noto-sans-gujarati', 'noto-serif-gujarati', 'noto-sans-gujarati'],
  tamil: ['noto-sans-tamil', 'noto-serif-tamil', 'noto-sans-tamil'],
  telugu: ['noto-sans-telugu', 'noto-serif-telugu', 'noto-sans-telugu'],
  kannada: ['noto-sans-kannada', 'noto-serif-kannada', 'noto-sans-kannada'],
  malayalam: ['noto-sans-malayalam', 'noto-serif-malayalam', 'noto-sans-malayalam'],
  arabic: ['noto-sans-arabic', 'noto-naskh-arabic', 'aref-ruqaa'],
  hebrew: ['noto-sans-hebrew', 'noto-serif-hebrew', 'noto-sans-hebrew'],
  thai: ['noto-sans-thai', 'noto-serif-thai', 'sriracha'],
  han: ['noto-sans-sc', 'noto-serif-sc', 'ma-shan-zheng'],
  kana: ['noto-sans-jp', 'noto-serif-jp', 'klee-one'],
  hangul: ['noto-sans-kr', 'noto-serif-kr', 'nanum-pen-script'],
};

const REGION_FALLBACK: Record<CjkRegion, readonly [string, string, string]> = {
  sc: ['noto-sans-sc', 'noto-serif-sc', 'ma-shan-zheng'],
  tc: ['noto-sans-tc', 'noto-sans-tc', 'noto-sans-tc'],
  jp: ['noto-sans-jp', 'noto-serif-jp', 'klee-one'],
  kr: ['noto-sans-kr', 'noto-serif-kr', 'nanum-pen-script'],
};

function fallbackFor(font: CandidateFont, cp: number): CandidateFont | undefined {
  const script = scriptOf(cp) ?? 'neutral';
  const row = script === 'han' && font.cjkRegion ? REGION_FALLBACK[font.cjkRegion] : FALLBACKS[script];
  const order = font.category === 'serif' ? [1, 0] : font.category === 'handwriting' ? [2, 0] : [0, 1];
  for (const i of order) {
    const id = row?.[i];
    if (id && id !== font.id) {
      const fb = getFont(id);
      if (sliceFor(fb, cp) >= 0) return fb;
    }
  }
  // Last resort: any catalogue font that draws it (rare symbols).
  return FONT_CATALOG.find((f) => f.id !== font.id && sliceFor(f, cp) >= 0);
}

interface Stack {
  css: string;
  faces: { font: CandidateFont; slice: Slice }[];
}

const stackCache = new Map<string, Stack>();

/** Slices (own and fallback) needed to draw `text` in a font, in stack order. */
function stackFor(fontId: string, text: string): Stack {
  const key = `${fontId}\u0000${text}`;
  const cached = stackCache.get(key);
  if (cached) return cached;
  const font = getFont(fontId);
  const own = new Set<number>();
  const fallback = new Map<string, { font: CandidateFont; slices: Set<number> }>();
  // The slice with the space (usually latin) keeps metrics consistent even for empty text.
  own.add(Math.max(0, sliceFor(font, 0x20)));
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const i = sliceFor(font, cp);
    if (i >= 0) {
      own.add(i);
      continue;
    }
    if (!needsGlyph(cp)) continue;
    const fb = fallbackFor(font, cp);
    if (!fb) continue;
    let e = fallback.get(fb.id);
    if (!e) fallback.set(fb.id, (e = { font: fb, slices: new Set() }));
    e.slices.add(sliceFor(fb, cp));
  }
  const faces: Stack['faces'] = [];
  const ownSlices = files(font).slices;
  for (const i of [...own].sort((a, b) => a - b)) faces.push({ font, slice: ownSlices[i] });
  for (const { font: fb, slices } of fallback.values()) {
    const s = files(fb).slices;
    for (const i of [...slices].sort((a, b) => a - b)) faces.push({ font: fb, slice: s[i] });
  }
  const stack = { css: faces.map((f) => `"${sliceFamily(f.font, f.slice.id)}"`).join(', '), faces };
  if (stackCache.size > 4000) stackCache.clear();
  stackCache.set(key, stack);
  return stack;
}

/** CSS font-family list to draw `text` in a candidate font. */
export function fontStack(fontId: string, text: string): string {
  return stackFor(fontId, text).css;
}

/** Canvas font string for `text` in a candidate font. */
export function cssFont(fontId: string, weight: number, italic: boolean, sizePx: number, text: string): string {
  return `${italic ? 'italic ' : ''}${weight} ${sizePx}px ${fontStack(fontId, text)}`;
}

/** Font files (all shipped weights) that must be loaded to draw `text` in these fonts. */
export function facesFor(fontIds: Iterable<string>, text: string): FaceRef[] {
  const out = new Map<string, FaceRef>();
  for (const id of fontIds) {
    for (const { font, slice } of stackFor(id, text).faces) {
      for (const weight of files(font).weights) {
        const file = `${font.pkg}-${slice.id}-${weight}-normal.woff2`;
        if (!out.has(file)) out.set(file, { pkg: font.pkg, family: sliceFamily(font, slice.id), weight, file, unicodeRange: slice.css });
      }
    }
  }
  return [...out.values()];
}

export interface FontContext {
  /** Scripts of the document's languages. */
  scripts?: Iterable<Script>;
  /** Han glyph conventions of the document's languages (Chinese simplified/traditional, Japanese, Korean). */
  cjkRegions?: Iterable<CjkRegion>;
}

/**
 * Fitting candidates for `text`: fonts that draw every character and are
 * meant for its scripts or the document's (a number in a Nepali document
 * may be set in a Devanagari family's digits). For Han characters, fonts of
 * the document's region come first: 骨 is drawn differently in Chinese and
 * Japanese.
 */
export function candidateFonts(text: string, context: FontContext = {}): CandidateFont[] {
  const own = scriptsOf(text);
  const consider = new Set<Script>([...own, ...(context.scripts ?? [])]);
  if (consider.size === 0) consider.add('latin');
  const regions = new Set(context.cjkRegions ?? []);
  const covering = FONT_CATALOG.filter((f) => fontCovers(f.id, text));
  let preferred = covering.filter((f) => f.scripts.some((s) => consider.has(s)));
  if ((own.has('han') || own.has('kana') || own.has('hangul')) && regions.size) {
    const regional = preferred.filter((f) => !f.cjkRegion || regions.has(f.cjkRegion));
    if (regional.length) preferred = regional;
  }
  if (preferred.length) return preferred;
  return covering.length ? covering : [getFont('noto-sans')];
}
