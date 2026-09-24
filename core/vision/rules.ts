import { createMask, type Mask } from '../image/filters';

/**
 * Detect ruling lines (table borders, underlines, form lines) in an ink mask.
 *
 * A pixel belongs to a horizontal rule if it lies on a horizontal ink run of at
 * least `minLength` pixels; small breaks up to `maxGap` (scan dropouts) are
 * bridged. Vertical rules are detected the same way on columns. Text strokes
 * are much shorter than `minLength`, so they are not picked up.
 *
 * Used to keep table/form lines intact when text touching them is removed.
 * Vertical rules can use a shorter minimum: cell borders and box edges are
 * often only one or two text lines tall, while no glyph stroke is taller
 * than about 1.3x the text height.
 */
export function detectRules(ink: Mask, minLength: number, maxGap = 2, minVerticalLength = minLength): Mask {
  const { width: w, height: h, data } = ink;
  const out = createMask(w, h);
  const markRuns = (n: number, get: (i: number) => number, set: (i: number) => void, minLen: number) => {
    let runStart = -1;
    let lastInk = -1;
    const flush = () => {
      if (runStart >= 0 && lastInk - runStart + 1 >= minLen) {
        for (let i = runStart; i <= lastInk; i++) if (get(i)) set(i);
      }
    };
    for (let i = 0; i < n; i++) {
      if (get(i)) {
        if (runStart < 0 || i - lastInk > maxGap + 1) {
          flush();
          runStart = i;
        }
        lastInk = i;
      }
    }
    flush();
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    markRuns(
      w,
      (x) => data[row + x],
      (x) => (out.data[row + x] = 1),
      minLength,
    );
  }
  for (let x = 0; x < w; x++) {
    markRuns(
      h,
      (y) => data[y * w + x],
      (y) => (out.data[y * w + x] = 1),
      minVerticalLength,
    );
  }
  return out;
}
