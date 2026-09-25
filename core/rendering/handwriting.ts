import type { RenderParams } from '../document/model';
import type { GrayImage } from '../image/raster';
import { mulberry32 } from '../utils/random';
import type { VariationAnchor } from './textRasterizer';

/**
 * Natural variation for handwriting.
 *
 * A person never writes the same character the same way twice. Handwriting
 * synthesis research (style-preserving glyph synthesis, "handwriting from
 * public fonts") models this as the product of a few independent effects,
 * each smooth along the line:
 *
 *   - baseline drift: the line wanders up and down over several letters;
 *   - local slant and size: each letter leans and scales a little differently;
 *   - elastic shape distortion (Simard et al.): a smooth random displacement
 *     field that bends strokes, so two "a"s are two different shapes;
 *   - pen pressure: strokes thicken and thin, ink gets darker and lighter.
 *
 * All of them are applied here as one smooth deformation of the rendered
 * coverage rather than per letter. So it works for every script: joined
 * Arabic and headline-connected Devanagari stay connected, right-to-left
 * text needs no special case, and CJK characters vary stroke by stroke.
 *
 * The field is a sum of sinusoids with random phases, fixed in the element's
 * own coordinates (seeded per element): deterministic for preview and
 * export, and editing one character leaves the others unchanged.
 */

interface Wave {
  kx: number;
  ky: number;
  phase: number;
  amp: number;
}

/** Wavelengths in em: long for drift, about one letter for slant/size, sub-letter for shape. */
function waves(rand: () => number, n: number, minEm: number, maxEm: number, em: number, withY: boolean): Wave[] {
  const out: Wave[] = [];
  for (let i = 0; i < n; i++) {
    const lx = (minEm + (maxEm - minEm) * rand()) * em;
    const ly = (minEm + (maxEm - minEm) * rand()) * em;
    out.push({ kx: (2 * Math.PI) / lx, ky: withY ? (2 * Math.PI) / ly : 0, phase: rand() * 2 * Math.PI, amp: 0.6 + 0.8 * rand() });
  }
  return out;
}

function field(ws: readonly Wave[], x: number, y: number): number {
  let s = 0;
  for (const w of ws) s += w.amp * Math.sin(w.kx * x + w.ky * y + w.phase);
  return s / Math.sqrt(ws.length);
}

/** Amplitudes at jitter 1, as fractions of the font size. */
const DRIFT = 0.045;
const SLANT = 0.1;
const SIZE = 0.05;
const ELASTIC = 0.03;
const PRESSURE = 0.3;

export function applyHandwritingVariation(cov: GrayImage, p: Pick<RenderParams, 'fontSize' | 'baselineY' | 'jitter'>, anchor: VariationAnchor): GrayImage {
  const j = Math.max(0, Math.min(1, p.jitter ?? 0));
  if (j === 0) return cov;
  const { width: W, height: H, data } = cov;
  const em = p.fontSize;
  const rand = mulberry32(anchor.seed ^ 0x9e3779b9);
  const ox = anchor.x;
  const oy = anchor.y;
  const drift = waves(rand, 3, 2.5, 7, em, false);
  const slant = waves(rand, 3, 0.9, 2.2, em, false);
  const size = waves(rand, 2, 1.2, 2.6, em, false);
  const ex = waves(rand, 4, 0.3, 0.8, em, true);
  const ey = waves(rand, 4, 0.3, 0.8, em, true);
  const pressure = waves(rand, 3, 1.5, 4, em, false);

  const out = new Float32Array(W * H);
  // Per-column terms once (they depend on x only).
  const colDy = new Float32Array(W);
  const colSlant = new Float32Array(W);
  const colSize = new Float32Array(W);
  const colGamma = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const fx = x + ox;
    colDy[x] = DRIFT * j * em * field(drift, fx, 0);
    colSlant[x] = SLANT * j * field(slant, fx, 0);
    colSize[x] = SIZE * j * field(size, fx, 0);
    colGamma[x] = Math.exp(PRESSURE * j * field(pressure, fx, 0));
  }
  const elastic = ELASTIC * j * em;
  for (let y = 0; y < H; y++) {
    const up = p.baselineY - y; // height above the baseline
    for (let x = 0; x < W; x++) {
      // Inverse mapping: where in the undistorted text does this pixel come from?
      const sx = x + colSlant[x] * up + elastic * field(ex, x + ox, y + oy);
      const sy = y + colDy[x] + colSize[x] * up + elastic * field(ey, x + ox, y + oy);
      const a = sample(data, W, H, sx, sy);
      // Pressure: gamma > 1 thickens and darkens strokes, < 1 thins and lightens them.
      out[y * W + x] = a > 0 ? 1 - Math.pow(1 - a, colGamma[x]) : 0;
    }
  }
  return { width: W, height: H, data: out };
}

function sample(d: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < -1 || y0 < -1 || x0 >= w || y0 >= h) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : d[yy * w + xx]);
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}
