import { clampRectToBounds, expandRect, type Rect } from '../geometry';
import { dilateMask, percentile } from '../image/filters';
import { cropRaster, luminance, type RasterImage } from '../image/raster';
import type { OcrWord } from '../ocr/types';
import { sauvola } from '../vision/binarize';
import { labelComponents } from '../vision/components';
import { detectTextPolarity, orientForInk } from '../vision/polarity';
import { detectRules } from '../vision/rules';

/**
 * Visual style of one OCR word, measured from the page pixels.
 *
 * OCR engines only say *what* a word is. To keep "Certificate No." (bold)
 * and "SCS/000000/001" (regular) as separate editable elements with their
 * own styles, layout needs to know how each word *looks*.
 */
export interface WordStyle {
  /** Word box tightened to its actual ink (ruling lines excluded). */
  bbox: Rect;
  /**
   * Mean stroke thickness in px, sub-pixel accurate:
   *   width = 2 * inkMass / edgeLength
   * where inkMass is the summed ink coverage and edgeLength the total
   * variation of coverage. For a stroke of width w and length L, mass = wL and
   * the two edges contribute 2L. Works on anti-aliased, low-DPI scans where
   * thresholded stroke widths are only 1-2 whole pixels.
   */
  strokeWidth: number;
  /** Mean RGB of solid ink pixels. */
  inkColor: [number, number, number];
  /** Height of the word's tall glyphs, px. */
  glyphHeight: number;
  /** Summed ink coverage; tiny values mean the style estimate is unreliable. */
  inkMass: number;
}

export type StyledWord = OcrWord & { style?: WordStyle };

interface Pass1 {
  crop: Rect;
  gray: Float32Array;
  rgb: Uint8ClampedArray;
  /** Pixels that may contribute coverage: the word's glyphs plus a 1 px anti-aliasing halo. */
  glyphArea: Uint8Array;
  kept: Uint8Array;
  bbox: Rect;
  glyphHeight: number;
  paper: number;
  dark: number;
}

/**
 * Tighten word boxes and measure word styles. `textHeight` is the page's
 * typical glyph height (see estimateTextHeight) and scales all windows.
 */
