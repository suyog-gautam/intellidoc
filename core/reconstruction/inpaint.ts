import type { Mask } from '../image/filters';
import { gaussianBlur } from '../image/filters';
import type { GrayImage, RasterImage } from '../image/raster';
import { mulberry32 } from '../utils/random';

/**
 * Push-pull (pyramid) hole filling.
 *
 * Unknown pixels receive a smooth interpolation of the known pixels around
 * them, at every scale: small holes are filled from immediate neighbours,
 * large ones from progressively coarser averages. Unlike a flat fill this
 * follows shadows, paper gradients and illumination fall-off, which are
 * everywhere in phone-captured documents.
 *
 * Returns a new RGB(A) raster; known pixels are copied unchanged.
 */
export function pushPullFill(img: RasterImage, known: Mask): RasterImage {
  const { width: w, height: h } = img;
  const channels: Float32Array[] = [0, 1, 2].map(() => new Float32Array(w * h));
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = known.data[i];
    weight[i] = k;
    for (let c = 0; c < 3; c++) channels[c][i] = k ? img.data[i * 4 + c] : 0;
  }
  const filled = pushPull(channels, weight, w, h);
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < w * h; i++) {
    if (known.data[i]) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = filled[c][i];
  }
  return { width: w, height: h, data: out };
}

function pushPull(values: Float32Array[], weight: Float32Array, w: number, h: number): Float32Array[] {
  if (w <= 1 && h <= 1) {
    return values.map((v) => new Float32Array(v));
  }
  // Pull: downsample (weighted average of 2x2 blocks).
  const cw = Math.max(1, Math.ceil(w / 2));
  const ch = Math.max(1, Math.ceil(h / 2));
  const cWeight = new Float32Array(cw * ch);
  const cValues = values.map(() => new Float32Array(cw * ch));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const wt = weight[i];
      if (wt <= 0) continue;
      const ci = (y >> 1) * cw + (x >> 1);
      cWeight[ci] += wt;
      for (let c = 0; c < values.length; c++) cValues[c][ci] += values[c][i] * wt;
    }
  }
  for (let ci = 0; ci < cw * ch; ci++) {
    const wt = cWeight[ci];
    if (wt > 0) for (let c = 0; c < values.length; c++) cValues[c][ci] /= wt;
    cWeight[ci] = Math.min(1, wt);
  }
  const coarse = pushPull(cValues, cWeight, cw, ch);
  // Push: fill unknowns from the bilinearly upsampled coarse level.
  const out = values.map((v) => new Float32Array(v));
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max((y + 0.5) / 2 - 0.5, 0), ch - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, ch - 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const wt = Math.min(1, weight[i]);
      if (wt >= 1) continue;
      const fx = Math.min(Math.max((x + 0.5) / 2 - 0.5, 0), cw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, cw - 1);
      const tx = fx - x0;
      for (let c = 0; c < values.length; c++) {
        const cv = coarse[c];
        const up =
          (cv[y0 * cw + x0] * (1 - tx) + cv[y0 * cw + x1] * tx) * (1 - ty) + (cv[y1 * cw + x0] * (1 - tx) + cv[y1 * cw + x1] * tx) * ty;
        out[c][i] = values[c][i] * wt + up * (1 - wt);
      }
    }
  }
  return out;
}

export interface NoiseModel {
  /** Residual RGB samples (value minus local smooth background), interleaved. */
  residuals: Float32Array;
  /** Per-channel standard deviation of the residuals. */
  sigma: [number, number, number];
}

/**
 * Capture the high-frequency texture (paper grain, sensor noise, JPEG
 * artefacts) of the known background pixels, so it can be re-applied to
 * reconstructed areas. A perfectly smooth patch in a noisy scan is exactly
 * what makes naive edits visible.
 */
export function measureNoise(img: RasterImage, known: Mask, smoothSigma = 2): NoiseModel {
  const { width: w, height: h } = img;
  const smooth = [0, 1, 2].map((c) => {
    const g: GrayImage = { width: w, height: h, data: new Float32Array(w * h) };
    for (let i = 0; i < w * h; i++) g.data[i] = img.data[i * 4 + c];
    return gaussianBlur(g, smoothSigma).data;
  });
  const samples: number[] = [];
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!known.data[i]) continue;
    for (let c = 0; c < 3; c++) {
      const r = img.data[i * 4 + c] - smooth[c][i];
      samples.push(r);
      sum[c] += r;
      sumSq[c] += r * r;
    }
    n++;
  }
  const sigma = [0, 1, 2].map((c) => (n > 1 ? Math.sqrt(Math.max(0, sumSq[c] / n - (sum[c] / n) ** 2)) : 0)) as [number, number, number];
  return { residuals: Float32Array.from(samples), sigma };
}

/** Add residuals sampled from `noise` to every pixel in `target`, in place. Deterministic for a given seed. */
export function applyNoise(img: RasterImage, target: Mask, noise: NoiseModel, seed: number, strength = 1): void {
  const count = noise.residuals.length / 3;
  if (count === 0) return;
  const rand = mulberry32(seed);
  for (let i = 0; i < target.data.length; i++) {
    if (!target.data[i]) continue;
    const s = Math.floor(rand() * count) * 3;
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = img.data[i * 4 + c] + noise.residuals[s + c] * strength;
  }
}
