import { unionRects, verticalOverlap, type Rect } from '../geometry';
import type { OcrWord } from '../ocr/types';
import type { StyledWord, WordStyle } from './wordStyle';

export interface SegmentedRun {
  words: StyledWord[];
  bbox: Rect;
  text: string;
  confidence: number;
}

export interface SegmentedLine {
  runs: SegmentedRun[];
  bbox: Rect;
}

export interface SegmentOptions {
  /** A horizontal gap larger than this multiple of the text height starts a new run. */
  runGapFactor?: number;
  /** Words below this confidence are dropped unless they look like real text. */
  minConfidence?: number;
  /** Glyph-height ratio that counts as a size change (conservative: glyph heights are noisy on photos). */
  sizeRatio?: number;
  /** RGB distance that counts as a colour change. */
  colorDistance?: number;
  /** Diagnostics: normalised stroke weights used to learn the page's weight classes. */
  onWeightSamples?: (samples: number[], pageGlyphHeight: number) => void;
  /** Diagnostics: the style context of every line before splitting. */
  onLineStyle?: (info: { words: string[]; ctx: StyleContext }) => void;
  /** Diagnostics: called for every style-based split. */
  onStyleSplit?: (info: { reason: string; before: string; word: string }) => void;
}

type WeightClass = 'regular' | 'bold';

/**
 * Page-level weight classes. Stroke width is normalised by the line's glyph
 * height (so larger text isn't mistaken for bold), then split into two
 * classes with Otsu's method. Only if the two classes are clearly separated
 * does the page "have" bold text; words near the threshold stay unclassified
 * so they can never cause a split.
 */
export interface WeightModel {
  /** Words at or below are confidently regular. */
  low: number;
  /** Words at or above are confidently bold. */
  high: number;
  bold: number;
  regular: number;
}

export function learnWeightModel(normalizedWeights: readonly number[], minSeparation = 1.2, minEta = 0.6): WeightModel | undefined {
  const all = [...normalizedWeights].filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (all.length < 6) return undefined;
  // Robustness: bold is at most ~2x regular, so samples far from the median
  // are mismeasured marks (specks, stamps, broken glyphs). A single such
  // outlier would otherwise become its own "class" and disable the model.
  const mid = all[all.length >> 1];
  const v = all.filter((x) => x >= mid / 2.5 && x <= mid * 2.5);
  if (v.length < 6) return undefined;
  const total = v.reduce((a, b) => a + b, 0);
  let best = -1;
  let split = 0;
  let sumLo = 0;
  for (let i = 1; i < v.length; i++) {
    sumLo += v[i - 1];
    const nLo = i;
    const nHi = v.length - i;
    const mLo = sumLo / nLo;
    const mHi = (total - sumLo) / nHi;
    const between = nLo * nHi * (mHi - mLo) ** 2;
    if (between > best) {
      best = between;
      split = i;
    }
  }
  const lo = v.slice(0, split);
  const hi = v.slice(split);
  const minClass = Math.max(3, Math.round(v.length * 0.04));
  if (lo.length < minClass || hi.length < minClass) return undefined;
  const mLo = lo.reduce((a, b) => a + b, 0) / lo.length;
  const mHi = hi.reduce((a, b) => a + b, 0) / hi.length;
  if (mHi / mLo < minSeparation) return undefined;
  // Bimodality: share of variance explained by the two classes.
  const mean = total / v.length;
  const variance = v.reduce((a, x) => a + (x - mean) ** 2, 0);
  const eta = variance > 0 ? best / v.length / variance : 0;
  if (eta < minEta) return undefined;
  const t = (v[split - 1] + v[split]) / 2;
  // Narrow band: noise is handled by the pairwise stroke check in splitByStyle.
  const margin = (mHi - mLo) * 0.12;
  return { low: t - margin, high: t + margin, bold: mHi, regular: mLo };
}

function reliable(w: StyledWord): WordStyle | undefined {
  const s = w.style;
  if (!s || PUNCTUATION_ONLY.test(w.text) || s.strokeWidth <= 0) return undefined;
  // Very little ink (one or two short glyphs) gives a noisy stroke estimate.
  return s.inkMass >= s.glyphHeight * 1.5 ? s : undefined;
}

/** Capitals, digits and ascenders: words containing these measure cap/ascender height, not x-height. */
const TALL_GLYPHS = /[\p{Lu}\p{N}bdfhklt]/u;

