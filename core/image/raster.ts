import type { Rect } from '../geometry';

/**
 * Environment-neutral RGBA8 image. Structurally identical to DOM `ImageData`
 * so it can be handed to/from canvases, workers (transferable buffer) and
 * Node test harnesses without conversion.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Single-channel float image (luminance, masks, coverage...). */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export function createRaster(width: number, height: number, fill?: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function createGray(width: number, height: number, fill = 0): GrayImage {
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function cloneRaster(img: RasterImage): RasterImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function cropRaster(img: RasterImage, r: Rect): RasterImage {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const w = Math.max(0, Math.min(img.width, Math.floor(r.x + r.width)) - x0);
  const h = Math.max(0, Math.min(img.height, Math.floor(r.y + r.height)) - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Write `patch` into `target` at (x, y), clipping to the target bounds. */
export function pasteRaster(target: RasterImage, patch: RasterImage, x: number, y: number): void {
  for (let py = 0; py < patch.height; py++) {
    const ty = y + py;
    if (ty < 0 || ty >= target.height) continue;
    for (let px = 0; px < patch.width; px++) {
      const tx = x + px;
      if (tx < 0 || tx >= target.width) continue;
      const s = (py * patch.width + px) * 4;
      const d = (ty * target.width + tx) * 4;
      target.data[d] = patch.data[s];
      target.data[d + 1] = patch.data[s + 1];
      target.data[d + 2] = patch.data[s + 2];
      target.data[d + 3] = patch.data[s + 3];
    }
  }
}

/** Rec. 709 luma, 0..255. */
export function luminance(img: RasterImage): GrayImage {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  }
  return { width: img.width, height: img.height, data: out };
}

/** Bilinear sample of one channel (0..3); coordinates are pixel centres. Edges clamp. */
export function sampleBilinear(img: RasterImage, x: number, y: number, channel: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), img.width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = img.data;
  const w = img.width;
  const a = d[(y0 * w + x0) * 4 + channel];
  const b = d[(y0 * w + x1) * 4 + channel];
  const c = d[(y1 * w + x0) * 4 + channel];
  const e = d[(y1 * w + x1) * 4 + channel];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

export function sampleGrayBilinear(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x > img.width || y > img.height) return 0;
  const fx = Math.min(Math.max(x - 0.5, 0), img.width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = img.data;
  const w = img.width;
  return (d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) + (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty;
}
