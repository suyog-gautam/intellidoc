import type { GlyphSample, RenderParams } from '../document/model';
import { luminance } from '../image/raster';
import type { TextRasterizer } from '../rendering/textRasterizer';
import { clusters, hasConnectedScript, hasRtl } from '../text/script';
import { encodeBase64 } from '../utils/base64';
import { labelComponents, type Component } from '../vision/components';
import type { RegionAnalysis } from './regionAnalysis';

/** Instances kept per character: enough variety that repeated letters never look stamped. */
const MAX_SAMPLES = 4;

interface Blob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  labels: number[];
  /** Set when the blob is part of a component split at a touching point: only these columns belong to it. */
  clip?: [number, number];
}

/**
 * Cut the writer's own characters out of a handwritten element.
 *
 * Handwriting synthesis research is consistent on one point: the most
 * convincing way to write "in someone's hand" is to reuse glyphs they wrote
 * (non-parametric, sample-based synthesis), with natural variation between
 * instances. Font glyphs are only a fallback for characters not seen yet.
 *
 * Segmentation follows the ink, not a font: handwriting doesn't keep any
 * font's advances. Ink components become glyph blobs (parts that overlap
 * horizontally, like the dot and stem of "i", merge; specks attach to their
 * neighbour), blobs are assigned to the nearest word, and a word is used only
 * when its blob count equals its character count. Cursive words, where
 * letters are joined, fail that test and are skipped rather than cut wrongly.
 * Right-to-left and joined scripts (Arabic, Devanagari) are not harvested.
 */
export function harvestWriterGlyphs(region: RegionAnalysis, params: RenderParams, text: string, rasterizer: TextRasterizer): Record<string, GlyphSample[]> | undefined {
  if (hasRtl(text) || hasConnectedScript(text)) return undefined;
  const parts = clusters(text);
  const h = region.metrics.height;
  const { labels, components } = labelComponents(region.ink);
  const W = region.ink.width;

  // Word ranges predicted by the fitted font: only used to tell which word a blob belongs to.
  const xs: number[] = [params.originX];
  for (let i = 1; i <= parts.length; i++) xs.push(params.originX + rasterizer.measure(parts.slice(0, i).join(''), params));
  const words: { chars: number[]; x0: number; x1: number }[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length) words.push({ chars: current, x0: xs[current[0]], x1: xs[current[current.length - 1] + 1] });
    current = [];
  };
  parts.forEach((p, i) => (/^\s+$/.test(p) ? flush() : current.push(i)));
  flush();
  if (!words.length) return undefined;

  const blobs = glyphBlobs(components, h);
  if (!blobs.length) return undefined;
  const perWord = words.map(() => [] as Blob[]);
  for (const b of blobs) {
    const cx = (b.x0 + b.x1) / 2;
    let best = 0;
    let bestD = Infinity;
    words.forEach((w, k) => {
      const d = cx < w.x0 ? w.x0 - cx : cx > w.x1 ? cx - w.x1 : 0;
      if (d < bestD) [best, bestD] = [k, d];
    });
    perWord[best].push(b);
  }

  const Bl = luminance(region.background).data;
  const Ol = luminance(region.patch).data;
  const inkL = 0.2126 * params.color[0] + 0.7152 * params.color[1] + 0.0722 * params.color[2];
  const out: Record<string, GlyphSample[]> = {};
  words.forEach((w, k) => {
    const bs = reconcile(perWord[k].sort((a, b) => a.x0 - b.x0), w.chars.length, region.ink.data, labels, W);
    if (bs.length !== w.chars.length) return;
    w.chars.forEach((ci, n) => {
      const ch = parts[ci];
      const list = (out[ch] ??= []);
      if (list.length >= MAX_SAMPLES) return;
      const b = bs[n];
      // A little margin for anti-aliasing around the strokes.
      const m = 2;
      const x0 = Math.max(0, (b.clip?.[0] ?? b.x0 - m));
      const y0 = Math.max(0, b.y0 - m);
      const x1 = Math.min(W, (b.clip?.[1] ?? b.x1 + m));
      const y1 = Math.min(region.ink.height, b.y1 + m);
      const bw = x1 - x0;
      const bh = y1 - y0;
      const own = new Set(b.labels);
      const alpha = new Uint8Array(bw * bh);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          if ((labels[i] && !own.has(labels[i])) || !nearOwnInk(labels, own, W, region.ink.height, x, y, m)) continue;
          const contrast = Bl[i] - inkL;
          const a = Math.abs(contrast) < 8 ? 0 : (Bl[i] - Ol[i]) / contrast;
          alpha[(y - y0) * bw + (x - x0)] = Math.round(255 * Math.max(0, Math.min(1, a)));
        }
      }
      list.push({ w: bw, h: bh, alpha: encodeBase64(alpha), dx: x0 - xs[ci], dy: y0 - params.baselineY, fontSize: params.fontSize, scaleX: params.scaleX });
    });
  });
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Make a word's blob count match its character count when handwriting
 * breaks the one-blob-per-letter rule: letters that touch ("25" written in
 * one go) are split at their thinnest column (projection-profile
 * segmentation), and a stroke broken in two is merged with its closest
 * neighbour. At most two corrections per word; beyond that the word is
 * left alone rather than cut arbitrarily.
 */
