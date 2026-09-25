import type { RenderParams } from '@/core/document/model';
import type { OrientedBox } from '@/core/geometry';
import { gaussianBlur } from '@/core/image/filters';
import { createRaster, type RasterImage } from '@/core/image/raster';
import { renderCoverage, type TextRasterizer } from '@/core/rendering/textRasterizer';
import { mulberry32 } from '@/core/utils/random';
import { compositeUprightInk } from '@/core/vision/warp';

/** Paper with a left-to-right illumination gradient and Gaussian-ish grain. */
export function syntheticPaper(width: number, height: number, seed = 1): RasterImage {
  const img = createRaster(width, height);
  const rand = mulberry32(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = 215 + (20 * x) / width;
      const n = (rand() + rand() + rand() - 1.5) * 6;
      const o = (y * width + x) * 4;
      img.data[o] = base + n;
      img.data[o + 1] = base - 2 + n;
      img.data[o + 2] = base + 8 + n;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

export function defaultParams(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    fontId: 'arimo',
    weight: 400,
    italic: false,
    fontSize: 32,
    scaleX: 1,
    letterSpacing: 0,
    wordSpacing: 0,
    skewX: 0,
    embolden: 0,
    blur: 0.8,
    originX: 0,
    baselineY: 0,
    color: [60, 58, 70],
    opacity: 1,
    ...overrides,
  };
}

/**
 * Draw text with known parameters into `page` inside the oriented frame, like
 * a printer + scanner would. Returns the tight OCR-like box of the text.
 */
export function drawText(page: RasterImage, rasterizer: TextRasterizer, text: string, frame: OrientedBox, params: RenderParams): OrientedBox {
  const cov = renderCoverage(rasterizer, text, params, Math.round(frame.width), Math.round(frame.height));
  compositeUprightInk(page, frame, cov, () => params.color);
  return textBox(rasterizer, text, frame, params);
}

/** Tight OCR-like box of text drawn with {@link drawText}. */
function textBox(rasterizer: TextRasterizer, text: string, frame: OrientedBox, params: RenderParams): OrientedBox {
  const advance = rasterizer.measure(text, params);
  const capHeight = params.fontSize * 0.72;
  const c = Math.cos(frame.angle);
  const s = Math.sin(frame.angle);
  const lx = params.originX + advance / 2 - frame.width / 2;
  const ly = params.baselineY - capHeight / 2 - frame.height / 2;
  return { cx: frame.cx + lx * c - ly * s, cy: frame.cy + lx * s + ly * c, width: advance, height: capHeight * 1.1, angle: frame.angle };
}

/**
 * A synthetic "scanned page": paper texture + several lines of text, encoded
 * as JPEG like a real scan. Replaces private sample documents in tests.
 */
export async function syntheticScanJpeg(rasterizer: TextRasterizer, width: number, height: number, seed = 1): Promise<{ jpeg: Uint8Array; raster: RasterImage }> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = syntheticPaper(width, height, seed);
  const frame = { cx: width / 2, cy: height / 2, width, height, angle: 0 };
  const size = Math.round(width / 40);
  const lines = ['CALIBRATION CERTIFICATE', 'Certificate No. : SCS/000000/001', 'Date of Calibration 14-09-2023', 'Suggested Due Date 13-09-2024'];
  lines.forEach((text, i) => drawText(page, rasterizer, text, frame, defaultParams({ fontSize: size, weight: i === 0 ? 700 : 400, originX: size * 2, baselineY: size * 3 + i * size * 2.2 })));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(width, height);
  id.data.set(page.data);
  ctx.putImageData(id, 0, 0);
  return { jpeg: new Uint8Array(canvas.toBuffer('image/jpeg', 92)), raster: page };
}

/**
 * Like {@link drawText}, but every "1" loses its foot serif: Arial and
 * Helvetica draw "1" without one, while Arimo (their metric-compatible
 * stand-in) has it. This is how an Arial document looks to the fitter.
 */
export function drawTextFootlessOnes(page: RasterImage, rasterizer: TextRasterizer, text: string, frame: OrientedBox, params: RenderParams): OrientedBox {
  const W = Math.round(frame.width);
  const H = Math.round(frame.height);
  const sharp = rasterizer.coverage(text, params, W, H);
  const chars = Array.from(text);
  chars.forEach((ch, i) => {
    if (ch !== '1') return;
    const x0 = Math.floor(params.originX + rasterizer.measure(chars.slice(0, i).join(''), params));
    const x1 = Math.ceil(params.originX + rasterizer.measure(chars.slice(0, i + 1).join(''), params));
    // Stem columns at mid-height; below the foot line keep only those.
    const mid = Math.round(params.baselineY - params.fontSize * 0.3);
    const stem: number[] = [];
    for (let x = x0; x < x1; x++) if (sharp.data[mid * W + x] > 0.3) stem.push(x);
    const s0 = Math.min(...stem) - 1;
    const s1 = Math.max(...stem) + 1;
    for (let y = Math.round(params.baselineY - params.fontSize * 0.12); y < params.baselineY + 3; y++) {
      for (let x = x0 - 2; x < x1 + 2; x++) if (x < s0 || x > s1) sharp.data[y * W + x] = 0;
    }
  });
  const cov = gaussianBlur(sharp, params.blur);
  compositeUprightInk(page, frame, cov, () => params.color);
  return textBox(rasterizer, text, frame, params);
}
