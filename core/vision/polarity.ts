import type { Rect } from '../geometry';
import type { GrayImage } from '../image/raster';

/**
 * Text polarity: 'dark' = dark ink on lighter paper (the usual case),
 * 'light' = light text on a darker background (headings on coloured
 * banners, white text in boxes, inverted table headers).
 */
export type TextPolarity = 'dark' | 'light';

/**
 * Decide the polarity of the text inside `box` (default: whole image).
 *
 * Inside a tight text box the background is the majority of pixels and the
 * glyph strokes the minority, whatever the colours are. Otsu splits the
 * luminance histogram into two classes; if the smaller class is the lighter
 * one, the text is light-on-dark. Low-contrast boxes default to 'dark'.
 */
export function detectTextPolarity(gray: GrayImage, box?: Rect): TextPolarity {
  const x0 = Math.max(0, Math.floor(box?.x ?? 0));
  const y0 = Math.max(0, Math.floor(box?.y ?? 0));
  const x1 = Math.min(gray.width, Math.ceil(box ? box.x + box.width : gray.width));
  const y1 = Math.min(gray.height, Math.ceil(box ? box.y + box.height : gray.height));
  const hist = new Float64Array(256);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      hist[Math.max(0, Math.min(255, Math.round(gray.data[y * gray.width + x])))]++;
      n++;
    }
  }
  if (n < 16) return 'dark';
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      t = i;
    }
  }
  let nDark = 0;
  let sDark = 0;
  for (let i = 0; i <= t; i++) {
    nDark += hist[i];
    sDark += i * hist[i];
  }
  const nLight = n - nDark;
  if (nDark === 0 || nLight === 0) return 'dark';
  const contrast = (sumAll - sDark) / nLight - sDark / nDark;
  if (contrast < 30) return 'dark';
  return nLight < nDark ? 'light' : 'dark';
}

/**
 * Luminance oriented so that ink is always darker than its background:
 * unchanged for dark text, inverted (255 - v) for light text. Lets every
 * "dark ink" algorithm (Sauvola, rule detection, components) work for both.
 */
export function orientForInk(gray: GrayImage, polarity: TextPolarity): GrayImage {
  if (polarity === 'dark') return gray;
  const out = new Float32Array(gray.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - gray.data[i];
  return { width: gray.width, height: gray.height, data: out };
}
