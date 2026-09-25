import type { LayoutLine, PageLayout, TextElement } from '../document/model';
import { orientedFromAxisAligned, unionRects, type Rect } from '../geometry';
import { createMask, median, percentile } from '../image/filters';
import { createRaster, luminance, type RasterImage } from '../image/raster';
import { sauvola } from '../vision/binarize';
import { labelComponents } from '../vision/components';
import { normalizeIllumination } from '../vision/preprocess';
import { detectRules } from '../vision/rules';
import { strokeWidth } from '../typography/inkMetrics';
import { scriptsOf } from '../text/script';

/**
 * Second reading for handwriting. Tesseract (trained on print) turns a
 * handwritten entry into low-confidence fragments ("Va", "m", "."), often
 * split across several elements of one line. Those fragments are grouped
 * back into line crops for a handwriting recogniser, and a credible reading
 * replaces them with one element flagged for the user to check.
 */

export interface HandwritingGroup {
  elementIds: string[];
  /** Page-pixel crop around the group (text box plus margin). */
  rect: Rect;
}

export interface HandwritingReading {
  text: string;
  /** 0..1 */
  confidence: number;
}

/** Page-OCR confidence below which a run may be handwriting (print is read at 80–95). */
const SUSPECT_BELOW = 70;
/**
 * Recogniser confidence needed to use a reading. Automatic mode would rather
 * miss a field than invent one: the user can still ask for a reading of any
 * selected text ("Read as handwriting").
 */
const ACCEPT_ABOVE = 0.45;
/** Page-OCR confidence (%) above which an element's text is kept as read. */
const KEEP_CONFIDENT = 85;

/** A handwritten line ready for the recogniser: an ink-only crop (the line's own strokes on white). */
export interface HandwritingLine extends HandwritingGroup {
  image: RasterImage;
}

/**
 * Find handwritten lines from the ink, not from Tesseract's fragments,
 * whose boxes cut handwritten words in half or span rows, and cut each one
 * out as an *ink-only* crop: only the line's own glyph strokes, painted on
 * white. That removes, in one step, everything that confuses a recogniser
 * trained on clean scans: photo background and shadows, table borders,
 * dotted leader lines, printed labels next to the entry.
 *
 *   1. Flatten the lighting, binarise, drop ruling lines.
 *   2. Keep glyph-like components: not specks, not dots of leader lines
 *      (small, round and solid), not paper texture.
 *   3. Group them into lines (vertical overlap, at most a word gap).
 *   4. Skip lines already read confidently (printed text) and lines hanging
 *      from a Devanagari headline (printed labels the English model can't read).
 */
