import type { RenderParams } from '../document/model';
import { gaussianBlur } from '../image/filters';
import type { GrayImage } from '../image/raster';
import { clusters } from '../text/script';
import { cssFont, getFont, hasFont } from '../typography/fontCatalog';
import { hashString, mulberry32 } from '../utils/random';

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
  'fontId' | 'weight' | 'italic' | 'fontSize' | 'scaleX' | 'letterSpacing' | 'wordSpacing' | 'skewX' | 'embolden' | 'originX' | 'baselineY' | 'glyphFonts' | 'jitter'
>;

export interface TextRasterizer {
  /** Pen advance of `text` in local px (after scaleX / spacing). */
  measure(text: string, p: GlyphParams): number;
  /** Anti-aliased glyph coverage 0..1 on a width x height surface (no blur/opacity). */
  coverage(text: string, p: GlyphParams, width: number, height: number): GrayImage;
}

/** Full rasterisation: glyph coverage, optics blur and opacity. */
export function renderCoverage(r: TextRasterizer, text: string, p: RenderParams, width: number, height: number): GrayImage {
  const cov = r.coverage(text, p, width, height);
  const blurred = gaussianBlur(cov, p.blur);
  if (p.opacity !== 1) for (let i = 0; i < blurred.data.length; i++) blurred.data[i] *= p.opacity;
  return blurred;
}

/** Advance and ink box of one glyph relative to its pen position (y up = ascent). */
interface InkBox {
  advance: number;
  left: number;
  right: number;
  ascent: number;
  descent: number;
}

/** Donor weight closest to the requested one among the weights the donor ships. */
function donorWeight(fontId: string, weight: number): number {
  const ws = getFont(fontId).weights;
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0]);
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

  constructor(private readonly factory: CanvasFactory) {}

  private surface(width: number, height: number): Ctx2D {
    if (!this.canvas || this.canvas.width < width || this.canvas.height < height) {
      this.canvas = this.factory(Math.max(width, this.canvas?.width ?? 0), Math.max(height, this.canvas?.height ?? 0));
      this.ctx = this.canvas.getContext('2d') as Ctx2D;
    }
    return this.ctx!;
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

  private glyphPositions(text: string, p: GlyphParams): { parts: string[]; xs: number[]; end: number } {
    const font = cssFont(p.fontId, p.weight, p.italic, p.fontSize);
    const parts = clusters(text);
    const pre = this.prefixes(parts, font);
    const xs: number[] = [];
    let spaces = 0;
    for (let i = 0; i < parts.length; i++) {
      xs.push(p.originX + pre[i] * p.scaleX + i * p.letterSpacing + spaces * p.wordSpacing);
      if (parts[i] === ' ') spaces++;
    }
    const end = p.originX + pre[parts.length] * p.scaleX + parts.length * p.letterSpacing + spaces * p.wordSpacing;
    return { parts, xs, end };
  }

  measure(text: string, p: GlyphParams): number {
    return this.glyphPositions(text, p).end - p.originX;
  }

  coverage(text: string, p: GlyphParams, width: number, height: number): GrayImage {
    const ctx = this.surface(width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const mainFont = cssFont(p.fontId, p.weight, p.italic, p.fontSize);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineJoin = 'round';
    ctx.lineWidth = p.embolden / Math.max(0.2, p.scaleX);
    const { parts, xs } = this.glyphPositions(text, p);
    const subs = activeSubstitutions(p);
    const jitter = Math.max(0, Math.min(1, p.jitter ?? 0));

    /**
     * Draw `s` with its pen at local x, optionally offset (dx, dy) in font
     * units and wobbled (rotation r, scale k about the glyph's centre cx):
     *   x' = scaleX * u - skewX * v + x ; y' = v + baseline  (slant leans right for skewX > 0)
     */
    const draw = (s: string, x: number, font: string, dx = 0, dy = 0, r = 0, k = 1, cx = 0) => {
      ctx.font = font;
      const c = Math.cos(r) * k;
      const sn = Math.sin(r) * k;
      // q = [[c, -sn], [sn, c]]·(u - cx, v) + (cx + dx, dy), then the slant/scale frame.
      const e1 = -c * cx + cx + dx;
      const e2 = -sn * cx + dy;
      ctx.setTransform(p.scaleX * c - p.skewX * sn, sn, -p.scaleX * sn - p.skewX * c, c, p.scaleX * e1 - p.skewX * e2 + x, e2 + p.baselineY);
      ctx.fillText(s, 0, 0);
      if (p.embolden > 0.01) ctx.strokeText(s, 0, 0);
    };

    /**
     * A glyph drawn from a donor font: scaled to the main font's ink height
     * of the same character and centred in its advance. Fonts centre glyphs
     * in their advance by design, whereas the ink box moves with the very
     * details that differ (a foot widens a "1" to both sides).
     */
    const drawSubstitute = (s: string, x: number, donorId: string, wobble: [number, number, number, number]) => {
      const main = this.inkBox(s, mainFont);
      const donorBase = cssFont(donorId, donorWeight(donorId, p.weight), p.italic, p.fontSize);
      const donor = this.inkBox(s, donorBase);
      if (!main || !donor || donor.ascent + donor.descent <= 0) {
        draw(s, x, mainFont, 0, wobble[0], wobble[1], wobble[2], wobble[3]);
        return;
      }
      const k = (main.ascent + main.descent) / (donor.ascent + donor.descent);
      const donorFont = cssFont(donorId, donorWeight(donorId, p.weight), p.italic, p.fontSize * k);
      const mainCentre = main.advance / 2;
      const donorCentre = (donor.advance / 2) * k;
      // Same ink bottom as the main glyph (baseline sitters stay on the baseline, descenders reach as deep).
      const dy = main.descent - donor.descent * k;
      draw(s, x, donorFont, mainCentre - donorCentre, dy + wobble[0], wobble[1], wobble[2], wobble[3]);
    };

    const simple = p.letterSpacing === 0 && p.wordSpacing === 0 && jitter === 0;
    if (simple && !subs) {
      draw(text, p.originX, mainFont);
    } else if (simple) {
      // Runs of the main font keep their kerning; substituted glyphs are drawn one by one.
      let start = 0;
      for (let i = 0; i <= parts.length; i++) {
        const donor = i < parts.length ? subs![parts[i]] : undefined;
        if (i < parts.length && !donor) continue;
        if (i > start) draw(parts.slice(start, i).join(''), xs[start], mainFont);
        if (donor) drawSubstitute(parts[i], xs[i], donor, [0, 0, 1, 0]);
        start = i + 1;
      }
    } else {
      for (let i = 0; i < parts.length; i++) {
        const s = parts[i];
        if (s === ' ') continue;
        let wobble: [number, number, number, number] = [0, 0, 1, 0];
        if (jitter > 0) {
          // Seeded per position and character: editing one character leaves the others where they were.
          const rand = mulberry32(hashString(`${i}:${s}`));
          const u = () => rand() * 2 - 1;
          const cx = ((xs[i + 1] ?? xs[i] + p.fontSize * 0.5) - xs[i]) / (2 * p.scaleX);
          wobble = [u() * 0.045 * jitter * p.fontSize, u() * 0.07 * jitter, 1 + u() * 0.06 * jitter, cx];
        }
        const donor = subs?.[s];
        if (donor) drawSubstitute(s, xs[i], donor, wobble);
        else draw(s, xs[i], mainFont, 0, wobble[0], wobble[1], wobble[2], wobble[3]);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] / 255;
    return { width, height, data: out };
  }
}
