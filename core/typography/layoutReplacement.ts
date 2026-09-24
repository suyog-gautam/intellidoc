import type { RenderParams, TextAlignment, TypographyEstimate } from '../document/model';
import type { TextRasterizer } from '../rendering/textRasterizer';
import { resolveParams } from './styleTransfer';

export interface ReplacementLayout {
  params: RenderParams;
  /** Pen advance of the new text. */
  advance: number;
  /** True when even the most aggressive allowed fitting could not make it fit. */
  overflow: boolean;
  /** Which adjustments were needed, for UI feedback. */
  adjustments: Array<'letterSpacing' | 'scaleX' | 'fontSize'>;
}

/**
 * Position replacement text so it keeps the original's anchor (left edge,
 * centre or right edge) and fits the available space.
 *
 * Longer text is fitted gradually, preferring the least visible change:
 * slightly tighter tracking, then a little horizontal compression, then a
 * smaller size. Shorter text is never stretched.
 */
export function layoutReplacement(
  estimate: TypographyEstimate,
  sourceText: string,
  newText: string,
  alignment: TextAlignment,
  rasterizer: TextRasterizer,
  overrides?: Partial<RenderParams>,
): ReplacementLayout {
  const base: RenderParams = resolveParams(estimate.params, overrides, rasterizer);
  const h = estimate.measured.inkHeight;
  const margin = Math.max(2, h * 0.3);
  // The anchor comes from where the *original* text sits, measured with the
  // detected style, so a user-chosen font or size doesn't shift it.
  const srcAdvance = rasterizer.measure(sourceText, estimate.params);
  const anchorLeft = base.originX;
  const anchorCenter = base.originX + srcAdvance / 2;
  const anchorRight = base.originX + srcAdvance;
  const { slot } = estimate;

  let available: number;
  if (alignment === 'center') available = 2 * Math.min(anchorCenter - slot.left, slot.right - anchorCenter) - 2 * margin;
  else if (alignment === 'right') available = anchorRight - slot.left - margin;
  else available = slot.right - anchorLeft - margin;
  available = Math.max(available, srcAdvance);

  const params = { ...base };
  const adjustments: ReplacementLayout['adjustments'] = [];
  let advance = rasterizer.measure(newText, params);
  const glyphs = Math.max(1, Array.from(newText).length - 1);

  if (advance > available) {
    const minSpacing = base.letterSpacing - base.fontSize * 0.03;
    const needed = (available - advance) / glyphs;
    params.letterSpacing = Math.max(minSpacing, base.letterSpacing + needed);
    adjustments.push('letterSpacing');
    advance = rasterizer.measure(newText, params);
  }
  if (advance > available) {
    const natural = advance - (params.letterSpacing * glyphs);
    const target = (available - params.letterSpacing * glyphs) / Math.max(1, natural);
    params.scaleX = Math.max(base.scaleX * 0.88, params.scaleX * target);
    adjustments.push('scaleX');
    advance = rasterizer.measure(newText, params);
  }
  if (advance > available) {
    params.fontSize = Math.max(base.fontSize * 0.8, params.fontSize * (available / advance));
    adjustments.push('fontSize');
    advance = rasterizer.measure(newText, params);
  }

  if (alignment === 'center') params.originX = anchorCenter - advance / 2;
  else if (alignment === 'right') params.originX = anchorRight - advance;
  else params.originX = anchorLeft;

  return { params, advance, overflow: advance > available + 0.5, adjustments };
}
