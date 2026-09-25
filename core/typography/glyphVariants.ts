import type { RenderParams } from '../document/model';
import { createMask, distanceToBackground } from '../image/filters';
import type { TextRasterizer } from '../rendering/textRasterizer';
import { clusters } from '../text/script';
import { labelComponents } from '../vision/components';
import type { CandidateEvaluator } from './fit';
import { getFont } from './fontCatalog';
import type { RegionAnalysis } from './regionAnalysis';

/**
 * Characters whose design varies between otherwise similar fonts: "1" with
 * or without a foot, open or closed "4", flat or curved "3" top, one- or
 * two-storey "a" and "g", "l" with or without a tail, "t"/"y" terminals,
 * serifed "I" and "J" in sans fonts. Numbers are what gets edited most, so
 * every digit is included.
 */
export const VARIANT_GLYPHS: ReadonlySet<string> = new Set('0123456789agltyIJQGR');

/** Relative local-error improvement a donor glyph must bring to replace the font's own. */
const MIN_GAIN = 0.12;
/**
 * Two designs of a character count as structurally different when one has
 * parts the other lacks: more than this fraction of either glyph's ink lies
 * farther than STRUCTURE_TOLERANCE (of the glyph size) from the other's ink.
 * Measured at 64 px: "1" with vs without foot 0.14–0.26, one- vs two-storey
 * "g" 0.06–0.10; same-structure pairs (Roboto/Lato "2", Carlito/Lato "1",
 * Tinos/PT Serif "1", Roboto/Open Sans "l") 0.00–0.04. Only structural
 * variants are worth swapping; otherwise a lower error just means the donor
 * absorbs the fit's residual size or weight error.
 */
const STRUCTURE_THRESHOLD = 0.05;
const STRUCTURE_TOLERANCE = 0.055;

const structureCache = new Map<string, number>();

/** Structural difference (0..1) of a character in two fonts, donor scaled and placed as the renderer does. */
export function glyphStructureDifference(rasterizer: TextRasterizer, fontId: string, weight: number, ch: string, donorId: string): number {
  const key = `${fontId}/${weight}/${donorId}/${ch}`;
  const cached = structureCache.get(key);
  if (cached !== undefined) return cached;
  const size = 64;
  const p = { fontId, weight, italic: false, fontSize: size, scaleX: 1, letterSpacing: 0, wordSpacing: 0, skewX: 0, embolden: 0, originX: size * 0.3, baselineY: size * 1.2 };
  const w = Math.ceil(size * 1.8);
  const h = Math.ceil(size * 1.6);
  const a = rasterizer.coverage(ch, p, w, h).data.slice();
  const b = rasterizer.coverage(ch, { ...p, glyphFonts: { [ch]: donorId } }, w, h).data;
  /** Fraction of x's ink farther than the tolerance from y's ink. */
  const farFraction = (x: Float32Array, y: Float32Array) => {
    const notY = createMask(w, h);
    for (let i = 0; i < y.length; i++) notY.data[i] = y[i] >= 0.5 ? 0 : 1;
    const dist = distanceToBackground(notY);
    let ink = 0;
    let far = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < 0.5) continue;
      ink++;
      if (dist[i] > size * STRUCTURE_TOLERANCE) far++;
    }
    return ink ? far / ink : 0;
  };
  const diff = Math.max(farFraction(a, b), farFraction(b, a));
  if (structureCache.size > 2000) structureCache.clear();
  structureCache.set(key, diff);
  return diff;
}

/**
 * Glyph variants from the scan: for every variant-prone character in the
 * analysed text, compare the fitted font's own glyph with the same character
 * from other plausible fonts (scaled into the same ink box) on the pixels of
 * that character only: a foot under "1" is a small part of a whole line, but
 * a large part of the "1". Only donors whose glyph is structurally
 * different are considered (see STRUCTURE_THRESHOLD). Each contender, the font's own glyph included,
 * first gets a small local alignment (position, size), so the comparison is
 * about shape and not about the fit's residual placement error. A donor is
 * kept only when it clearly fits better.
 *
 * Characters without evidence in the scan fall back to the fitted font's
 * `glyphDefaults` (known differences between a stand-in and the originals it
 * resembles), so a "1" typed into an Arial number never grows Arimo's foot.
 */
