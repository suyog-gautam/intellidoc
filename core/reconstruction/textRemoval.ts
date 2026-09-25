import type { TypographyEstimate } from '../document/model';
import { clampRectToBounds, orientedBoundingRect, toLocal } from '../geometry';
import { createMask, dilateMask, maskCount, type Mask } from '../image/filters';
import type { Rect } from '../geometry';
import { cropRaster, luminance, pasteRaster, type RasterImage } from '../image/raster';
import { binarizeText, removeRules, selectTextInk } from '../typography/regionAnalysis';
import { sauvola } from '../vision/binarize';
import { orientForInk } from '../vision/polarity';
import { extractUpright } from '../vision/warp';
import { applyNoise, measureNoise, pushPullFill } from './inpaint';

export interface RemovalReport {
  /** Pixels reconstructed. */
  pixels: number;
  /** 0..1, low when little clean background was available to learn from. */
  confidence: number;
}

/**
 * Remove an element's original text from `target` and reconstruct the paper
 * underneath, reading pixels only from the immutable `original`.
 *
 * Only the glyph pixels (plus an anti-aliasing halo) are replaced; ruling
 * lines and neighbouring content outside that mask are left untouched. The
 * hole is filled with push-pull interpolation of the surrounding clean
 * paper, then re-textured with noise sampled from that same paper.
 */
export function removeElementText(target: RasterImage, original: RasterImage, est: TypographyEstimate, seed: number, columns?: [number, number]): RemovalReport {
  const frame = est.frame;
  const h = est.textBox.height;
  const patch = extractUpright(original, frame);
  const polarity = est.polarity ?? 'dark';
  const strong = selectTextInk(removeRules(binarizeText(patch, h, polarity), h, est.textBox), est.textBox);
  const textInk = withFaintStrokes(strong, patch, h, polarity, est.textBox);
  const halo = Math.ceil(Math.max(1.5, est.measured.strokeWidth * 0.35 + est.params.blur * 2 + 1));
  let localMask: Mask;
  if (columns) {
    // Partial edit: erase only the changed characters. Cut where the ink is thinnest near each
    // boundary (between glyphs), and never touch the strokes of the characters that stay.
    const [c0, c1] = refineCuts(textInk, columns, h);
    const ink = createMask(textInk.width, textInk.height);
    const kept = createMask(textInk.width, textInk.height);
    for (let y = 0; y < textInk.height; y++) {
      for (let x = 0; x < textInk.width; x++) {
        const i = y * textInk.width + x;
        if (!textInk.data[i]) continue;
        if (x >= c0 && x < c1) ink.data[i] = 1;
        else kept.data[i] = 1;
      }
    }
    localMask = dilateMask(ink, halo);
    const guard = dilateMask(kept, 1);
    for (let i = 0; i < localMask.data.length; i++) if (guard.data[i]) localMask.data[i] = 0;
  } else localMask = dilateMask(textInk, halo);

  const win = clampRectToBounds(orientedBoundingRect(frame), original.width, original.height);
  if (win.width === 0 || win.height === 0) return { pixels: 0, confidence: 0 };
  const crop = cropRaster(original, win);

  // Map the local glyph mask onto page pixels.
  const removal = createMask(win.width, win.height);
  for (let y = 0; y < win.height; y++) {
    for (let x = 0; x < win.width; x++) {
      const l = toLocal(frame, { x: win.x + x + 0.5, y: win.y + y + 0.5 });
      const lx = Math.floor(l.x);
      const ly = Math.floor(l.y);
      if (lx < 0 || ly < 0 || lx >= localMask.width || ly >= localMask.height) continue;
      if (localMask.data[ly * localMask.width + lx]) removal.data[y * win.width + x] = 1;
    }
  }
  const pixels = maskCount(removal);
  if (pixels === 0) return { pixels: 0, confidence: 0 };

  // Learn only from clean paper: exclude all ink (other text, rules) and its halo.
  const gray = luminance(crop);
  const inkOpts = { radius: Math.max(8, h), k: 0.25, minContrast: 14 };
  const inkMask = sauvola(gray, inkOpts);
  if (polarity === 'light') {
    // Light text on a dark surface: exclude the (light) text as well as dark marks.
    const light = sauvola(orientForInk(gray, 'light'), inkOpts);
    for (let i = 0; i < inkMask.data.length; i++) inkMask.data[i] = inkMask.data[i] || light.data[i] ? 1 : 0;
  }
  const allInk = dilateMask(inkMask, 2);
  const known = createMask(win.width, win.height);
  for (let i = 0; i < known.data.length; i++) known.data[i] = removal.data[i] || allInk.data[i] ? 0 : 1;
  let knownCount = maskCount(known);
  if (knownCount < known.data.length * 0.1) {
    for (let i = 0; i < known.data.length; i++) known.data[i] = removal.data[i] ? 0 : 1;
    knownCount = maskCount(known);
  }

  const filled = pushPullFill(crop, known);
  const noise = measureNoise(crop, known);
  applyNoise(filled, removal, noise, seed);

  // Only masked pixels change; everything else in the window stays original.
  const current = cropRaster(target, win);
  for (let i = 0; i < removal.data.length; i++) {
    if (!removal.data[i]) continue;
    for (let c = 0; c < 3; c++) current.data[i * 4 + c] = filled.data[i * 4 + c];
  }
  pasteRaster(target, current, win.x, win.y);

  const cleanRatio = knownCount / Math.max(1, known.data.length - pixels);
  const texture = (noise.sigma[0] + noise.sigma[1] + noise.sigma[2]) / 3;
  const confidence = Math.max(0, Math.min(1, cleanRatio * 1.3)) * (texture > 25 ? 0.6 : 1);
  return { pixels, confidence };
}

