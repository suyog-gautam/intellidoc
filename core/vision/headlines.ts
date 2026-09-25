import type { Rect } from '../geometry';
import { luminance, type RasterImage } from '../image/raster';
import { sauvola } from './binarize';
import { labelComponents } from './components';

export interface HeadlineEvidence {
  /** Words written under a headline (Devanagari, Bengali, Gurmukhi). */
  words: number;
  /** A band of the page holding several such words, for a quick recognition probe. */
  band?: Rect;
}

/**
 * Count words that hang from a headline (शिरोरेखा): a thin horizontal stroke
 * across the top of the word with glyph stems hanging from much of its
 * length. Tesseract's script detection (OSD) counts separate characters, and
 * a headline joins a whole word into one blob, so OSD reports "too few
 * characters" on Devanagari and Bengali pages. This finds them instead.
 *
 * Table rules and underlines don't qualify: rules run far longer than a
 * word and have, at most, a few glyphs touching them; underlines have text
 * above, not stems hanging below.
 */
export function findHeadlineWords(page: RasterImage, textHeight: number): HeadlineEvidence {
  const ink = sauvola(luminance(page), { radius: Math.max(12, Math.round(textHeight)), k: 0.25, minContrast: 16 });
  const { components } = labelComponents(ink);
  // The page-level text height counts separate glyphs; on a page of headline words there are few, so measure word heights.
  const h = Math.max(8, textHeight || wordHeight(components));
  const { width: w } = ink;
  const found: Rect[] = [];
  for (const c of components) {
    const cw = c.x1 - c.x0;
    const ch = c.y1 - c.y0;
    // A word: wider than tall, a few letters long, about one text line high (with matras).
    // (At least ~2 letters wide: single CJK characters also have strong top strokes.)
    if (cw < h * 1.6 || cw > h * 25 || ch < h * 0.6 || ch > h * 2.5) continue;
    // Find the densest row in the top 40%: the headline.
    let bestRow = -1;
    let bestRun = 0;
    for (let y = c.y0; y < c.y0 + Math.max(2, Math.round(ch * 0.4)); y++) {
      let run = 0;
      let longest = 0;
      for (let x = c.x0; x < c.x1; x++) {
        if (ink.data[y * w + x]) longest = Math.max(longest, ++run);
        else run = 0;
      }
      if (longest > bestRun) {
        bestRun = longest;
        bestRow = y;
      }
    }
    if (bestRow < 0 || bestRun < cw * 0.7) continue;
    // Stems: columns with ink some way below the headline.
    const probeY = Math.min(c.y1 - 1, bestRow + Math.max(3, Math.round(h * 0.3)));
    let stems = 0;
    for (let x = c.x0; x < c.x1; x++) if (ink.data[probeY * w + x]) stems++;
    const stemFraction = stems / cw;
    // Hanging letters, but not a solid block (a filled bar is not a word).
    if (stemFraction < 0.12 || stemFraction > 0.75) continue;
    found.push({ x: c.x0, y: c.y0, width: cw, height: ch });
  }
  if (found.length === 0) return { words: 0 };
  // Band: the lines around the first few headline words, full page width.
  found.sort((a, b) => a.y - b.y);
  const take = found.slice(0, Math.min(found.length, 12));
  const y0 = Math.max(0, Math.min(...take.map((r) => r.y)) - Math.round(h * 0.5));
  const y1 = Math.min(page.height, Math.max(...take.map((r) => r.y + r.height)) + Math.round(h * 0.5));
  const band = { x: 0, y: y0, width: page.width, height: Math.min(y1 - y0, Math.round(h * 12)) };
  return { words: found.length, band };
}

/** Median height of word-sized components (fallback when few separate glyphs exist). */
function wordHeight(components: { x0: number; x1: number; y0: number; y1: number; area: number }[]): number {
  const hs = components.filter((c) => c.y1 - c.y0 >= 6 && c.area >= 20 && c.x1 - c.x0 >= c.y1 - c.y0).map((c) => c.y1 - c.y0);
  if (!hs.length) return 0;
  hs.sort((a, b) => a - b);
  // Words with matras are taller than the letter body; the lower quartile is closer to the body height.
  return hs[Math.floor(hs.length * 0.4)];
}