export function measureWordStyles(page: RasterImage, words: readonly OcrWord[], textHeight: number): StyledWord[] {
  const h = Math.max(6, textHeight || 12);

  // Pass 1: per-word ink, rule removal, tight box, paper and ink levels.
  const pass1: (Pass1 | undefined)[] = words.map((w) => {
    const crop = clampRectToBounds(expandRect(w.bbox, h * 3, h * 0.6), page.width, page.height);
    if (crop.width < 3 || crop.height < 3) return undefined;
    const img = cropRaster(page, crop);
    // Orient luminance so the word's ink is darker than its background, also
    // for light text on coloured banners (measured inside the word's own box).
    const lum = luminance(img);
    const polarity = detectTextPolarity(lum, { x: w.bbox.x - crop.x, y: w.bbox.y - crop.y, width: w.bbox.width, height: w.bbox.height });
    const gray = orientForInk(lum, polarity).data;
    const ink = sauvola({ width: crop.width, height: crop.height, data: gray }, { radius: Math.max(6, h * 1.5), k: 0.25, minContrast: 12 });
    // Frame edges beside a word (e.g. a box around "Certificate No.") are
    // short vertical rules: only ~2 text heights tall, so they need their own threshold.
    const rules = detectRules(ink, Math.max(12, Math.round(h * 3)), 1, Math.max(12, Math.round(h * 2)));
    const nonRule = { width: crop.width, height: crop.height, data: new Uint8Array(ink.data.length) };
    for (let i = 0; i < ink.data.length; i++) nonRule.data[i] = ink.data[i] && !rules.data[i] ? 1 : 0;

    // Components belonging to this word: mostly inside its horizontal span, touching its vertical span.
    const bx0 = w.bbox.x - crop.x;
    const bx1 = bx0 + w.bbox.width;
    const by0 = w.bbox.y - crop.y;
    const by1 = by0 + w.bbox.height;
    const cl = labelComponents(nonRule);
    const candidates = cl.components.filter((c) => {
      const inX = Math.max(0, Math.min(c.x1, bx1) - Math.max(c.x0, bx0)) / (c.x1 - c.x0);
      return inX >= 0.5 && c.y1 > by0 && c.y0 < by1 && c.y1 - c.y0 <= h * 3;
    });
    // Glyph band (cap line .. baseline) from tall components; then drop flat
    // fragments outside it (broken/faint rules the run detector missed) and
    // anything from neighbouring lines.
    const tall = candidates.filter((c) => c.y1 - c.y0 >= h * 0.5);
    let bandTop = by0;
    let bandBottom = by1;
    if (tall.length > 0) {
      bandTop = percentile(tall.map((c) => c.y0), 50);
      bandBottom = percentile(tall.map((c) => c.y1), 50);
    }
    const band = Math.max(2, bandBottom - bandTop);
    const keep = new Set<number>();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const heights: number[] = [];
    for (const c of candidates) {
      const cw = c.x1 - c.x0;
      const ch = c.y1 - c.y0;
      if (c.y1 < bandTop - band * 0.6 || c.y0 > bandBottom + band * 0.6) continue;
      const flat = ch < band * 0.35 && cw > ch * 1.5;
      if (flat && (c.y1 <= bandTop + band * 0.05 || c.y0 >= bandBottom + band * 0.15)) continue;
      keep.add(c.label);
      x0 = Math.min(x0, c.x0);
      y0 = Math.min(y0, c.y0);
      x1 = Math.max(x1, c.x1);
      y1 = Math.max(y1, c.y1);
      if (c.area >= 3) heights.push(ch);
    }
    if (keep.size === 0) return undefined;
    const kept = new Uint8Array(ink.data.length);
    const inkValues: number[] = [];
    for (let i = 0; i < kept.length; i++) {
      if (keep.has(cl.labels[i])) {
        kept[i] = 1;
        inkValues.push(gray[i]);
      }
    }
    const glyphArea = dilateMask({ width: crop.width, height: crop.height, data: kept }, 1).data;
    const halo = dilateMask(ink, 2);
    const paperValues: number[] = [];
    for (let i = 0; i < gray.length; i++) if (!halo.data[i]) paperValues.push(gray[i]);
    return {
      crop,
      gray,
      rgb: img.data,
      glyphArea,
      kept,
      bbox: { x: crop.x + x0, y: crop.y + y0, width: x1 - x0, height: y1 - y0 },
      glyphHeight: heights.length ? percentile(heights, 90) : y1 - y0,
      paper: paperValues.length ? percentile(paperValues, 60) : 255,
      dark: percentile(inkValues, 10),
    };
  });

  // One ink reference for the page, so faint and dark words stay comparable.
  const darks = pass1.filter((p): p is Pass1 => !!p).map((p) => p.dark);
  const inkRef = darks.length ? percentile(darks, 50) : 0;

  // Pass 2: coverage-based stroke width and ink colour on the tight box.
  return words.map((w, i) => {
    const p = pass1[i];
    if (!p) return { ...w };
    const cw = p.crop.width;
    const bx0 = Math.max(0, p.bbox.x - p.crop.x - 1);
    const by0 = Math.max(0, p.bbox.y - p.crop.y - 1);
    const bx1 = Math.min(cw, p.bbox.x - p.crop.x + p.bbox.width + 1);
    const by1 = Math.min(p.crop.height, p.bbox.y - p.crop.y + p.bbox.height + 1);
    const range = Math.max(20, p.paper - inkRef);
    const cov = (x: number, y: number) => {
      const j = y * cw + x;
      if (!p.glyphArea[j]) return 0;
      return Math.min(1, Math.max(0, (p.paper - p.gray[j]) / range));
    };
    let mass = 0;
    let tv = 0;
    const color = [0, 0, 0];
    let solid = 0;
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const c = cov(x, y);
        mass += c;
        const dx = x + 1 < bx1 ? cov(x + 1, y) - c : 0;
        const dy = y + 1 < by1 ? cov(x, y + 1) - c : 0;
        tv += Math.hypot(dx, dy);
        if (c > 0.6 && p.kept[y * cw + x]) {
          const j = (y * cw + x) * 4;
          color[0] += p.rgb[j];
          color[1] += p.rgb[j + 1];
          color[2] += p.rgb[j + 2];
          solid++;
        }
      }
    }
    const style: WordStyle = {
      bbox: p.bbox,
      strokeWidth: tv > 0 ? (2 * mass) / tv : 0,
      inkColor: solid ? [color[0] / solid, color[1] / solid, color[2] / solid] : [0, 0, 0],
      glyphHeight: p.glyphHeight,
      inkMass: mass,
    };
    return { ...w, bbox: p.bbox, style };
  });
}
