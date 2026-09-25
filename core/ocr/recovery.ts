import { clampRectToBounds, expandRect, type Rect } from '../geometry';
import type { GrayImage, RasterImage } from '../image/raster';
import { luminance } from '../image/raster';
import { createMask } from '../image/filters';
import { sauvola } from '../vision/binarize';
import { labelComponents, type Component } from '../vision/components';
import { upscaleGray } from '../vision/preprocess';
import { detectRules } from '../vision/rules';
import type { OcrResult, OcrWord } from './types';

/**
 * OCR recovery pass.
 *
 * A full-page OCR pass reliably misses or garbles some text, especially short
 * values isolated in table cells ("12-03-2024" under "Valid up to"), because
 * page segmentation treats small boxed regions as non-text. Those are exactly
 * the values people want to edit. This pass finds
 *   - `reread`: words the page pass recognised with low confidence, and
 *   - `missed`: text-like ink that no OCR word covers,
 * and re-recognises each as a single line from a clean, enlarged crop.
 * Results are merged back only when they are more credible.
 */

export interface RecoveryRegion {
  kind: 'reread' | 'missed';
  /** Page-space area to re-recognise. */
  rect: Rect;
  /** For `reread`: indices of the page-pass words this region may replace. */
  wordIndices: number[];
}

/** Where a crop came from; enough to map its OCR result back to the page. */
export interface RecoveryCropMeta {
  region: RecoveryRegion;
  /** Crop-to-page mapping: page = origin + (crop - border) / scale. */
  originX: number;
  originY: number;
  scale: number;
  border: number;
}

export interface RecoveryCrop extends RecoveryCropMeta {
  /** Gray image ready for OCR (rules erased, enlarged, padded). */
  image: RasterImage;
}

export interface RecoveryOptions {
  /** Page-pass words below this confidence are re-read. */
  rereadBelow?: number;
  /** Cap on regions per page (OCR time). */
  maxRegions?: number;
}

// Letters, digits and combining marks: Devanagari vowel signs and viramas are marks (\p{M}).
const ALNUM = /[\p{L}\p{M}\p{N}]/u;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Find regions worth a second OCR look. `textHeight` is the page's typical
 * glyph height (estimateTextHeight). Deterministic and engine-independent.
 */
export function findRecoveryRegions(page: RasterImage, ocr: OcrResult, textHeight: number, opts: RecoveryOptions = {}): RecoveryRegion[] {
  const h = Math.max(6, textHeight || 12);
  const rereadBelow = opts.rereadBelow ?? 60;
  const maxRegions = opts.maxRegions ?? 60;
  const regions: RecoveryRegion[] = [];

  // 1) Low-confidence words of plausible text size.
  ocr.words.forEach((w, i) => {
    if (w.confidence >= rereadBelow || !ALNUM.test(w.text)) return;
    if (w.bbox.height > h * 3 || w.bbox.height < h * 0.4) return;
    regions.push({ kind: 'reread', rect: w.bbox, wordIndices: [i] });
  });

  // 2) Text-like ink not covered by any OCR word.
  const gray = luminance(page);
  const ink = sauvola(gray, { radius: Math.max(8, h), k: 0.25, minContrast: 20 });
  const rules = detectRules(ink, Math.max(40, Math.round(h * 3)), 2, Math.max(12, Math.round(h * 2)));
  const text = createMask(page.width, page.height);
  for (let i = 0; i < ink.data.length; i++) text.data[i] = ink.data[i] && !rules.data[i] ? 1 : 0;
  const covered = ocr.words.map((w) => expandRect(w.bbox, h * 0.3, h * 0.2));
  const glyphs: Component[] = labelComponents(text).components.filter((c) => {
    const ch = c.y1 - c.y0;
    const cw = c.x1 - c.x0;
    if (ch < h * 0.45 || ch > h * 2.2 || cw > h * 3 || c.area < h) return false;
    const r = { x: c.x0, y: c.y0, width: cw, height: ch };
    return !covered.some((cv) => overlaps(cv, r));
  });
  glyphs.sort((a, b) => a.x0 - b.x0);
  const clusters: Component[][] = [];
  for (const g of glyphs) {
    const target = clusters.find((cl) => {
      const last = cl[cl.length - 1];
      const vOverlap = Math.min(last.y1, g.y1) - Math.max(last.y0, g.y0);
      return vOverlap >= 0.5 * Math.min(last.y1 - last.y0, g.y1 - g.y0) && g.x0 - last.x1 <= h * 1.2 && g.x0 >= last.x0;
    });
    if (target) target.push(g);
    else clusters.push([g]);
  }
  for (const cl of clusters) {
    if (cl.length < 2) continue; // lone marks are almost always noise
    const x0 = Math.min(...cl.map((c) => c.x0));
    const y0 = Math.min(...cl.map((c) => c.y0));
    const x1 = Math.max(...cl.map((c) => c.x1));
    const y1 = Math.max(...cl.map((c) => c.y1));
    // Dense square blobs (QR codes, logos, stamps) aren't lines of text.
    if (y1 - y0 > h * 2.5) continue;
    regions.push({ kind: 'missed', rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, wordIndices: [] });
  }

  // Missed text first (nothing else covers it), then rereads by ascending confidence.
  const conf = (r: RecoveryRegion) => (r.kind === 'missed' ? -1 : Math.min(...r.wordIndices.map((i) => ocr.words[i].confidence)));
  return regions.sort((a, b) => conf(a) - conf(b)).slice(0, maxRegions);
}

/**
 * Prepare a clean single-line crop: illumination-flattened gray (`normalized`
 * is normalizeIllumination(page) at page resolution), ruling lines erased to
 * paper, enlarged to ~36 px text, with a white border (Tesseract needs margin).
 */
