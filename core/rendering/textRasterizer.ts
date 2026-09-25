import type { GlyphSample, RenderParams } from '../document/model';
import { gaussianBlur } from '../image/filters';
import type { GrayImage } from '../image/raster';
import { clusters, hasConnectedScript, hasRtl, textDirection } from '../text/script';
import { hasFont } from '../typography/fontCatalog';
import { cssFont, facesFor, nearestWeight, type FaceRef } from '../typography/fontFaces';
import { decodeBase64 } from '../utils/base64';
import { hashString } from '../utils/random';
import { applyHandwritingVariation } from './handwriting';

/**
 * Minimal 2D context surface we rely on. Both DOM/OffscreenCanvas contexts and
 * @napi-rs/canvas satisfy it structurally, which keeps the core usable in
 * browsers, workers and Node tests.
 */
export interface Ctx2D {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  textBaseline: string;
  textAlign: string;
  direction?: string;
  measureText(text: string): TextMetricsLike;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export interface TextMetricsLike {
  width: number;
  actualBoundingBoxLeft?: number;
  actualBoundingBoxRight?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export type GlyphParams = Pick<
  RenderParams,
  'fontId' | 'weight' | 'italic' | 'fontSize' | 'scaleX' | 'letterSpacing' | 'wordSpacing' | 'skewX' | 'embolden' | 'originX' | 'baselineY' | 'glyphFonts' | 'glyphSamples'
>;

export interface TextRasterizer {
  /** Pen advance of `text` in local px (after scaleX / spacing). */
  measure(text: string, p: GlyphParams): number;
  /** Anti-aliased glyph coverage 0..1 on a width x height surface (no blur/opacity). Characters drawn from writer samples are left out. */
  coverage(text: string, p: GlyphParams, width: number, height: number): GrayImage;
  /** Coverage of the characters drawn from the writer's own samples (already carrying the scan's optics), if any. */
  sampleCoverage?(text: string, p: GlyphParams, width: number, height: number): GrayImage | undefined;
}

/** Where the handwriting variation field is anchored: a per-element seed and this surface's offset in the element frame. */
export interface VariationAnchor {
  seed: number;
  x: number;
  y: number;
}

/**
 * Full rasterisation: glyph coverage, handwriting variation, optics blur,
 * writer samples and opacity. The variation field differs between elements
 * (seed) and is fixed in each element's frame, so editing one character
 * leaves the others as they were.
 */
export function renderCoverage(r: TextRasterizer, text: string, p: RenderParams, width: number, height: number, anchor: VariationAnchor = { seed: 0, x: 0, y: 0 }): GrayImage {
  let cov = r.coverage(text, p, width, height);
  if (p.jitter && p.jitter > 0) cov = applyHandwritingVariation(cov, p, anchor);
  const blurred = gaussianBlur(cov, p.blur);
  const samples = r.sampleCoverage?.(text, p, width, height);
  if (samples) for (let i = 0; i < blurred.data.length; i++) blurred.data[i] = Math.max(blurred.data[i], samples.data[i]);
  if (p.opacity !== 1) for (let i = 0; i < blurred.data.length; i++) blurred.data[i] *= p.opacity;
  return blurred;
}

/** Ink box of one glyph relative to its pen position (y up = ascent). */
interface InkBox {
  advance: number;
  left: number;
  right: number;
  ascent: number;
  descent: number;
}

export interface RasterizerOptions {
  /**
   * Called with the font files a text needs before it is measured or drawn.
   * Node registers them synchronously; the browser worker loads them ahead
   * of time (see lib/browser/fonts.ts), so it can leave this out.
   */
  ensureFaces?(faces: FaceRef[]): void;
}

/** Active glyph substitutions for this text (ignores entries that name the font itself or unknown fonts). */
function activeSubstitutions(p: GlyphParams): Record<string, string> | undefined {
  if (!p.glyphFonts) return undefined;
  let out: Record<string, string> | undefined;
  for (const [ch, id] of Object.entries(p.glyphFonts)) {
    if (id === p.fontId || !hasFont(id)) continue;
    (out ??= {})[ch] = id;
  }
  return out;
}

/**
 * Text that must be drawn as one shaped run: right-to-left text (visual
 * order differs from logical order, so logical prefix positions are wrong)
 * and joined scripts like Arabic (drawing letters apart breaks the joins).
 */
function wholeRunOnly(text: string): boolean {
  return hasRtl(text) || (hasConnectedScript(text) && /\p{Script=Arabic}/u.test(text));
}

/** Which writer sample each cluster uses: varied, deterministic, never the same instance twice in a row. */
export function sampleChoice(parts: readonly string[], samples: Record<string, GlyphSample[]> | undefined): (GlyphSample | undefined)[] {
  const lastUsed = new Map<string, number>();
  return parts.map((ch, i) => {
    const list = samples?.[ch];
    if (!list?.length) return undefined;
    let k = hashString(`${i}:${ch}`) % list.length;
    if (list.length > 1 && lastUsed.get(ch) === k) k = (k + 1) % list.length;
    lastUsed.set(ch, k);
    return list[k];
  });
}

/**
 * Canvas implementation. Glyphs are placed per cluster from prefix
 * measurements, so kerning and complex-script shaping (Devanagari conjuncts,
 * reordered vowel signs) are kept while letter/word spacing stay exact and
 * independent of `ctx.letterSpacing` support (missing in some browsers).
 */
export class CanvasTextRasterizer implements TextRasterizer {
  private canvas: CanvasLike | undefined;
  private ctx: Ctx2D | undefined;
  private readonly prefixCache = new Map<string, number[]>();
  private readonly inkCache = new Map<string, InkBox | null>();
  private readonly ensured = new Set<string>();
  private readonly sampleBitmaps = new WeakMap<GlyphSample, Uint8Array>();

  constructor(
    private readonly factory: CanvasFactory,
    private readonly options: RasterizerOptions = {},
  ) {}

  private surface(width: number, height: number): Ctx2D {
    if (!this.canvas || this.canvas.width < width || this.canvas.height < height) {
      this.canvas = this.factory(Math.max(width, this.canvas?.width ?? 0), Math.max(height, this.canvas?.height ?? 0));
      this.ctx = this.canvas.getContext('2d') as Ctx2D;
    }
    return this.ctx!;
  }

  /** Font string for `text`, making sure its files are available first. */
  private font(fontId: string, weight: number, italic: boolean, size: number, text: string): string {
    const ensure = this.options.ensureFaces;
    if (ensure) {
      const key = `${fontId}\u0000${text}`;
      if (!this.ensured.has(key)) {
        ensure(facesFor([fontId], text));
        if (this.ensured.size > 5000) this.ensured.clear();
        this.ensured.add(key);
      }
    }
    return cssFont(fontId, nearestWeight(fontId, weight), italic, size, text);
  }

  /** Natural (unscaled) advance of each prefix of the clusters, i = 0..n. */
  private prefixes(parts: string[], font: string): number[] {
    const key = `${font}\u0000${parts.join('')}`;
    const cached = this.prefixCache.get(key);
    if (cached) return cached;
    const ctx = this.surface(8, 8);
    ctx.font = font;
    const out = [0];
    let acc = '';
    for (const part of parts) {
      acc += part;
      out.push(ctx.measureText(acc).width);
    }
    if (this.prefixCache.size > 5000) this.prefixCache.clear();
    this.prefixCache.set(key, out);
    return out;
  }

  /** Ink extent of a single glyph cluster in a CSS font, or null when the runtime can't report it. */
  private inkBox(cluster: string, font: string): InkBox | null {
    const key = `${font}\u0000${cluster}`;
    const cached = this.inkCache.get(key);
    if (cached !== undefined) return cached;
    const ctx = this.surface(8, 8);
    ctx.font = font;
    const m = ctx.measureText(cluster);
    const box =
      m.actualBoundingBoxAscent === undefined || m.actualBoundingBoxRight === undefined
        ? null
        : { advance: m.width, left: m.actualBoundingBoxLeft ?? 0, right: m.actualBoundingBoxRight, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent ?? 0 };
    if (this.inkCache.size > 5000) this.inkCache.clear();
    this.inkCache.set(key, box);
    return box;
  }

  private glyphPositions(text: string, p: GlyphParams): { parts: string[]; xs: number[]; end: number; font: string } {
    const font = this.font(p.fontId, p.weight, p.italic, p.fontSize, text);
    const parts = clusters(text);
    const pre = this.prefixes(parts, font);
    if (wholeRunOnly(text)) {
      // One shaped run: spacing adjustments are not applied (they would break joins or bidi order).
      const end = p.originX + pre[parts.length] * p.scaleX;
      return { parts, xs: parts.map(() => p.originX), end, font };
    }
    const xs: number[] = [];
    let spaces = 0;
    for (let i = 0; i < parts.length; i++) {
      xs.push(p.originX + pre[i] * p.scaleX + i * p.letterSpacing + spaces * p.wordSpacing);
      if (parts[i] === ' ') spaces++;
    }
    const end = p.originX + pre[parts.length] * p.scaleX + parts.length * p.letterSpacing + spaces * p.wordSpacing;
    return { parts, xs, end, font };
  }

  measure(text: string, p: GlyphParams): number {
    return this.glyphPositions(text, p).end - p.originX;
  }

  coverage(text: string, p: GlyphParams, width: number, height: number): GrayImage {
    const { parts, xs, font: mainFont } = this.glyphPositions(text, p);
    const ctx = this.surface(width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.direction = textDirection(text);
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineJoin = 'round';
    ctx.lineWidth = p.embolden / Math.max(0.2, p.scaleX);

    /** Draw `s` with its pen at local x, offset (dx, dy) in font units: x' = scaleX·u − skewX·v + x ; y' = v + baseline. */
    const draw = (s: string, x: number, font: string, dx = 0, dy = 0) => {
      ctx.font = font;
      ctx.setTransform(p.scaleX, 0, -p.skewX, 1, x + p.scaleX * dx - p.skewX * dy, dy + p.baselineY);
      ctx.fillText(s, 0, 0);
      if (p.embolden > 0.01) ctx.strokeText(s, 0, 0);
    };

    /**
     * A glyph drawn from a donor font: scaled to the main font's ink height
     * of the same character and centred in its advance. Fonts centre glyphs
     * in their advance by design, whereas the ink box moves with the very
     * details that differ (a foot widens a "1" to both sides).
     */
    const drawSubstitute = (s: string, x: number, donorId: string) => {
      const main = this.inkBox(s, mainFont);
      const donorWeight = nearestWeight(donorId, p.weight);
      const donor = this.inkBox(s, this.font(donorId, donorWeight, p.italic, p.fontSize, s));
      if (!main || !donor || donor.ascent + donor.descent <= 0) {
        draw(s, x, mainFont);
        return;
      }
      const k = (main.ascent + main.descent) / (donor.ascent + donor.descent);
      // Same ink bottom as the main glyph (baseline sitters stay on the baseline, descenders reach as deep).
      draw(s, x, this.font(donorId, donorWeight, p.italic, p.fontSize * k, s), main.advance / 2 - (donor.advance / 2) * k, main.descent - donor.descent * k);
    };

    const whole = wholeRunOnly(text);
    const subs = whole ? undefined : activeSubstitutions(p);
    const sampled = whole ? [] : sampleChoice(parts, p.glyphSamples);
    const anySample = sampled.some(Boolean);
    const spaced = !whole && (p.letterSpacing !== 0 || p.wordSpacing !== 0);

    if (!spaced && !subs && !anySample) {
      draw(text, p.originX, mainFont);
    } else if (!spaced) {
      // Runs of the main font keep their kerning; substituted glyphs are drawn one by one, sampled ones are left out.
      let start = 0;
      for (let i = 0; i <= parts.length; i++) {
        const special = i < parts.length && (sampled[i] || subs?.[parts[i]]);
        if (i < parts.length && !special) continue;
        if (i > start) draw(parts.slice(start, i).join(''), xs[start], mainFont);
        if (i < parts.length && !sampled[i]) drawSubstitute(parts[i], xs[i], subs![parts[i]]);
        start = i + 1;
      }
    } else {
      for (let i = 0; i < parts.length; i++) {
        const s = parts[i];
        if (s === ' ' || sampled[i]) continue;
        const donor = subs?.[s];
        if (donor) drawSubstitute(s, xs[i], donor);
        else draw(s, xs[i], mainFont);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] / 255;
    return { width, height, data: out };
  }

  sampleCoverage(text: string, p: GlyphParams, width: number, height: number): GrayImage | undefined {
    if (!p.glyphSamples || wholeRunOnly(text)) return undefined;
    const { parts, xs } = this.glyphPositions(text, p);
    const chosen = sampleChoice(parts, p.glyphSamples);
    if (!chosen.some(Boolean)) return undefined;
    const out = new Float32Array(width * height);
    chosen.forEach((sample, i) => {
      if (!sample) return;
      let bitmap = this.sampleBitmaps.get(sample);
      if (!bitmap) this.sampleBitmaps.set(sample, (bitmap = decodeBase64(sample.alpha)));
      const s = p.fontSize / sample.fontSize;
      const sx = (s * p.scaleX) / sample.scaleX;
      const x0 = xs[i] + sample.dx * sx;
      const y0 = p.baselineY + sample.dy * s;
      const tw = Math.ceil(sample.w * sx);
      const th = Math.ceil(sample.h * s);
      // Inverse-map each target pixel into the sample (bilinear).
      for (let ty = 0; ty < th; ty++) {
        const py = Math.floor(y0) + ty;
        if (py < 0 || py >= height) continue;
        const v = (py + 0.5 - y0) / s - 0.5;
        for (let tx = 0; tx < tw; tx++) {
          const px = Math.floor(x0) + tx;
          if (px < 0 || px >= width) continue;
          const u = (px + 0.5 - x0) / sx - 0.5;
          const a = bilinear(bitmap, sample.w, sample.h, u, v) / 255;
          const o = py * width + px;
          if (a > out[o]) out[o] = a;
        }
      }
    });
    return { width, height, data: out };
  }
}

function bilinear(src: Uint8Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx]);
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}
