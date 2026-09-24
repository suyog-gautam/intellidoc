import type { RenderParams } from '../document/model';
import { gaussianBlur } from '../image/filters';
import type { GrayImage } from '../image/raster';
import { cssFont } from '../typography/fontCatalog';

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
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export type GlyphParams = Pick<
  RenderParams,
  'fontId' | 'weight' | 'italic' | 'fontSize' | 'scaleX' | 'letterSpacing' | 'wordSpacing' | 'skewX' | 'embolden' | 'originX' | 'baselineY'
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

/**
 * Canvas implementation. Glyphs are placed individually from prefix
 * measurements so kerning is kept while letter/word spacing stay exact and
 * independent of `ctx.letterSpacing` support (missing in some browsers).
 */
export class CanvasTextRasterizer implements TextRasterizer {
  private canvas: CanvasLike | undefined;
  private ctx: Ctx2D | undefined;
  private readonly prefixCache = new Map<string, number[]>();

  constructor(private readonly factory: CanvasFactory) {}

  private surface(width: number, height: number): Ctx2D {
    if (!this.canvas || this.canvas.width < width || this.canvas.height < height) {
      this.canvas = this.factory(Math.max(width, this.canvas?.width ?? 0), Math.max(height, this.canvas?.height ?? 0));
      this.ctx = this.canvas.getContext('2d') as Ctx2D;
    }
    return this.ctx!;
  }

  /** Natural (unscaled) advance of each prefix text[0..i), i = 0..n. */
  private prefixes(text: string, font: string): number[] {
    const key = `${font}\u0000${text}`;
    const cached = this.prefixCache.get(key);
    if (cached) return cached;
    const ctx = this.surface(8, 8);
    ctx.font = font;
    const chars = Array.from(text);
    const out = [0];
    let acc = '';
    for (const ch of chars) {
      acc += ch;
      out.push(ctx.measureText(acc).width);
    }
    if (this.prefixCache.size > 5000) this.prefixCache.clear();
    this.prefixCache.set(key, out);
    return out;
  }

  private glyphPositions(text: string, p: GlyphParams): { chars: string[]; xs: number[]; end: number } {
    const font = cssFont(p.fontId, p.weight, p.italic, p.fontSize);
    const pre = this.prefixes(text, font);
    const chars = Array.from(text);
    const xs: number[] = [];
    let spaces = 0;
    for (let i = 0; i < chars.length; i++) {
      xs.push(p.originX + pre[i] * p.scaleX + i * p.letterSpacing + spaces * p.wordSpacing);
      if (chars[i] === ' ') spaces++;
    }
    const end = p.originX + pre[chars.length] * p.scaleX + chars.length * p.letterSpacing + spaces * p.wordSpacing;
    return { chars, xs, end };
  }

  measure(text: string, p: GlyphParams): number {
    return this.glyphPositions(text, p).end - p.originX;
  }

  coverage(text: string, p: GlyphParams, width: number, height: number): GrayImage {
    const ctx = this.surface(width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = cssFont(p.fontId, p.weight, p.italic, p.fontSize);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineJoin = 'round';
    ctx.lineWidth = p.embolden / Math.max(0.2, p.scaleX);
    const { chars, xs } = this.glyphPositions(text, p);
    const draw = (s: string, x: number) => {
      // x' = scaleX * u - skewX * v + x ; y' = v + baseline  (slant leans right for skewX > 0)
      ctx.setTransform(p.scaleX, 0, -p.skewX, 1, x, p.baselineY);
      ctx.fillText(s, 0, 0);
      if (p.embolden > 0.01) ctx.strokeText(s, 0, 0);
    };
    if (p.letterSpacing === 0 && p.wordSpacing === 0) {
      draw(text, p.originX);
    } else {
      for (let i = 0; i < chars.length; i++) if (chars[i] !== ' ') draw(chars[i], xs[i]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] / 255;
    return { width, height, data: out };
  }
}