/**
 * Add faint strokes of the same glyphs: hairlines of high-contrast designs
 * (Song/Ming and Mincho serifs, Didone and Garamond hairlines) are too light
 * for the text binarisation and would otherwise stay on the page as a ghost
 * when the text is replaced. Faint ink counts only close to confirmed text
 * strokes, and never on a ruling line.
 */
function withFaintStrokes(strong: Mask, patch: RasterImage, h: number, polarity: 'dark' | 'light', textBox: Rect): Mask {
  const faint = selectTextInk(removeRules(sauvola(orientForInk(luminance(patch), polarity), { radius: Math.max(8, h), k: 0.12, minContrast: 5 }), h, textBox), textBox);
  const near = dilateMask(strong, Math.max(2, Math.round(h * 0.25)));
  const out = createMask(strong.width, strong.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = strong.data[i] || (faint.data[i] && near.data[i]) ? 1 : 0;
  return out;
}

/**
 * Move each cut to the column with the least ink within ±0.3 text heights of
 * the predicted glyph boundary: fitted positions are close, not exact, and
 * the gap between two glyphs is where a cut leaves no half-letters.
 */
function refineCuts(ink: Mask, [a, b]: [number, number], h: number): [number, number] {
  const w = ink.width;
  const col = new Float32Array(w);
  for (let y = 0; y < ink.height; y++) for (let x = 0; x < w; x++) col[x] += ink.data[y * w + x];
  const best = (x: number) => {
    if (!Number.isFinite(x)) return x;
    const r = Math.max(2, Math.round(h * 0.3));
    let bx = Math.round(x);
    let bv = Infinity;
    for (let xx = Math.max(0, Math.round(x) - r); xx <= Math.min(w - 1, Math.round(x) + r); xx++) {
      // Prefer emptier columns, then the one nearest the prediction.
      const v = col[xx] + Math.abs(xx - x) * 0.01;
      if (v < bv) [bv, bx] = [v, xx];
    }
    return bx;
  };
  return [Number.isFinite(a) ? best(a) : -Infinity, Number.isFinite(b) ? best(b) : Infinity];
}