export function cropForLineOcr(page: RasterImage, normalized: GrayImage, region: RecoveryRegion, textHeight: number): RecoveryCrop {
  const h = Math.max(6, textHeight || 12);
  const rect = clampRectToBounds(expandRect(region.rect, h * 0.4, h * 0.35), page.width, page.height);
  const w = rect.width;
  const hh = rect.height;
  const sub: GrayImage = { width: w, height: hh, data: new Float32Array(w * hh) };
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) sub.data[y * w + x] = normalized.data[(rect.y + y) * normalized.width + rect.x + x];
  // Erase rules (cell borders) that would otherwise be read as "|" or "_".
  const ink = sauvola(sub, { radius: Math.max(8, h), k: 0.25, minContrast: 20 });
  const rules = detectRules(ink, Math.max(12, Math.round(h * 2.5)), 2, Math.max(12, Math.round(h * 1.8)));
  for (let i = 0; i < sub.data.length; i++) if (rules.data[i]) sub.data[i] = 245;
  const scale = Math.max(1, Math.min(4, Math.round(36 / h)));
  const big = upscaleGray(sub, scale);
  const border = 16;
  const W = big.width + border * 2;
  const H = big.height + border * 2;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const v = big.data[y * big.width + x];
      const o = ((y + border) * W + x + border) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  return { region, image: { width: W, height: H, data }, originX: rect.x, originY: rect.y, scale, border };
}

function toPage(crop: RecoveryCropMeta, w: OcrWord): OcrWord {
  const s = crop.scale;
  return {
    ...w,
    bbox: {
      x: crop.originX + (w.bbox.x - crop.border) / s,
      y: crop.originY + (w.bbox.y - crop.border) / s,
      width: w.bbox.width / s,
      height: w.bbox.height / s,
    },
    lineKey: `recovered:${w.lineKey}`,
  };
}

/**
 * Does a recovered word look like real text? Signatures, logos, stamps and QR
 * codes yield short fragments ("f=", "\2", "B") with deceptively decent
 * confidence. Short words need high confidence; `minShort` is the minimum
 * number of letters/digits a short word must have.
 */
function credible(w: OcrWord, minShort: number): boolean {
  const alnum = w.text.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length;
  if (alnum === 0 || alnum / w.text.length < 0.6) return false;
  if (alnum >= 3) return true;
  return alnum >= minShort && w.confidence >= 85;
}

function centreInside(w: OcrWord, r: Rect): boolean {
  const cx = w.bbox.x + w.bbox.width / 2;
  const cy = w.bbox.y + w.bbox.height / 2;
  return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
}

/**
 * Merge line-OCR results (crop coordinates) into the page result.
 * - `reread`: replace the original words when the new reading is clearly more
 *   confident (only words whose centre lies on the original word count, so
 *   context that slipped into the crop is ignored).
 * - `missed`: add confident alphanumeric words that don't overlap existing ones.
 */
export function mergeRecovered(ocr: OcrResult, crops: readonly RecoveryCropMeta[], results: readonly (OcrResult | undefined)[]): OcrResult {
  const replaced = new Set<number>();
  const added: OcrWord[] = [];
  crops.forEach((crop, i) => {
    const res = results[i];
    if (!res) return;
    const words = res.words.map((w) => toPage(crop, w)).filter((w) => ALNUM.test(w.text));
    if (crop.region.kind === 'reread') {
      const old = crop.region.wordIndices.map((k) => ocr.words[k]);
      const area = expandRect(crop.region.rect, crop.region.rect.height * 0.3, crop.region.rect.height * 0.3);
      const mine = words.filter((w) => centreInside(w, area) && credible(w, 1));
      if (mine.length === 0) return;
      const newConf = mine.reduce((a, w) => a + w.confidence, 0) / mine.length;
      const oldConf = old.reduce((a, w) => a + w.confidence, 0) / old.length;
      if (newConf >= 50 && newConf > oldConf + 15) {
        crop.region.wordIndices.forEach((k) => replaced.add(k));
        added.push(...mine);
      }
    } else {
      for (const w of words) {
        // Higher bar than rereads: nothing corroborates newly found text
        // (stamp and logo lettering produce plausible fragments).
        if (w.confidence < 65) continue;
        if (!credible(w, 2)) continue;
        if ([...ocr.words, ...added].some((o) => overlaps(o.bbox, w.bbox))) continue;
        added.push(w);
      }
    }
  });
  if (replaced.size === 0 && added.length === 0) return ocr;
  return { ...ocr, words: [...ocr.words.filter((_, k) => !replaced.has(k)), ...added] };
}

/**
 * Full recovery pass: find regions, crop, recognise (caller-supplied, since
 * image encoding differs between browser and Node) and merge.
 */
export async function recoverMissedText(
  page: RasterImage,
  normalized: GrayImage,
  ocr: OcrResult,
  textHeight: number,
  recognizeLine: (crop: RecoveryCrop) => Promise<OcrResult | undefined>,
  opts?: RecoveryOptions,
): Promise<{ result: OcrResult; regions: number; replaced: number; added: number }> {
  const regions = findRecoveryRegions(page, ocr, textHeight, opts);
  const crops = regions.map((r) => cropForLineOcr(page, normalized, r, textHeight));
  const results: (OcrResult | undefined)[] = [];
  for (const crop of crops) {
    try {
      results.push(await recognizeLine(crop));
    } catch {
      results.push(undefined); // a failed region must not fail the page
    }
  }
  const result = mergeRecovered(ocr, crops, results);
  const before = new Set(ocr.words);
  const kept = result.words.filter((w) => before.has(w)).length;
  return { result, regions: regions.length, replaced: ocr.words.length - kept, added: result.words.length - kept };
}
