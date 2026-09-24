import type { Page, TextElement, TypographyEstimate } from '../document/model';
import type { RasterImage } from '../image/raster';
import type { TextRasterizer } from '../rendering/textRasterizer';
import { fitTypography, type FitOptions } from '../typography/fit';
import { getFont } from '../typography/fontCatalog';
import { analyzeRegion } from '../typography/regionAnalysis';

export const ANALYZER_VERSION = 'heuristic-fit-1';

/**
 * Measure and fit the visual style of one text element against the original
 * page pixels. Deterministic for a given (page, element, sourceText).
 */
export function analyzeElement(original: RasterImage, element: TextElement, rasterizer: TextRasterizer, opts?: FitOptions): TypographyEstimate | undefined {
  const region = analyzeRegion(original, element.box);
  if (!region) return undefined;
  const fit = fitTypography(region, element.sourceText, rasterizer, opts);
  if (!fit) return undefined;
  const noiseSigma = (region.noise.sigma[0] + region.noise.sigma[1] + region.noise.sigma[2]) / 3;
  const confidence = Math.max(0, Math.min(1, fit.fidelity.score * (0.6 + 0.4 * (element.ocrConfidence / 100))));
  return {
    frame: region.frame,
    textBox: region.textBox,
    slot: region.slot,
    inferredAlignment: region.inferredAlignment,
    polarity: region.polarity,
    params: fit.params,
    category: getFont(fit.params.fontId).category,
    candidates: fit.candidates,
    measured: {
      inkHeight: region.metrics.height,
      inkWidth: region.metrics.width,
      strokeWidth: region.metrics.stroke,
      background: region.backgroundColor,
      noiseSigma,
    },
    fidelity: fit.fidelity,
    confidence,
    analyzerVersion: ANALYZER_VERSION,
  };
}

/** Elements on the same line immediately left/right, used to clip the free slot. */
export function neighbourLimits(page: Page, element: TextElement): { left?: number; right?: number } {
  const same = page.textElements.filter((e) => e.lineId === element.lineId && e.id !== element.id);
  let left: number | undefined;
  let right: number | undefined;
  for (const e of same) {
    if (e.bbox.x >= element.bbox.x + element.bbox.width) right = Math.min(right ?? Infinity, e.bbox.x);
    else if (e.bbox.x + e.bbox.width <= element.bbox.x) left = Math.max(left ?? -Infinity, e.bbox.x + e.bbox.width);
  }
  return { left, right };
}

/**
 * Clip the slot found from ruling lines with neighbouring text on the same
 * line so a lengthened edit never runs into the next column.
 */
export function clipSlotToNeighbours(est: TypographyEstimate, page: Page, element: TextElement): TypographyEstimate {
  const { left, right } = neighbourLimits(page, element);
  const slot = { ...est.slot };
  // Page x offsets map to local x offsets along the baseline (small-angle approximation).
  const cos = Math.cos(est.frame.angle);
  const localOf = (pageX: number) => (pageX - element.bbox.x) / cos + est.textBox.x;
  if (right !== undefined && localOf(right) < slot.right) {
    slot.right = localOf(right);
    slot.rightBounded = true;
  }
  if (left !== undefined && localOf(left) > slot.left) {
    slot.left = localOf(left);
    slot.leftBounded = true;
  }
  return { ...est, slot };
}
