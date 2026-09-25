import type { FidelityMetrics, FontCandidateScore, RenderParams } from '../document/model';
import { createMask } from '../image/filters';
import { renderCoverage, type TextRasterizer } from '../rendering/textRasterizer';
import { hasConnectedScript, type Script } from '../text/script';
import { candidateFonts, getFont, type CandidateFont } from './fontCatalog';
import { baselineWobble, chooseGlyphFonts, jitterFromWobble, variantDonors } from './glyphVariants';
import { measureInk } from './inkMetrics';
import type { RegionAnalysis } from './regionAnalysis';

/**
 * Typography fitting by analysis-by-synthesis.
 *
 *   1. For every candidate font/weight, derive size, horizontal scale and
 *      position from ink measurements (same measurement code as the scan).
 *   2. Render the OCR text, predict the scan as  B·(1-α) + I·α  where B is the
 *      reconstructed paper, α the blurred glyph coverage and I the ink colour
 *      solved in closed form, and score the photometric error.
 *   3. Refine the best candidates with coordinate descent over size, scale,
 *      position, spacing, weight, slant and optical blur.
 *   4. Pick glyph variants per character (see glyphVariants.ts) and, for
 *      handwriting, the natural variation measured from the baseline.
 *
 * The result is the rendering that *looks* most like the original, which is
 * what matters, rather than a claim about the font's name.
 */

export interface FitOptions {
  fonts?: readonly CandidateFont[];
  /**
   * Scripts of the document's OCR languages. Widens the candidates for
   * script-neutral text such as numbers (see `candidateFonts`).
   */
  contextScripts?: readonly Script[];
  /** How many coarse winners get the expensive refinement. */
  refineTop?: number;
  /** Max renders per refined candidate. */
  maxEvaluations?: number;
}

export interface FitResult {
  params: RenderParams;
  candidates: FontCandidateScore[];
  fidelity: FidelityMetrics;
}

interface Window {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Evaluation {
  cost: number;
  error: number;
  color: [number, number, number];
}

const REF_SIZE = 100;

export class CandidateEvaluator {
  readonly window: Window;
  /** Measured ink height of the scanned text, px. */
  readonly textHeight: number;
  private readonly O: Float32Array[];
  private readonly B: Float32Array[];
  evaluations = 0;

  constructor(
    private readonly region: RegionAnalysis,
    private readonly text: string,
    private readonly rasterizer: TextRasterizer,
  ) {
    const m = region.metrics;
    this.textHeight = m.height;
    const margin = Math.max(3, m.height * 0.35);
    const { width, height } = region.patch;
    this.window = {
      x0: Math.max(0, Math.floor(m.x0 - margin)),
      y0: Math.max(0, Math.floor(m.top - margin)),
      x1: Math.min(width, Math.ceil(m.x1 + margin)),
      y1: Math.min(height, Math.ceil(m.bottom + margin)),
    };
    this.O = [0, 1, 2].map((c) => channel(region.patch.data, c));
    this.B = [0, 1, 2].map((c) => channel(region.background.data, c));
  }

  coverage(params: RenderParams): Float32Array {
    this.evaluations++;
    return renderCoverage(this.rasterizer, this.text, params, this.region.patch.width, this.region.patch.height).data;
  }