function hasTallGlyphs(w: StyledWord): boolean {
  return TALL_GLYPHS.test(w.text) && w.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 2;
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface StyleContext {
  weights?: WeightModel;
  /** Glyph height used to normalise stroke width for this line. */
  lineGlyphHeight: number;
}

function weightClass(s: WordStyle, ctx: StyleContext): WeightClass | undefined {
  if (!ctx.weights) return undefined;
  const w = s.strokeWidth / Math.max(1, ctx.lineGlyphHeight);
  return w >= ctx.weights.high ? 'bold' : w <= ctx.weights.low ? 'regular' : undefined;
}

/**
 * Split a run wherever the visual style changes: "Certificate No. :" (bold)
 * followed by "SCS/000000/001" (regular) are adjacent words on one line but
 * must be separate elements so each keeps its own typography. Changes in
 * weight class, glyph size or ink colour start a new group. Punctuation and
 * words without a reliable style follow the group they are in.
 */
export function splitByStyle(words: readonly StyledWord[], ctx: StyleContext, opts: SegmentOptions = {}): StyledWord[][] {
  const sizeRatio = opts.sizeRatio ?? 1.6;
  const colorDistance = opts.colorDistance ?? 70;
  const groups: StyledWord[][] = [];
  let current: StyledWord[] = [];
  let classes: WeightClass[] = [];
  let heights: number[] = [];
  let strokes: number[] = [];
  let colors: [number, number, number][] = [];
  for (const w of words) {
    const s = reliable(w);
    if (s && current.length > 0) {
      const cls = weightClass(s, ctx);
      const groupCls = classes.length ? (classes.filter((c) => c === 'bold').length * 2 >= classes.length ? 'bold' : 'regular') : undefined;
      const gs = strokes.length ? med(strokes) : s.strokeWidth;
      const gc = colors.length ? ([0, 1, 2].map((c) => med(colors.map((x) => x[c]))) as [number, number, number]) : s.inkColor;
      // Weight: the word must be confidently in the other class AND visibly
      // different from the group so far (guards against flip-flopping).
      const strokeRatio = Math.max(gs, s.strokeWidth) / Math.max(1e-6, Math.min(gs, s.strokeWidth));
      const weightChange = cls !== undefined && groupCls !== undefined && cls !== groupCls && strokeRatio >= 1.18;
      // Size: only comparable between words that have tall glyphs (x-height words look "smaller").
      const tall = hasTallGlyphs(w) && w.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 4;
      const gh = heights.length ? med(heights) : s.glyphHeight;
      // Both heights must be plausible glyph heights (broken glyphs at low DPI measure tiny).
      const plausible = Math.min(gh, s.glyphHeight) >= ctx.lineGlyphHeight * 0.5;
      const sizeChange =
        tall && plausible && heights.length > 0 && Math.max(gh, s.glyphHeight) / Math.max(1, Math.min(gh, s.glyphHeight)) >= sizeRatio && Math.abs(gh - s.glyphHeight) >= Math.max(3, gh * 0.3);
      const colorChange = Math.hypot(gc[0] - s.inkColor[0], gc[1] - s.inkColor[1], gc[2] - s.inkColor[2]) >= colorDistance;
      if (weightChange || sizeChange || colorChange) {
        opts.onStyleSplit?.({
          reason: [
            weightChange && `weight ${groupCls}->${cls} (w=${(s.strokeWidth / ctx.lineGlyphHeight).toFixed(3)}, model ${ctx.weights?.low.toFixed(3)}..${ctx.weights?.high.toFixed(3)})`,
            sizeChange && `size ${gh}->${s.glyphHeight}`,
            colorChange && `color ${gc.map(Math.round).join(',')}->${s.inkColor.map(Math.round).join(',')}`,
          ]
            .filter(Boolean)
            .join('; '),
          before: current.map((x) => x.text).join(' '),
          word: w.text,
        });
        groups.push(current);
        current = [];
        classes = [];
        heights = [];
        strokes = [];
        colors = [];
      }
    }
    current.push(w);
    if (s) {
      const cls = weightClass(s, ctx);
      if (cls) classes.push(cls);
      if (hasTallGlyphs(w)) heights.push(s.glyphHeight);
      strokes.push(s.strokeWidth);
      colors.push(s.inkColor);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;
const RULE_LIKE = /^[|[\]{}()\\/!Il1—–_~=-]+$/;

/**
 * Decide whether an OCR word is plausible text rather than noise produced by
 * rules, stamps, signatures or photo artefacts. Low-confidence words that
 * contain real alphanumerics are kept (the user can correct them); pure
 * punctuation garbage and table borders misread as "|" are dropped.
 */
export function isPlausibleWord(word: OcrWord, medianHeight: number, minConfidence = 25): boolean {
  const { text, bbox, confidence } = word;
  if (bbox.width < 1 || bbox.height < 1) return false;
  if (bbox.height > medianHeight * 4) return false;
  if (RULE_LIKE.test(text) && bbox.height / Math.max(1, bbox.width) > 2.5) return false;
  if (PUNCTUATION_ONLY.test(text)) return confidence >= 60 || /^[:;.,]$/.test(text);
  if (confidence < minConfidence) return /[\p{L}\p{N}]{3,}/u.test(text) && confidence >= minConfidence / 2;
  return true;
}

function makeRun(words: StyledWord[]): SegmentedRun {
  return {
    words,
    bbox: unionRects(words.map((w) => w.bbox)),
    text: words.map((w) => w.text).join(' '),
    confidence: Math.min(...words.map((w) => w.confidence)),
  };
}

/**
 * "Certificate No. : SCS/000000/011": a colon separated from its label by a
 * gap can end up leading the value's run. Labels own their colon (it is
 * printed in the label's style), so move it back to the preceding run on
 * the same line when that run is close by.
 */
function attachLeadingColons(runs: SegmentedRun[], lineHeight: number): void {
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    const prev = runs[i - 1];
    const first = run.words[0];
    if (run.words.length < 2 || !/^[:;]$/.test(first.text)) continue;
    const last = prev.words[prev.words.length - 1];
    if (PUNCTUATION_ONLY.test(last.text)) continue;
    const gap = first.bbox.x - (last.bbox.x + last.bbox.width);
    if (gap > lineHeight * 2) continue;
    runs[i - 1] = makeRun([...prev.words, first]);
    runs[i] = makeRun(run.words.slice(1));
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Group words into lines and lines into runs: by geometry, then by visual
 * style when words carry a measured {@link WordStyle}.
 *
 * Engine line grouping is ignored on purpose: Tesseract happily merges table
 * cells, stray marks and neighbouring columns into one "line". Here a word
 * joins the line whose rightmost word it overlaps vertically, which also
 * follows gently skewed baselines. Lines are then split into runs wherever
 * the gap between words is much wider than a normal word space.
 */
export function segmentWords(words: readonly StyledWord[], opts: SegmentOptions = {}): SegmentedLine[] {
  const runGapFactor = opts.runGapFactor ?? 1.0;
  const medianHeight = medianOf(words.map((w) => w.bbox.height)) || 1;
  const kept = words.filter((w) => isPlausibleWord(w, medianHeight, opts.minConfidence)).sort((a, b) => a.bbox.x - b.bbox.x);

  const lines: StyledWord[][] = [];
  for (const word of kept) {
    let best: StyledWord[] | undefined;
    let bestOverlap = 0;
    for (const line of lines) {
      const last = line[line.length - 1];
      if (word.bbox.x < last.bbox.x + last.bbox.width * 0.5) continue;
      const minH = Math.min(word.bbox.height, last.bbox.height);
      const maxH = Math.max(word.bbox.height, last.bbox.height);
      if (maxH > minH * 2.2) continue;
      const overlap = verticalOverlap(word.bbox, last.bbox) / minH;
      const gap = word.bbox.x - (last.bbox.x + last.bbox.width);
      if (overlap >= 0.5 && gap < maxH * 12 && overlap > bestOverlap) {
        best = line;
        bestOverlap = overlap;
      }
    }
    if (best) best.push(word);
    else lines.push([word]);
  }

  // Stroke width is normalised by text size so headings aren't mistaken for
  // bold. Body-size lines use the page's body height (per-line glyph heights
  // are too noisy at low DPI); only clearly different sizes use their own.
  const tallHeights = (ws: StyledWord[]) => ws.filter((w) => w.style && hasTallGlyphs(w)).map((w) => w.style!.glyphHeight);
  const pageGlyphHeight = medianOf(tallHeights(lines.flat())) || medianHeight;
  const lineGlyphHeight = (lineWords: StyledWord[]) => {
    const lh = medianOf(tallHeights(lineWords));
    return lh && Math.abs(lh / pageGlyphHeight - 1) > 0.3 ? lh : pageGlyphHeight;
  };
  const weightSamples = lines.flatMap((lineWords) => {
    const lh = lineGlyphHeight(lineWords);
    return lineWords.map((w) => reliable(w)).filter((s) => s !== undefined).map((s) => s.strokeWidth / Math.max(1, lh));
  });
  opts.onWeightSamples?.(weightSamples, pageGlyphHeight);
  const weights = learnWeightModel(weightSamples);

  const result: SegmentedLine[] = lines.map((lineWords) => {
    const lineHeight = medianOf(lineWords.map((w) => w.bbox.height));
    const ctx: StyleContext = { weights, lineGlyphHeight: lineGlyphHeight(lineWords) };
    opts.onLineStyle?.({ words: lineWords.map((w) => w.text), ctx });
    const runs: SegmentedRun[] = [];
    let current: StyledWord[] = [];
    const flush = () => {
      if (current.length === 0) return;
      for (const group of splitByStyle(current, ctx, opts)) {
        runs.push({
          words: group,
          bbox: unionRects(group.map((w) => w.bbox)),
          text: group.map((w) => w.text).join(' '),
          confidence: Math.min(...group.map((w) => w.confidence)),
        });
      }
      current = [];
    };
    for (const w of lineWords) {
      const prev = current[current.length - 1];
      if (prev) {
        const gap = w.bbox.x - (prev.bbox.x + prev.bbox.width);
        const isolatedColon = /^[:;]$/.test(w.text) || /^[:;]$/.test(prev.text);
        if (gap > lineHeight * runGapFactor || (isolatedColon && gap > lineHeight * 0.6)) flush();
      }
      current.push(w);
    }
    flush();
    attachLeadingColons(runs, lineHeight);
    return { runs, bbox: unionRects(lineWords.map((w) => w.bbox)) };
  });

  // Reading order: top-to-bottom by line centre, then left-to-right.
  result.sort((a, b) => a.bbox.y + a.bbox.height / 2 - (b.bbox.y + b.bbox.height / 2));
  return result;
}
