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
export function removeElementText(target: RasterImage, original: RasterImage, est: TypographyEstimate, seed: number): RemovalReport {
  const frame = est.frame;
  const h = est.textBox.height;
  const patch = extractUpright(original, frame);
  const polarity = est.polarity ?? 'dark';
  const strong = selectTextInk(removeRules(binarizeText(patch, h, polarity), h, est.textBox), est.textBox);
  const ink = withFaintStrokes(strong, patch, h, polarity, est.textBox);
  const halo = Math.ceil(Math.max(1.5, est.measured.strokeWidth * 0.35 + est.params.blur * 2 + 1));
  const localMask = dilateMask(ink, halo);

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