  /**
   * Photometric error of a parameter set. The ink colour is solved by least
   * squares unless `fixedColor` is given (after calibration, see
   * {@link calibrateInkColor}).
   */
  evaluate(params: RenderParams, fixedColor?: [number, number, number]): Evaluation {
    const alpha = this.coverage(params);
    const { x0, y0, x1, y1 } = this.window;
    const w = this.region.patch.width;
    const color: [number, number, number] = fixedColor ? [...fixedColor] : [0, 0, 0];
    for (let c = 0; c < 3 && !fixedColor; c++) {
      let num = 0;
      let den = 0;
      const O = this.O[c];
      const B = this.B[c];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const a = alpha[i];
          num += a * (O[i] - B[i] * (1 - a));
          den += a * a;
        }
      }
      color[c] = den > 1e-6 ? Math.min(255, Math.max(0, num / den)) : 0;
    }
    let err = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const a = alpha[i];
        for (let c = 0; c < 3; c++) err += Math.abs(this.O[c][i] - (this.B[c][i] * (1 - a) + color[c] * a));
      }
    }
    const n = Math.max(1, (x1 - x0) * (y1 - y0) * 3);
    const error = err / n;
    // Mild preference for natural typography over distortion.
    const distortion = Math.max(0, Math.abs(params.scaleX - 1) - 0.06) + Math.abs(params.skewX) * 0.3;
    return { cost: error * (1 + distortion * 0.6), error, color };
  }

  /**
   * Least-squares colour is biased toward the paper whenever rendered and
   * scanned glyphs don't overlap perfectly (errors-in-variables: coverage
   * errors dilute the fitted contrast), so replacements come out lighter
   * than the original. Correct it by matching the darkness of the darkest
   * pixels (a low quantile, i.e. solid stroke cores) between the scan and
   * the prediction, per channel.
   */
  calibrateInkColor(params: RenderParams, quantile = 0.03): [number, number, number] {
    const alpha = this.coverage(params);
    const { x0, y0, x1, y1 } = this.window;
    const w = this.region.patch.width;
    const out: [number, number, number] = [...params.color];
    // Ink contrast is measured in the direction of the text: darker than the
    // background for dark text, lighter for light-on-dark text.
    const sign = this.region.polarity === 'light' ? -1 : 1;
    for (let c = 0; c < 3; c++) {
      const O = this.O[c];
      const B = this.B[c];
      const dO: number[] = [];
      const dP: number[] = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          dO.push(sign * (B[i] - O[i]));
          dP.push(sign * alpha[i] * (B[i] - params.color[c]));
        }
      }
      dO.sort((a, b) => b - a);
      dP.sort((a, b) => b - a);
      const k = Math.max(0, Math.floor(dO.length * quantile));
      const target = dO[k];
      const current = dP[k];
      if (!(current > 1) || !(target > 1)) continue;
      // Scale the ink contrast (B - I) so the quantiles agree; keep it within a sane range.
      const f = Math.min(1.8, Math.max(0.7, target / current));
      const bMean = B.reduce((a, b) => a + b, 0) / B.length;
      out[c] = Math.min(255, Math.max(0, bMean - f * (bMean - params.color[c])));
    }
    return out;
  }

  /**
   * Mean absolute error with a fixed ink colour, restricted to the given
   * column ranges of the window (e.g. the cells of one character).
   */
  errorIn(params: RenderParams, color: [number, number, number], columns: readonly [number, number][]): number {
    const alpha = this.coverage(params);
    const { y0, y1 } = this.window;
    const w = this.region.patch.width;
    let err = 0;
    let n = 0;
    for (const [a, b] of columns) {
      const xa = Math.max(this.window.x0, Math.floor(a));
      const xb = Math.min(this.window.x1, Math.ceil(b));
      for (let y = y0; y < y1; y++) {
        for (let x = xa; x < xb; x++) {
          const i = y * w + x;
          const al = alpha[i];
          for (let c = 0; c < 3; c++) err += Math.abs(this.O[c][i] - (this.B[c][i] * (1 - al) + color[c] * al));
          n += 3;
        }
      }
    }
    return n ? err / n : 0;
  }

  fidelity(params: RenderParams): FidelityMetrics {
    const { error } = this.evaluate(params, params.color);
    const alpha = this.coverage(params);
    const { width, height } = this.region.patch;
    const rendered = createMask(width, height);
    for (let i = 0; i < alpha.length; i++) rendered.data[i] = alpha[i] >= 0.4 ? 1 : 0;
    let inter = 0;
    let union = 0;
    const { x0, y0, x1, y1 } = this.window;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * width + x;
        const a = rendered.data[i];
        const b = this.region.ink.data[i];
        if (a && b) inter++;
        if (a || b) union++;
      }
    }
    const iou = union ? inter / union : 0;
    const om = this.region.metrics;
    const rm = measureInk(rendered);
    const contrast = Math.max(20, Math.abs(luminanceOf(this.region.backgroundColor) - luminanceOf(params.color)));
    const normalizedError = error / contrast;
    const score = Math.max(0, Math.min(1, 0.5 * iou + 0.5 * (1 - normalizedError * 4)));
    return {
      photometricError: error,
      silhouetteIoU: iou,
      widthRatio: rm ? rm.width / om.width : 0,
      heightRatio: rm ? rm.height / om.height : 0,
      strokeRatio: rm ? rm.stroke / om.stroke : 0,
      score,
    };
  }
}

