import type { RenderParams, TypographyEstimate } from '../document/model';
import type { RasterImage } from '../image/raster';
import { subFrame } from '../typography/regionAnalysis';
import { mulberry32 } from '../utils/random';
import { compositeUprightInk } from '../vision/warp';
import { renderCoverage, type TextRasterizer } from './textRasterizer';

/**
 * Render replacement text into the page: glyph coverage in the element's
 * upright frame (same optics blur as fitted), coloured with the fitted ink
 * colour plus a little of the scan's grain, then rotated back into place.
 */
export function compositeText(
  target: RasterImage,
  est: TypographyEstimate,
  params: RenderParams,
  text: string,
  advance: number,
  rasterizer: TextRasterizer,
  seed: number,
  /** Stable per element (not per text), so handwriting variation stays put while the text is edited. */
  variationSeed = seed,
): void {
  if (!text.trim()) return;
  const h = est.measured.inkHeight;
  const frame = est.frame;
  const x0 = Math.floor(Math.min(0, params.originX - 2 * h));
  const x1 = Math.ceil(Math.max(frame.width, params.originX + advance + 2 * h));
  // Also grow vertically: a user-chosen (or pasted) larger size must not be
  // clipped by the frame, which was sized for the original text.
  // Tall scripts need the headroom: Nastaliq climbs ~2 em, stacked Thai/Indic marks reach beyond 1 em.
  const y0 = Math.floor(Math.min(0, params.baselineY - params.fontSize * 2.3 - 2 * params.blur - params.embolden));
  const y1 = Math.ceil(Math.max(frame.height, params.baselineY + params.fontSize * 1.0 + 2 * params.blur + params.embolden));
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const renderFrame = subFrame(frame, rect);
  const local: RenderParams = { ...params, originX: params.originX - rect.x, baselineY: params.baselineY - rect.y };
  // The variation field is anchored to the frame, not to this render rectangle (which grows with the text).
  const coverage = renderCoverage(rasterizer, text, local, rect.width, rect.height, { seed: variationSeed, x: rect.x, y: rect.y });

  const rand = mulberry32(seed);
  const grain = est.measured.noiseSigma * 0.8;
  const [r, g, b] = params.color;
  compositeUprightInk(target, renderFrame, coverage, () => {
    // Approximately Gaussian (Irwin-Hall, n=3), shared across channels to keep the hue.
    const n = (rand() + rand() + rand() - 1.5) * 2 * grain;
    return [r + n, g + n, b + n];
  });
}
