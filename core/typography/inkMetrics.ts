import { distanceToBackground, median, percentile, type Mask } from '../image/filters';
import { labelComponents } from '../vision/components';

export interface InkMetrics {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Robust baseline (median bottom of full-height glyph components). */
  baseline: number;
  /** Robust top of the tallest glyph class (cap/ascender line). */
  capTop: number;
  /** baseline - capTop. The main size cue. */
  height: number;
  width: number;
  /** Typical stroke thickness in px. */
  stroke: number;
  area: number;
}

/**
 * Measure typographic quantities of a binary ink mask.
 *
 * IMPORTANT: this exact function is applied both to the scanned text and to
 * every rendered candidate. Any systematic bias (merged glyphs, descenders,
 * punctuation) then affects both sides equally and cancels out in the fit.
 */
export function measureInk(mask: Mask): InkMetrics | undefined {
  const cl = labelComponents(mask);
  const comps = cl.components;
  if (comps.length === 0) return undefined;
  const maxArea = Math.max(...comps.map((c) => c.area));
  const glyphs = comps.filter((c) => c.area >= Math.max(3, maxArea * 0.01));
  if (glyphs.length === 0) return undefined;
  const heights = glyphs.map((c) => c.y1 - c.y0);
  const refH = percentile(heights, 90);
  const baselineSet = glyphs.filter((c) => c.y1 - c.y0 >= refH * 0.4);
  const capSet = glyphs.filter((c) => c.y1 - c.y0 >= refH * 0.75);
  const baseline = median(baselineSet.map((c) => c.y1));
  const capTop = median(capSet.map((c) => c.y0));
  const x0 = Math.min(...glyphs.map((c) => c.x0));
  const x1 = Math.max(...glyphs.map((c) => c.x1));
  const top = Math.min(...glyphs.map((c) => c.y0));
  const bottom = Math.max(...glyphs.map((c) => c.y1));
  return {
    x0,
    x1,
    top,
    bottom,
    baseline,
    capTop,
    height: Math.max(1, baseline - capTop),
    width: Math.max(1, x1 - x0),
    stroke: strokeWidth(mask),
    area: glyphs.reduce((s, c) => s + c.area, 0),
  };
}

/**
 * Stroke width from the distance transform: along the medial axis of a
 * stroke, the distance to the background is half the stroke width.
 */
export function strokeWidth(mask: Mask): number {
  const dist = distanceToBackground(mask);
  const { width: w, height: h } = mask;
  const ridge: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const d = dist[i];
      if (d <= 0) continue;
      if (d >= dist[i - 1] && d >= dist[i + 1] && d >= dist[i - w] && d >= dist[i + w]) ridge.push(d);
    }
  }
  if (ridge.length === 0) return 1;
  // A 1-px stroke has ridge distance 1 (pixel centre to background), so
  // width ~= 2 * d - 1.
  return Math.max(1, 2 * median(ridge) - 1);
}