export function findHandwritingLines(page: RasterImage, elements: readonly TextElement[]): HandwritingLine[] {
  const flat = normalizeIllumination(page);
  const ink = sauvola(flat, { radius: 24, k: 0.2, minContrast: 30 });
  // Reference glyph height from glyph-like components: dotted leader lines contribute hundreds of tiny dots.
  const glyphish = labelComponents(ink).components.filter((c) => c.area >= 30 && c.area / Math.max(1, (c.x1 - c.x0) * (c.y1 - c.y0)) < 0.6);
  const h0 = glyphish.length ? median(glyphish.map((c) => c.y1 - c.y0)) : 20;
  const rules = detectRules(ink, Math.max(40, Math.round(h0 * 6)), 2, Math.max(40, Math.round(h0 * 4)));
  const clean = createMask(ink.width, ink.height);
  for (let i = 0; i < clean.data.length; i++) clean.data[i] = ink.data[i] && !rules.data[i] ? 1 : 0;
  const labels = labelComponents(clean);
  // Print read with confidence. Tesseract also gives single handwritten letters high scores ("a" at 95), so one-letter readings don't count.
  const confident = elements.filter((e) => e.ocrConfidence >= SUSPECT_BELOW && e.recognizer !== 'handwriting' && e.sourceText.replace(/[^\p{L}\p{N}]/gu, '').length >= 2);
  const comps = labels.components.filter((c) => {
    const ch = c.y1 - c.y0;
    const cw = c.x1 - c.x0;
    const fill = c.area / Math.max(1, cw * ch);
    // Leader-line dots (small, round, solid) and blobs (shadows, smudges): large solid shapes aren't pen strokes.
    const dot = cw <= ch * 1.6 && fill >= 0.62 && ch <= h0 * 0.6;
    const blob = (fill >= 0.72 && cw * ch >= (h0 * 1.5) ** 2) || (fill >= 0.5 && cw * ch >= (h0 * 3) ** 2);
    const box = { x: c.x0, y: c.y0, width: cw, height: ch };
    const why = dot ? 'dot' : blob ? 'blob' : c.area < 20 || ch < h0 * 0.3 || ch > h0 * 5 || cw > page.width * 0.4 || fill < 0.08 ? 'size' : confident.some((e) => overlap(box, e.bbox) >= cw * ch * 0.5) ? 'confident' : cw >= ch * 1.5 && hangsFromHeadline(ink, box, 0.85) ? 'headline' : '';
    return !why;
  });
  const lines = groupIntoLines(comps, rules);
  const lum = luminance(page).data;
  const paper = percentile(sampleEvery(lum, 97), 90);
  const out: HandwritingLine[] = [];
  for (const line of lines) {
    const box = line.rect;
    if (box.width < box.height * 1.2 || line.comps.length === 0) continue;
    // On the paper, not the desk or a shadow beside it: the background around the strokes must be paper-bright.
    if (backgroundLevel(lum, page.width, box) < paper * 0.72) continue;
    // Paper texture and photo background: speckle, not strokes. Real writing has most ink in tall components.
    const tallInk = line.comps.filter((c) => c.y1 - c.y0 >= box.height * 0.35).reduce((a, c) => a + c.area, 0);
    if (tallInk < line.comps.reduce((a, c) => a + c.area, 0) * 0.6) continue;
    // Already read as print?
    const covered = confident.reduce((a, e) => a + overlap(box, e.bbox), 0);
    if (covered >= box.width * box.height * 0.35) continue;
    if (hangsFromHeadline(ink, box)) continue;
    // Pen strokes are thin for their height; bold print, table ornaments and stamps are not.
    if (lineStroke(clean, labels.labels, line.comps) > box.height * 0.2) continue;
    const suspects = elements.filter((e) => e.ocrConfidence < SUSPECT_BELOW && overlap(box, e.bbox) >= e.bbox.width * e.bbox.height * 0.5);
    const rect = cropRect(box, page);
    out.push({ elementIds: suspects.map((e) => e.id), rect, image: inkOnly(flat, labels.labels, new Set(line.comps.map((c) => c.label)), rect) });
  }
  return out;
}

/** The line's own strokes (with a 1 px anti-aliasing margin) on white; everything else is blanked. */
function inkOnly(flat: { width: number; data: Float32Array }, labels: Int32Array, own: ReadonlySet<number>, r: Rect): RasterImage {
  const x0 = Math.floor(r.x);
  const y0 = Math.floor(r.y);
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  const W = flat.width;
  const out = createRaster(w, h, [255, 255, 255, 255]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mine = false;
      for (let dy = -1; dy <= 1 && !mine; dy++) {
        for (let dx = -1; dx <= 1 && !mine; dx++) {
          const yy = y0 + y + dy;
          const xx = x0 + x + dx;
          if (yy >= 0 && xx >= 0 && xx < W && yy * W + xx < labels.length) mine = own.has(labels[yy * W + xx]);
        }
      }
      if (!mine) continue;
      const v = flat.data[(y0 + y) * W + x0 + x];
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
    }
  }
  return out;
}

/** Printed Devanagari/Bengali labels: most of the line's width hangs from a headline stroke in its top part. */
function hangsFromHeadline(ink: { width: number; data: Uint8Array }, r: Rect, share = 0.45): boolean {
  const W = ink.width;
  let best = 0;
  for (let y = Math.floor(r.y); y < r.y + r.height * 0.45; y++) {
    let run = 0;
    let longest = 0;
    for (let x = Math.floor(r.x); x < r.x + r.width; x++) {
      if (ink.data[y * W + x]) longest = Math.max(longest, ++run);
      else run = 0;
    }
    best = Math.max(best, longest);
  }
  return best >= r.width * share;
}

/**
 * Is a reading plausible for its crop? Recognisers trained on text
 * hallucinate on junk: repeated tokens ("000 000 000 …") or far more
 * characters than a line of this width can hold.
 */
export function plausibleReading(text: string, rect: Rect): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  if ([...counts.values()].some((n) => n >= 3)) return false;
  // One letter repeated ("mm", "iii"): ruled-paper texture, not writing.
  const alnum = text.replace(/[^\p{L}\p{N}]/gu, '');
  if (alnum.length >= 2 && /^(.)\1+$/u.test(alnum.toLowerCase())) return false;
  // Handwriting holds at most ~2.5 characters per line-height of width.
  return text.replace(/\s/g, '').length <= Math.max(3, (rect.width / Math.max(1, rect.height)) * 2.5);
}

