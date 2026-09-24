import type { GrayImage } from '../image/raster';
import { createMask, integralImages, windowStats, type Mask } from '../image/filters';

export interface SauvolaOptions {
  /** Half-size of the local window in pixels. Should be ~1-2x the text height. */
  radius: number;
  /** Sensitivity; higher => fewer ink pixels. Typical 0.2-0.4. */
  k?: number;
  /** Dynamic range of the standard deviation. */
  r?: number;
  /**
   * Minimum darkness below the local mean for a pixel to count as ink. Stops
   * flat paper texture from being classified as ink where local variance is tiny.
   */
  minContrast?: number;
}

/**
 * Sauvola adaptive thresholding. Robust to the uneven illumination typical of
 * phone-captured documents, unlike a single global (Otsu) threshold.
 * Returns a mask where 1 = ink (darker than its surroundings).
 */
export function sauvola(gray: GrayImage, opts: SauvolaOptions): Mask {
  const { width: w, height: h, data } = gray;
  const k = opts.k ?? 0.3;
  const R = opts.r ?? 128;
  const minContrast = opts.minContrast ?? 14;
  const rad = Math.max(2, Math.round(opts.radius));
  const ii = integralImages(gray);
  const out = createMask(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(w, x + rad + 1);
      const { mean, variance } = windowStats(ii, x0, y0, x1, y1);
      const t = mean * (1 + k * (Math.sqrt(variance) / R - 1));
      const v = data[y * w + x];
      out.data[y * w + x] = v < t && mean - v > minContrast ? 1 : 0;
    }
  }
  return out;
}

/** Global Otsu threshold on a 0..255 gray image. */
export function otsuThreshold(gray: GrayImage): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.data.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray.data[i])))]++;
  const total = gray.data.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}
