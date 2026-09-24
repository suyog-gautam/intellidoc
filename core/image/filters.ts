import type { GrayImage } from './raster';

/** Binary mask: 1 = set, 0 = clear. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function maskCount(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Summed-area tables of v and v², (w+1)x(h+1), Float64 to keep precision on large pages. */
export interface IntegralImages {
  readonly width: number;
  readonly height: number;
  readonly sum: Float64Array;
  readonly sumSq: Float64Array;
}

export function integralImages(img: GrayImage): IntegralImages {
  const { width: w, height: h, data } = img;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sumSq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sumSq[(y + 1) * W + x + 1] = sumSq[y * W + x + 1] + rq;
    }
  }
  return { width: w, height: h, sum, sumSq };
}

/** Mean and variance of the window [x0,x1) x [y0,y1). */
export function windowStats(ii: IntegralImages, x0: number, y0: number, x1: number, y1: number): { mean: number; variance: number } {
  const W = ii.width + 1;
  const n = (x1 - x0) * (y1 - y0);
  if (n <= 0) return { mean: 0, variance: 0 };
  const s = ii.sum[y1 * W + x1] - ii.sum[y0 * W + x1] - ii.sum[y1 * W + x0] + ii.sum[y0 * W + x0];
  const q = ii.sumSq[y1 * W + x1] - ii.sumSq[y0 * W + x1] - ii.sumSq[y1 * W + x0] + ii.sumSq[y0 * W + x0];
  const mean = s / n;
  return { mean, variance: Math.max(0, q / n - mean * mean) };
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    total += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= total;
  return k;
}

/** Separable Gaussian blur with clamped edges. sigma <= 0.05 returns a copy. */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  const { width: w, height: h } = img;
  if (sigma <= 0.05) return { width: w, height: h, data: new Float32Array(img.data) };
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        acc += img.data[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * Returns, for every pixel, the distance to the nearest pixel where `mask` is 0.
 * Inside a stroke this is the distance to the stroke edge, so twice the ridge
 * value approximates the local stroke width.
 */
export function distanceToBackground(mask: Mask): Float32Array {
  const { width: w, height: h } = mask;
  const INF = 1e10;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask.data[i] ? INF : 0;

  const edt1d = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Dilate a mask with a disc of the given radius (in pixels). */
export function dilateMask(mask: Mask, radius: number): Mask {
  if (radius <= 0) return { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) };
  const inverted = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) inverted.data[i] = mask.data[i] ? 0 : 1;
  const dist = distanceToBackground(inverted);
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < dist.length; i++) out.data[i] = dist[i] <= radius ? 1 : 0;
  return out;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function median(values: ArrayLike<number>): number {
  return percentile(values, 50);
}
