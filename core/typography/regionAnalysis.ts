import type { TextAlignment } from '../document/model';
import { toPage, type OrientedBox, type Rect } from '../geometry';
import { createMask, dilateMask, median, type Mask } from '../image/filters';
import { luminance, type RasterImage } from '../image/raster';
import { measureNoise, pushPullFill, type NoiseModel } from '../reconstruction/inpaint';
import { sauvola } from '../vision/binarize';
import { labelComponents, maskFromLabels } from '../vision/components';
import { detectTextPolarity, orientForInk, type TextPolarity } from '../vision/polarity';
import { detectRules } from '../vision/rules';
import { estimateSkew } from '../vision/skew';
import { extractUpright } from '../vision/warp';
import { measureInk, type InkMetrics } from './inkMetrics';

/**
 * Everything measured from the pixels of one text element, in its upright
 * local frame. This is the "what does the original look like" half of the
 * visual fidelity engine.
 */
export interface RegionAnalysis {
  frame: OrientedBox;
  /** OCR text box in local coordinates. */
  textBox: Rect;
  /** Original pixels, upright. */
  patch: RasterImage;
  /** Estimated paper behind the text (text pixels inpainted). */
  background: RasterImage;
  /** Ink belonging to this element (rules and neighbours excluded). */
  ink: Mask;
  metrics: InkMetrics;
  backgroundColor: [number, number, number];
  noise: NoiseModel;
  slot: { left: number; right: number; leftBounded: boolean; rightBounded: boolean };
  inferredAlignment: TextAlignment;
  /** Dark ink on light paper, or light text on a dark background. */
  polarity: TextPolarity;
}

