import { elementIsModified, type Page, type TextElement } from '../document/model';
import { cloneRaster, type RasterImage } from '../image/raster';
import { removeElementText } from '../reconstruction/textRemoval';
import { layoutReplacement } from '../typography/layoutReplacement';
import { hashString } from '../utils/random';
import { compositeText } from './textCompositor';
import type { TextRasterizer } from './textRasterizer';

export interface PageRenderResult {
  image: RasterImage;
  /** Modified elements that could not be rendered because they lack typography analysis. */
  pending: string[];
  overflowing: string[];
}

/**
 * Produce the output page from (immutable original + document model).
 *
 * The editor preview and every export go through this one function, so what
 * the user sees is exactly what gets exported. Editor chrome (selection,
 * confidence overlays) lives in a separate DOM layer and never reaches here.
 *
 * Two passes: first all edited/deleted text is removed, then replacement
 * text is drawn, so one element's reconstruction never erases another
 * element's new text.
 */
export function renderPage(original: RasterImage, page: Page, rasterizer: TextRasterizer): PageRenderResult {
  const image = cloneRaster(original);
  const pending: string[] = [];
  const overflowing: string[] = [];
  const active: TextElement[] = [];
  for (const el of page.textElements) {
    if (!elementIsModified(el)) continue;
    if (!el.typography) {
      pending.push(el.id);
      continue;
    }
    active.push(el);
  }
  for (const el of active) if (el.origin !== 'added') removeElementText(image, original, el.typography!, hashString(el.id));
  for (const el of active) {
    if (el.state === 'deleted') continue;
    const layout = layoutReplacement(el.typography!, el.sourceText, el.text, el.alignment, rasterizer, el.styleOverrides);
    if (layout.overflow) overflowing.push(el.id);
    compositeText(image, el.typography!, layout.params, el.text, layout.advance, rasterizer, hashString(`${el.id}:${el.text}`), hashString(el.id));
  }
  return { image, pending, overflowing };
}
