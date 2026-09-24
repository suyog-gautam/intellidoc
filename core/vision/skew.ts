import type { Mask } from '../image/filters';

export interface SkewEstimate {
  /** Radians, clockwise in image space (text baseline direction). */
  angle: number;
  /** 0..1, how much sharper the best projection is compared to the unrotated one. */
  confidence: number;
}

/**
 * Projection-profile skew estimation.
 *
 * For each candidate angle the ink pixels are projected onto the axis
 * perpendicular to that angle. When the angle matches the text lines, ink
 * concentrates into a few rows and the sum of squared bin counts peaks.
 * A coarse sweep is followed by a fine sweep around the best angle.
 */
export function estimateSkew(mask: Mask, maxAngleDeg = 6, sampleStep = 1): SkewEstimate {
  const xs: number[] = [];
  const ys: number[] = [];
  const { width: w, height: h, data } = mask;
  for (let y = 0; y < h; y += sampleStep) {
    for (let x = 0; x < w; x += sampleStep) {
      if (data[y * w + x]) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 20) return { angle: 0, confidence: 0 };

  const diag = Math.ceil(Math.hypot(w, h));
  const bins = new Float64Array(diag * 2 + 2);
  const score = (angle: number) => {
    bins.fill(0);
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    for (let i = 0; i < xs.length; i++) {
      const v = Math.round(-xs[i] * s + ys[i] * c) + diag;
      bins[v]++;
    }
    let total = 0;
    for (let i = 0; i < bins.length; i++) total += bins[i] * bins[i];
    return total;
  };

  const deg = Math.PI / 180;
  let best = 0;
  let bestScore = -1;
  for (let a = -maxAngleDeg; a <= maxAngleDeg + 1e-9; a += 0.5) {
    const sc = score(a * deg);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  const coarse = best;
  for (let a = coarse - 0.5; a <= coarse + 0.5 + 1e-9; a += 0.05) {
    const sc = score(a * deg);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  const flat = score(0);
  const confidence = bestScore > 0 ? Math.min(1, Math.max(0, (bestScore - flat) / bestScore) * 4 + 0.5) : 0;
  return { angle: best * deg, confidence: best === 0 ? 0.5 : confidence };
}
