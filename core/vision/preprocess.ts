import { gaussianBlur } from '../image/filters';
import { luminance, type GrayImage, type RasterImage } from '../image/raster';
import { sauvola } from './binarize';
import { labelComponents } from './components';
import { estimateSkew, type SkewEstimate } from './skew';

/** Box-average downscale by an integer factor. */
export function downscaleGray(img: GrayImage, factor: number): GrayImage {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * img.width + x * f;
        for (let dx = 0; dx < f; dx++) s += img.data[row + dx];
      }
      out[y * w + x] = s / (f * f);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Flatten uneven illumination (shadows, vignetting, phone flash hot-spots)
 * by dividing by an estimate of the paper brightness. Produces a *working
 * copy* for OCR only; the original raster is never modified.
 *
 * Paper estimate: on a coarse grid, the local maximum of luminance (paper is
 * the brightest thing around), smoothed; then bilinearly upsampled.
 */
export function normalizeIllumination(img: RasterImage): GrayImage {
  const gray = luminance(img);
  const factor = Math.max(1, Math.round(Math.max(img.width, img.height) / 400));
  const small = downscaleGray(gray, factor);
  const { width: sw, height: sh } = small;
  const r = 6;
  const maxed = new Float32Array(sw * sh);
  const tmp = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(sw - 1, Math.max(0, x + dx));
        m = Math.max(m, small.data[y * sw + xx]);
      }
      tmp[y * sw + x] = m;
    }
  }
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy));
        m = Math.max(m, tmp[yy * sw + x]);
      }
      maxed[y * sw + x] = m;
    }
  }
  const paper = gaussianBlur({ width: sw, height: sh, data: maxed }, r);
  const out = new Float32Array(gray.data.length);
  for (let y = 0; y < img.height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < img.width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const p =
        (paper.data[y0 * sw + x0] * (1 - tx) + paper.data[y0 * sw + x1] * tx) * (1 - ty) +
        (paper.data[y1 * sw + x0] * (1 - tx) + paper.data[y1 * sw + x1] * tx) * ty;
      out[y * img.width + x] = Math.min(255, (gray.data[y * img.width + x] / Math.max(24, p)) * 245);
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Dominant text skew of a full page, estimated on a downscaled binarisation. */
export function estimatePageSkew(img: RasterImage): SkewEstimate {
  const gray = luminance(img);
  const factor = Math.max(1, Math.round(Math.max(img.width, img.height) / 1200));
  const small = downscaleGray(gray, factor);
  const ink = sauvola(small, { radius: 15, k: 0.3, minContrast: 20 });
  return estimateSkew(ink, 6, 1);
}

export function grayToRaster(g: GrayImage): RasterImage {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i];
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: g.width, height: g.height, data };
}

/**
 * Typical height of text-like connected components (px). Used to decide
 * whether the page is too low-resolution for OCR.
 */
export function estimateTextHeight(img: RasterImage): number {
  const gray = luminance(img);
  const ink = sauvola(gray, { radius: 12, k: 0.3, minContrast: 20 });
  const { components } = labelComponents(ink);
  const heights: number[] = [];
  for (const c of components) {
    const h = c.y1 - c.y0;
    const w = c.x1 - c.x0;
    // Glyph-like: not specks, not rules, not huge blobs.
    if (h >= 4 && h <= 120 && w <= h * 3 && c.area >= 6) heights.push(h);
  }
  if (heights.length < 20) return 0;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length * 0.6)];
}

/** Text height (px) at which Tesseract's LSTM recognises best. */
const OCR_TARGET_TEXT_HEIGHT = 30;
/** Below this glyph height (px) recognition degrades sharply (~<150 DPI body text). */
const OCR_MIN_TEXT_HEIGHT = 12;

/** Bilinear upscale of a gray image by an integer factor. */
export function upscaleGray(img: GrayImage, factor: number): GrayImage {
  if (factor <= 1) return img;
  const w = img.width * factor;
  const h = img.height * factor;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      const d = img.data;
      out[y * w + x] = (d[y0 * img.width + x0] * (1 - tx) + d[y0 * img.width + x1] * tx) * (1 - ty) + (d[y1 * img.width + x0] * (1 - tx) + d[y1 * img.width + x1] * tx) * ty;
    }
  }
  return { width: w, height: h, data: out };
}

export interface OcrWorkingCopy {
  image: GrayImage;
  /** OCR coordinates = page coordinates * scale. */
  scale: number;
  textHeight: number;
}

/**
 * The OCR working copy: illumination-flattened, and upscaled when the text
 * is too small for reliable recognition (low-DPI scans, phone photos of whole
 * pages). Word boxes must be divided by `scale` to get page coordinates.
 */
export function prepareOcrImage(img: RasterImage, maxPixels = 40_000_000): OcrWorkingCopy {
  const textHeight = estimateTextHeight(img);
  let scale = textHeight > 0 && textHeight < OCR_MIN_TEXT_HEIGHT ? Math.min(4, Math.round(OCR_TARGET_TEXT_HEIGHT / textHeight)) : 1;
  while (scale > 1 && img.width * img.height * scale * scale > maxPixels) scale--;
  return { image: upscaleGray(normalizeIllumination(img), scale), scale, textHeight };
}