function channel(data: Uint8ClampedArray, c: number): Float32Array {
  const out = new Float32Array(data.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + c];
  return out;
}

export function luminanceOf([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Measure the OCR text rendered at REF_SIZE with a given face. */
function referenceMetrics(r: TextRasterizer, text: string, fontId: string, weight: number, italic: boolean) {
  const base = { fontId, weight, italic, fontSize: REF_SIZE, scaleX: 1, letterSpacing: 0, wordSpacing: 0, skewX: 0, embolden: 0, originX: 20, baselineY: 130 };
  const width = Math.ceil(r.measure(text, base) + 60);
  const cov = r.coverage(text, base, width, 180);
  const mask = createMask(width, 180);
  for (let i = 0; i < cov.data.length; i++) mask.data[i] = cov.data[i] >= 0.5 ? 1 : 0;
  const m = measureInk(mask);
  return m ? { metrics: m, originX: base.originX } : undefined;
}

/** Initial parameters for one face, solved from ink measurements. */
function initialParams(region: RegionAnalysis, r: TextRasterizer, text: string, font: CandidateFont, weight: number, italic: boolean): RenderParams | undefined {
  const ref = referenceMetrics(r, text, font.id, weight, italic);
  if (!ref) return undefined;
  const o = region.metrics;
  const s = o.height / ref.metrics.height;
  const fontSize = REF_SIZE * s;
  const scaleX = o.width / (ref.metrics.width * s);
  if (!(scaleX > 0.6 && scaleX < 1.6)) return undefined;
  const strokeAtSize = ref.metrics.stroke * s;
  const embolden = Math.max(0, Math.min(o.stroke * 0.8, o.stroke - strokeAtSize));
  return {
    fontId: font.id,
    weight,
    italic,
    fontSize,
    scaleX,
    letterSpacing: 0,
    wordSpacing: 0,
    skewX: 0,
    embolden,
    blur: Math.max(0.4, Math.min(2, o.height * 0.03)),
    originX: o.x0 - (ref.metrics.x0 - ref.originX) * s * scaleX,
    baselineY: o.baseline,
    color: [0, 0, 0],
    opacity: 1,
  };
}

type NumericKey = 'fontSize' | 'scaleX' | 'originX' | 'baselineY' | 'letterSpacing' | 'embolden' | 'blur' | 'skewX';

interface Dimension {
  key: NumericKey;
  step: number;
  min: number;
  max: number;
  multiplicative?: boolean;
}

/** Coordinate descent with step halving. Returns the best params found. */
export function refine(
  evaluator: CandidateEvaluator,
  start: RenderParams,
  maxEvaluations: number,
  textHeight: number,
  fixedColor?: [number, number, number],
  connectedScript = false,
): { params: RenderParams; cost: number } {
  let dims: Dimension[] = [
    { key: 'originX', step: Math.max(1, textHeight * 0.08), min: -Infinity, max: Infinity },
    { key: 'baselineY', step: Math.max(0.75, textHeight * 0.06), min: -Infinity, max: Infinity },
    { key: 'fontSize', step: 0.04, min: 2, max: 1000, multiplicative: true },
    { key: 'scaleX', step: 0.04, min: 0.6, max: 1.6 },
    { key: 'letterSpacing', step: Math.max(0.3, textHeight * 0.03), min: -textHeight * 0.3, max: textHeight },
    { key: 'embolden', step: Math.max(0.3, textHeight * 0.03), min: 0, max: textHeight * 0.4 },
    { key: 'blur', step: 0.3, min: 0, max: 4 },
    { key: 'skewX', step: 0.06, min: -0.4, max: 0.4 },
  ];
  // Tracking would break the headline joining Devanagari letters; the width is fitted with scaleX instead.
  if (connectedScript) dims = dims.filter((d) => d.key !== 'letterSpacing');
  let best = { ...start };
  let bestCost = evaluator.evaluate(best, fixedColor).cost;
  const startCount = evaluator.evaluations;
  for (let round = 0; round < 6; round++) {
    let improved = true;
    while (improved && evaluator.evaluations - startCount < maxEvaluations) {
      improved = false;
      for (const d of dims) {
        for (const dir of [1, -1]) {
          const current = best[d.key];
          let value = d.multiplicative ? current * (1 + dir * d.step) : current + dir * d.step;
          value = Math.min(d.max, Math.max(d.min, value));
          if (value === current) continue;
          const candidate = { ...best, [d.key]: value };
          const cost = evaluator.evaluate(candidate, fixedColor).cost;
          if (cost < bestCost - 1e-6) {
            best = candidate;
            bestCost = cost;
            improved = true;
            break;
          }
        }
      }
    }
    for (const d of dims) d.step /= 2;
    if (evaluator.evaluations - startCount >= maxEvaluations) break;
  }
  return { params: { ...best, color: fixedColor ?? evaluator.evaluate(best).color }, cost: bestCost };
}

export function fitTypography(region: RegionAnalysis, sourceText: string, rasterizer: TextRasterizer, opts: FitOptions = {}): FitResult | undefined {
  const text = sourceText.trim();
  if (!text) return undefined;
  const fonts = opts.fonts ?? candidateFonts(text, opts.contextScripts);
  const connected = hasConnectedScript(text);
  const evaluator = new CandidateEvaluator(region, text, rasterizer);

  const coarse: { params: RenderParams; cost: number }[] = [];
  for (const font of fonts) {
    for (const weight of font.weights) {
      const p = initialParams(region, rasterizer, text, font, weight, false);
      if (!p) continue;
      const e = evaluator.evaluate(p);
      coarse.push({ params: { ...p, color: e.color }, cost: e.cost });
    }
  }
  if (coarse.length === 0) return undefined;
  coarse.sort((a, b) => a.cost - b.cost);

  const refined = coarse
    .slice(0, opts.refineTop ?? 3)
    .map((c) => refine(evaluator, c.params, opts.maxEvaluations ?? 220, region.metrics.height, undefined, connected))
    .sort((a, b) => a.cost - b.cost);

  // Calibrate the ink colour on the winner, then let the shape (weight, blur,
  // position) re-adapt to the corrected colour, and calibrate once more.
  const winner = refined[0];
  let color = evaluator.calibrateInkColor(winner.params);
  const reshaped = refine(evaluator, { ...winner.params, color }, Math.round((opts.maxEvaluations ?? 220) / 2), region.metrics.height, color, connected);
  color = evaluator.calibrateInkColor(reshaped.params);
  const best = { params: { ...reshaped.params, color }, cost: winner.cost };

  // Per-character glyph variants, judged against the other plausible fonts.
  const ranked = [...refined, ...coarse].map((r) => r.params.fontId);
  const glyphFonts = chooseGlyphFonts(evaluator, rasterizer, best.params, text, variantDonors(ranked, best.params.fontId));
  if (glyphFonts) best.params.glyphFonts = glyphFonts;
  if (getFont(best.params.fontId).category === 'handwriting') best.params.jitter = jitterFromWobble(baselineWobble(region));

  const refinedKeys = new Set(refined.map((r) => `${r.params.fontId}/${r.params.weight}`));
  const ranking = [...refined, ...coarse.filter((c) => !refinedKeys.has(`${c.params.fontId}/${c.params.weight}`))];
  const bestCost = best.cost;
  const candidates: FontCandidateScore[] = ranking.map((r) => ({
    fontId: r.params.fontId,
    weight: r.params.weight,
    italic: r.params.italic,
    // Relative similarity: 1 for the winner, decreasing with extra error.
    score: Math.max(0, Math.min(1, bestCost / Math.max(1e-6, r.cost))),
  }));
  return { params: best.params, candidates, fidelity: evaluator.fidelity(best.params) };
}