type Comp = { label: number; x0: number; y0: number; x1: number; y1: number; area: number };

function groupIntoLines(comps: Comp[], rules: { width: number; data: Uint8Array }): { rect: Rect; comps: Comp[] }[] {
  const sorted = [...comps].sort((a, b) => a.x0 - b.x0);
  const lines: { x0: number; y0: number; x1: number; y1: number; h: number; comps: Comp[] }[] = [];
  for (const c of sorted) {
    const ch = c.y1 - c.y0;
    let best: (typeof lines)[number] | undefined;
    let bestOverlap = 0;
    for (const l of lines) {
      const ov = Math.min(l.y1, c.y1) - Math.max(l.y0, c.y0);
      const gap = c.x0 - l.x1;
      const h = Math.min(l.h, ch);
      // Up to ~2.5 heights: handwriting spaces words widely; table columns are further apart.
      if (ov >= h * 0.4 && gap <= Math.max(l.h, ch) * 2.5 && gap >= -Math.max(l.h, ch) && ov > bestOverlap && !ruleBetween(rules, l.x1, c.x0, Math.max(l.y0, c.y0), Math.min(l.y1, c.y1))) {
        best = l;
        bestOverlap = ov;
      }
    }
    if (best) {
      best.x0 = Math.min(best.x0, c.x0);
      best.x1 = Math.max(best.x1, c.x1);
      best.y0 = Math.min(best.y0, c.y0);
      best.y1 = Math.max(best.y1, c.y1);
      best.h = Math.max(best.h * 0.8 + ch * 0.2, Math.min(best.h, ch));
      best.comps.push(c);
    } else lines.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, h: ch, comps: [c] });
  }
  return lines.map((l) => ({ rect: { x: l.x0, y: l.y0, width: l.x1 - l.x0, height: l.y1 - l.y0 }, comps: l.comps }));
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function cropRect(box: Rect, page: { width: number; height: number }): Rect {
  const my = box.height * 0.15;
  const mx = box.height * 0.3;
  const x = Math.max(0, box.x - mx);
  const y = Math.max(0, box.y - my);
  return { x, y, width: Math.min(page.width, box.x + box.width + mx) - x, height: Math.min(page.height, box.y + box.height + my) - y };
}

/**
 * Is a reading good enough to use without the user asking? Measured on real
 * forms: numbers read by digit-constrained decoding score 0.27–0.99 (their
 * score is taken under the unconstrained model); words need ≥ 0.45, and
 * short words ≥ 0.6, which keeps signatures and ornaments ("Gas", "an") out.
 */
export function acceptReading(r: HandwritingReading, rect: Rect): boolean {
  if (!plausibleReading(r.text, rect)) return false;
  const alnum = r.text.replace(/[^\p{L}\p{N}]/gu, '');
  if (!alnum) return false;
  if (/^[\d\s/\-.,:]+$/.test(r.text)) return r.confidence >= 0.25 && (alnum.length >= 2 || r.confidence >= 0.8);
  // One or two letters are almost always a stray mark or ruling, not an entry.
  if (alnum.length < 3) return false;
  if (alnum.length < 5) return r.confidence >= 0.6;
  return r.confidence >= ACCEPT_ABOVE;
}