function reconcile(blobs: Blob[], chars: number, ink: Uint8Array, labels: Int32Array, w: number): Blob[] {
  let bs = [...blobs];
  for (let step = 0; step < 2 && bs.length !== chars && bs.length > 0; step++) {
    if (bs.length < chars) {
      const widths = bs.map((b) => b.x1 - b.x0).sort((a, b) => a - b);
      const median = widths[widths.length >> 1];
      const i = bs.reduce((best, b, k) => (b.x1 - b.x0 > bs[best].x1 - bs[best].x0 ? k : best), 0);
      const b = bs[i];
      if (b.x1 - b.x0 < median * 1.4 && bs.length > 1) break;
      const own = new Set(b.labels);
      // Thinnest column in the middle 60% of the blob.
      let cut = -1;
      let least = Infinity;
      for (let x = Math.round(b.x0 + (b.x1 - b.x0) * 0.2); x < Math.round(b.x0 + (b.x1 - b.x0) * 0.8); x++) {
        let n = 0;
        for (let y = b.y0; y < b.y1; y++) if (ink[y * w + x] && own.has(labels[y * w + x])) n++;
        if (n < least) [least, cut] = [n, x];
      }
      if (cut < 0) break;
      bs.splice(i, 1, { ...b, x1: cut, clip: [b.clip?.[0] ?? b.x0 - 2, cut] }, { ...b, x0: cut, clip: [cut, b.clip?.[1] ?? b.x1 + 2] });
    } else {
      // Merge the two closest neighbours.
      let i = 0;
      for (let k = 1; k < bs.length - 1; k++) if (bs[k + 1].x0 - bs[k].x1 < bs[i + 1].x0 - bs[i].x1) i = k;
      const a = bs[i];
      const b = bs[i + 1];
      bs.splice(i, 2, { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), labels: [...a.labels, ...b.labels] });
    }
    bs = bs.sort((a, b) => a.x0 - b.x0);
  }
  return bs;
}

/** Group ink components into per-character blobs. */
function glyphBlobs(components: Component[], h: number): Blob[] {
  const big = components.filter((c) => c.area >= 4);
  const blobs: Blob[] = big
    .filter((c) => c.y1 - c.y0 >= h * 0.25 || c.x1 - c.x0 >= h * 0.25)
    .map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, labels: [c.label] }))
    .sort((a, b) => a.x0 - b.x0);
  // Merge blobs that overlap horizontally by much of the narrower one ("=" bars, a broken stroke, i + dot).
  for (let i = 0; i < blobs.length - 1; ) {
    const a = blobs[i];
    const b = blobs[i + 1];
    const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (overlap > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) {
      blobs.splice(i, 2, { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), labels: [...a.labels, ...b.labels] });
    } else i++;
  }
  // Small marks (dots, accents, specks) join the blob they sit over.
  for (const c of big) {
    if (c.y1 - c.y0 >= h * 0.25 || c.x1 - c.x0 >= h * 0.25) continue;
    const cx = (c.x0 + c.x1) / 2;
    const host = blobs.find((b) => cx >= b.x0 - 1 && cx <= b.x1 + 1);
    if (!host) continue;
    host.labels.push(c.label);
    host.y0 = Math.min(host.y0, c.y0);
    host.y1 = Math.max(host.y1, c.y1);
  }
  return blobs;
}

/** Is (x, y) on, or within `r` px of, one of the blob's own components (so neighbours' strokes stay out)? */
function nearOwnInk(labels: Int32Array, own: Set<number>, w: number, h: number, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const l = labels[yy * w + xx];
      if (l && own.has(l)) return true;
    }
  }
  return false;
}