export function chooseGlyphFonts(
  evaluator: CandidateEvaluator,
  rasterizer: TextRasterizer,
  params: RenderParams,
  text: string,
  donors: readonly string[],
): Record<string, string> | undefined {
  const font = getFont(params.fontId);
  const parts = clusters(text);
  const chosen: Record<string, string> = {};
  const pad = Math.max(1, params.blur * 2);

  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const ch = parts[i];
    if (!VARIANT_GLYPHS.has(ch) || seen.has(ch)) continue;
    seen.add(ch);
    const x0 = params.originX + rasterizer.measure(parts.slice(0, i).join(''), params);
    const x1 = params.originX + rasterizer.measure(parts.slice(0, i + 1).join(''), params);
    const columns: [number, number][] = [[x0 - pad, x1 + pad]];
    const score = (id: string) => alignedError(evaluator, { ...params, glyphFonts: { [ch]: id } }, x0, columns);
    const base = score(params.fontId);
    let best = { id: params.fontId, error: base };
    for (const id of donors) {
      if (id === params.fontId || glyphStructureDifference(rasterizer, params.fontId, params.weight, ch, id) < STRUCTURE_THRESHOLD) continue;
      const e = score(id);
      if (e < best.error) best = { id, error: e };
    }
    if (best.id !== params.fontId && best.error < base * (1 - MIN_GAIN)) chosen[ch] = best.id;
    // Evidence for the font's own glyph overrides a catalogue default.
    else if (font.glyphDefaults?.[ch]) chosen[ch] = params.fontId;
  }
  for (const [ch, id] of Object.entries(font.glyphDefaults ?? {})) if (!(ch in chosen)) chosen[ch] = id;
  return Object.keys(chosen).length ? chosen : undefined;
}

/**
 * Local error of one glyph after a small coordinate descent over its offset
 * and size (size scaled about the glyph's pen position `anchor`, so the
 * glyph stays in place).
 */
function alignedError(evaluator: CandidateEvaluator, p: RenderParams, anchor: number, columns: [number, number][]): number {
  const h = evaluator.textHeight;
  const steps = { dx: Math.max(0.5, h * 0.03), dy: Math.max(0.5, h * 0.03), s: 0.03 };
  let cur = { dx: 0, dy: 0, s: 1 };
  const at = (o: typeof cur) =>
    evaluator.errorIn(
      { ...p, fontSize: p.fontSize * o.s, originX: anchor - (anchor - p.originX) * o.s + o.dx, baselineY: p.baselineY + o.dy },
      p.color,
      columns,
    );
  let best = at(cur);
  for (let round = 0; round < 2; round++) {
    let improved = true;
    for (let it = 0; improved && it < 6; it++) {
      improved = false;
      for (const k of ['dx', 'dy', 's'] as const) {
        for (const dir of [1, -1]) {
          const next = { ...cur, [k]: cur[k] + dir * steps[k] };
          const e = at(next);
          if (e < best - 1e-6) {
            best = e;
            cur = next;
            improved = true;
            break;
          }
        }
      }
    }
    steps.dx /= 2;
    steps.dy /= 2;
    steps.s /= 2;
  }
  return best;
}

/**
 * Donor fonts for glyph variants: the best-ranked distinct fonts of the same
 * category (a sans "1" for a sans font), plus the fitted font's default donors.
 */
export function variantDonors(rankedFontIds: readonly string[], fontId: string, limit = 4): string[] {
  const font = getFont(fontId);
  const out: string[] = [];
  for (const id of rankedFontIds) {
    if (id === fontId || out.includes(id)) continue;
    const f = getFont(id);
    if (f.category !== font.category) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  for (const id of Object.values(font.glyphDefaults ?? {})) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * How irregular the baseline is: median absolute deviation of the bottoms of
 * full-height glyphs from their median, relative to the text height. Print
 * sits on a ruler-straight baseline (≈0.01, from round-letter overshoot);
 * handwriting wanders (typically 0.04–0.12).
 */
export function baselineWobble(region: RegionAnalysis): number {
  const { components } = labelComponents(region.ink);
  const h = region.metrics.height;
  const bottoms = components
    .filter((c) => c.y1 - c.y0 >= h * 0.4 && c.area >= 4 && c.y1 <= region.metrics.baseline + h * 0.2)
    .map((c) => c.y1)
    .sort((a, b) => a - b);
  if (bottoms.length < 3) return 0;
  const med = bottoms[bottoms.length >> 1];
  const dev = bottoms.map((b) => Math.abs(b - med)).sort((a, b) => a - b);
  return dev[dev.length >> 1] / Math.max(1, h);
}

/**
 * Natural-variation amount for replacement handwriting, from the measured
 * wobble. Calibrated on synthetic handwriting: jitter j yields a wobble of
 * about 0.055·j for Latin hands (0.10·j for Devanagari, whose headline
 * adds variation); the Latin slope is used, capped at 1.
 */
export function jitterFromWobble(wobble: number): number {
  return Math.round(Math.max(0.15, Math.min(1, wobble / 0.055)) * 100) / 100;
}