/** Replace each group's fragments with one element holding the recogniser's reading, when credible. */
export function applyHandwritingReadings(
  content: { textElements: TextElement[]; layout: PageLayout },
  groups: readonly HandwritingGroup[],
  readings: readonly (HandwritingReading | undefined)[],
  skew: number,
  pageId: string,
): { textElements: TextElement[]; layout: PageLayout } {
  const replace = new Map<string, TextElement>();
  const drop = new Set<string>();
  const added: string[] = [];
  groups.forEach((g, i) => {
    const r = readings[i];
    if (!r || !acceptReading(r, g.rect)) return;
    const els = g.elementIds.map((id) => content.textElements.find((e) => e.id === id)!).filter(Boolean);
    // The model reads English: never replace text the page OCR read in another script.
    if (els.some((e) => [...scriptsOf(e.sourceText)].some((sc) => sc !== 'latin'))) return;
    // New text only where the page OCR found none: elsewhere it would duplicate a line read as part of another element.
    if (!els.length) {
      const box = shrink(g.rect);
      const covered = content.textElements.reduce((n, e) => n + overlap(e.bbox, box), 0);
      if (covered > box.width * box.height * 0.3) return;
    }
    // Print the page OCR read confidently is not handwriting: keep it (the model would paraphrase it).
    if (els.some((e) => e.ocrConfidence >= KEEP_CONFIDENT && e.sourceText.replace(/[^\p{L}\p{N}]/gu, '').length >= 3)) return;
    // Same text as the page OCR: nothing to fix, and its (often higher) confidence stays.
    const squash = (t: string) => t.replace(/\s+/g, '').toLowerCase();
    if (els.length && squash(els.map((e) => e.sourceText).join('')) === squash(r.text)) return;
    const inner = { x: g.rect.x, y: g.rect.y, width: g.rect.width, height: g.rect.height };
    const bbox = els.length ? unionRects([...els.map((e) => e.bbox), shrink(inner)]) : shrink(inner);
    // Text Tesseract missed completely becomes a new element on its own line (ids from its position: lines arrive one by one).
    const key = `${Math.round(g.rect.x)}-${Math.round(g.rect.y)}`;
    const first: TextElement = els[0] ?? {
      id: `${pageId}-hw${key}`,
      pageId,
      sourceText: '',
      text: '',
      bbox,
      box: orientedFromAxisAligned(bbox, skew),
      ocrConfidence: 0,
      readingOrder: content.textElements.length + i,
      lineId: `${pageId}-hwl${key}`,
      words: [],
      state: 'original',
      alignment: 'left',
    };
    if (!els.length) added.push(first.id);
    const confidence = Math.min(75, Math.round(r.confidence * 100));
    replace.set(first.id, {
      ...first,
      sourceText: r.text,
      text: r.text,
      bbox,
      box: orientedFromAxisAligned(bbox, skew),
      ocrConfidence: confidence,
      words: [{ text: r.text, bbox, confidence }],
      // Per-word styles were measured on the fragments; the element is re-measured when analysed.
      visualStyle: first.visualStyle,
      recognizer: 'handwriting',
    });
    for (const e of els.slice(1)) drop.add(e.id);
  });
  if (!replace.size) return content;
  const textElements = [...content.textElements.filter((e) => !drop.has(e.id)).map((e) => replace.get(e.id) ?? e), ...added.map((id) => replace.get(id)!)];
  const lines: LayoutLine[] = [
    ...content.layout.lines.map((l) => ({ ...l, elementIds: l.elementIds.filter((id) => !drop.has(id)) })),
    ...added.map((id) => ({ id: replace.get(id)!.lineId, elementIds: [id], bbox: replace.get(id)!.bbox })),
  ];
  return { textElements, layout: { ...content.layout, lines } };
}

/** The text box inside a crop rect (undo cropRect's margins). */
function shrink(r: Rect): Rect {
  const h = r.height / 1.3;
  const my = h * 0.15;
  const mx = h * 0.3;
  return { x: r.x + mx, y: r.y + my, width: Math.max(1, r.width - 2 * mx), height: Math.max(1, r.height - 2 * my) };
}

/** A table column rule between two components keeps their text apart (separate cells). */
function ruleBetween(rules: { width: number; data: Uint8Array }, xa: number, xb: number, ya: number, yb: number): boolean {
  const W = rules.width;
  for (let x = Math.min(xa, xb); x < Math.max(xa, xb); x++) {
    let run = 0;
    for (let y = ya; y < yb; y++) {
      if (rules.data[y * W + x]) {
        if (++run >= Math.max(3, (yb - ya) * 0.6)) return true;
      } else run = 0;
    }
  }
  return false;
}

function sampleEvery(data: ArrayLike<number>, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += step) out.push(data[i]);
  return out;
}

/** Brightness of the paper around a line: the 80th percentile of its box (strokes are the dark minority). */
function backgroundLevel(lum: ArrayLike<number>, w: number, r: Rect): number {
  const v: number[] = [];
  for (let y = Math.floor(r.y); y < r.y + r.height; y += 2) for (let x = Math.floor(r.x); x < r.x + r.width; x += 2) v.push(lum[y * w + x]);
  return v.length ? percentile(v, 80) : 0;
}

/** Typical stroke width of a line's own components (distance transform ridge). */
function lineStroke(mask: { width: number; height: number; data: Uint8Array }, labels: Int32Array, comps: readonly Comp[]): number {
  const own = new Set(comps.map((c) => c.label));
  const x0 = Math.min(...comps.map((c) => c.x0));
  const y0 = Math.min(...comps.map((c) => c.y0));
  const w = Math.max(...comps.map((c) => c.x1)) - x0;
  const h = Math.max(...comps.map((c) => c.y1)) - y0;
  const m = createMask(w + 2, h + 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (own.has(labels[(y0 + y) * mask.width + x0 + x])) m.data[(y + 1) * m.width + x + 1] = 1;
  return strokeWidth(m);
}