/** Oriented box of a local-frame rectangle. */
export function subFrame(frame: OrientedBox, r: Rect): OrientedBox {
  const c = toPage(frame, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  return { cx: c.x, cy: c.y, width: r.width, height: r.height, angle: frame.angle };
}

/** Ink mask of text with the given polarity (light text is binarised on inverted luminance). */
export function binarizeText(patch: RasterImage, textHeight: number, polarity: TextPolarity = 'dark'): Mask {
  return sauvola(orientForInk(luminance(patch), polarity), { radius: Math.max(8, textHeight), k: 0.25, minContrast: 14 });
}

export function removeRules(ink: Mask, textHeight: number): Mask {
  // Solid rules touching glyphs. Dashed rule fragments are handled by the
  // band filter in selectTextInk (bridging big gaps here would also bridge
  // the gaps between characters and eat text).
  const rules = detectRules(ink, Math.max(40, Math.round(textHeight * 2.5)));
  const out = createMask(ink.width, ink.height);
  for (let i = 0; i < ink.data.length; i++) out.data[i] = ink.data[i] && !rules.data[i] ? 1 : 0;
  return out;
}

/**
 * Select the ink components that belong to the text box: mostly inside it,
 * and not too tall (neighbouring lines, stamps, punch holes).
 */
export function selectTextInk(ink: Mask, textBox: Rect): Mask {
  const h = textBox.height;
  const core = { x0: textBox.x - 0.35 * h, x1: textBox.x + textBox.width + 0.35 * h, y0: textBox.y - 0.3 * h, y1: textBox.y + h * 1.3 };
  const cl = labelComponents(ink);
  const inside = cl.components.filter((c) => {
    if (c.y1 - c.y0 > h * 2.2) return false;
    const ix = Math.max(0, Math.min(c.x1, core.x1) - Math.max(c.x0, core.x0));
    const iy = Math.max(0, Math.min(c.y1, core.y1) - Math.max(c.y0, core.y0));
    const boxArea = (c.x1 - c.x0) * (c.y1 - c.y0);
    return boxArea > 0 && (ix * iy) / boxArea >= 0.6;
  });

  // Pass 2: establish the glyph band (cap line .. baseline) from tall
  // components, then drop flat fragments outside it. Those are pieces of
  // dashed/faint ruling lines; hyphens and dashes sit *inside* the band and
  // periods/commas touch the baseline, so they survive.
  const tall = inside.filter((c) => c.y1 - c.y0 >= h * 0.35);
  if (tall.length > 0) {
    const bottoms = tall.map((c) => c.y1).sort((a, b) => a - b);
    const tops = tall.map((c) => c.y0).sort((a, b) => a - b);
    const baseline = bottoms[Math.floor(bottoms.length / 2)];
    const capTop = tops[Math.floor(tops.length / 2)];
    const band = Math.max(1, baseline - capTop);
    const kept = inside.filter((c) => {
      const ch = c.y1 - c.y0;
      const cw = c.x1 - c.x0;
      const flat = ch < band * 0.3 && cw > ch * 1.5;
      if (!flat) return c.y0 < baseline + band * 0.5 && c.y1 > capTop - band * 0.5;
      return c.y0 <= baseline + band * 0.1 && c.y1 >= capTop - band * 0.05;
    });
    return maskFromLabels(cl, new Set(kept.map((c) => c.label)));
  }
  return maskFromLabels(cl, new Set(inside.map((c) => c.label)));
}

function framePadding(textHeight: number): number {
  return Math.max(6, Math.round(textHeight * 0.8));
}

export function analyzeRegion(page: RasterImage, box: OrientedBox): RegionAnalysis | undefined {
  const h = box.height;
  const pad = framePadding(h);
  let frame: OrientedBox = { ...box, width: Math.round(box.width + 2 * pad), height: Math.round(box.height + 2 * pad) };
  const textBox: Rect = { x: pad, y: pad, width: box.width, height: box.height };

  let patch = extractUpright(page, frame);
  // White headings on coloured banners etc.: every ink step below must look
  // for *lighter* strokes, and the background is the dark surface.
  const polarity = detectTextPolarity(luminance(patch), textBox);
  let ink = removeRules(binarizeText(patch, h, polarity), h);

  // Refine rotation locally: the page skew is only an average, and phone
  // captures bend and tilt differently across the page.
  if (box.width >= h * 3) {
    const skew = estimateSkew(selectTextInk(ink, textBox), 3);
    if (Math.abs(skew.angle) > (0.1 * Math.PI) / 180) {
      frame = { ...frame, angle: frame.angle + skew.angle };
      patch = extractUpright(page, frame);
      ink = removeRules(binarizeText(patch, h, polarity), h);
    }
  }

  // Everything that isn't clean background: the text itself, plus (for light
  // text) any dark marks on the banner.
  const allInk = binarizeText(patch, h, polarity);
  if (polarity === 'light') {
    const dark = binarizeText(patch, h, 'dark');
    for (let i = 0; i < allInk.data.length; i++) allInk.data[i] = allInk.data[i] || dark.data[i] ? 1 : 0;
  }
  const textInk = selectTextInk(ink, textBox);
  const metrics = measureInk(textInk);
  if (!metrics) return undefined;

  // Background: everything that is not ink, extended under the glyphs.
  const inkHalo = dilateMask(allInk, 2);
  const known = createMask(patch.width, patch.height);
  for (let i = 0; i < known.data.length; i++) known.data[i] = inkHalo.data[i] ? 0 : 1;
  const background = pushPullFill(patch, known);
  const noise = measureNoise(patch, known);
  const bgSamples: number[][] = [[], [], []];
  for (let i = 0; i < known.data.length; i++) {
    if (known.data[i]) for (let c = 0; c < 3; c++) bgSamples[c].push(patch.data[i * 4 + c]);
  }
  const backgroundColor = bgSamples.map((s) => (s.length ? median(s) : 255)) as [number, number, number];

  const { slot, inferredAlignment } = findSlot(page, frame, metrics);
  return { frame, textBox, patch, background, ink: textInk, metrics, backgroundColor, noise, slot, inferredAlignment, polarity };
}

/**
 * Look left and right of the text along its baseline for vertical ruling
 * lines (table cell borders, form boxes). They bound how far replacement
 * text may grow and reveal centred/right-aligned cell content.
 */
function findSlot(page: RasterImage, frame: OrientedBox, m: InkMetrics): Pick<RegionAnalysis, 'slot' | 'inferredAlignment'> {
  const h = m.height;
  const reach = Math.round(Math.max(h * 25, 200));
  const bandY = m.capTop - h * 0.2;
  const bandH = Math.max(4, Math.round(h * 1.4));

  const scan = (dir: 1 | -1): number | undefined => {
    const x = dir === 1 ? m.x1 + 1 : m.x0 - 1 - reach;
    const strip = extractUpright(page, subFrame(frame, { x, y: bandY, width: reach, height: bandH }));
    const ink = sauvola(luminance(strip), { radius: Math.max(8, h), k: 0.15, minContrast: 8 });
    const cols = strip.width;
    // A rule may lean by a pixel across the band (residual rotation), so a
    // row counts if either of two adjacent columns has ink there. Glyph
    // stems cover at most ~75% of the band; faint rules still cover >= 70%.
    const colRatio = (c: number) => {
      let n = 0;
      for (let y = 0; y < strip.height; y++) n += ink.data[y * cols + c] || (c + 1 < cols && ink.data[y * cols + c + 1]) ? 1 : 0;
      return n / strip.height;
    };
    for (let i = 0; i < cols; i++) {
      const c = dir === 1 ? i : cols - 1 - i;
      if (colRatio(c) >= 0.8) return x + c + (dir === 1 ? 0 : 1);
    }
    return undefined;
  };

  const right = scan(1);
  const left = scan(-1);
  const slot = {
    left: left ?? m.x0 - reach,
    right: right ?? m.x1 + reach,
    leftBounded: left !== undefined,
    rightBounded: right !== undefined,
  };
  let inferredAlignment: TextAlignment = 'left';
  if (left !== undefined && right !== undefined) {
    const lg = m.x0 - left;
    const rg = right - m.x1;
    if (Math.abs(lg - rg) < 0.25 * (lg + rg) + h * 0.5 && lg > h * 0.5 && rg > h * 0.5) inferredAlignment = 'center';
    else if (rg < lg * 0.3) inferredAlignment = 'right';
  }
  return { slot, inferredAlignment };
}
