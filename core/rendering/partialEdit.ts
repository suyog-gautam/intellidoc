import type { RenderParams, TextElement } from '../document/model';
import { clusters, hasConnectedScript, hasRtl } from '../text/script';
import type { ReplacementLayout } from '../typography/layoutReplacement';
import type { TextRasterizer } from './textRasterizer';

/**
 * What to erase and what to draw for one edited element.
 *
 * The best rendering of a character that didn't change is the scan itself.
 * Changing "17652" to "17653" should touch only the "2": the untouched
 * characters keep their original pixels, whatever font the document used
 * (Preeti, a handwriting, a font no stand-in reproduces). Only the changed
 * middle is erased and rendered.
 */
export interface EditPlan {
  /** Local x range of the original text to erase; undefined = the whole element. */
  erase?: [number, number];
  /** Text to render (the changed part, or everything). */
  text: string;
  /** Render parameters for `text` (its pen origin moved to where it starts). */
  params: RenderParams;
  /** Pen advance of `text`. */
  advance: number;
}

/** Positions must agree this closely (px) for original pixels to stay in place. */
const SAME_PLACE = 0.6;

export function planEdit(el: TextElement, layout: ReplacementLayout, rasterizer: TextRasterizer): EditPlan {
  const full: EditPlan = { text: el.text, params: layout.params, advance: layout.advance };
  const est = el.typography;
  const source = el.sourceText;
  const next = el.text;
  // Anything that changes how all of the text looks needs a full re-render; so does text with no common part.
  if (!est || el.origin === 'added' || el.state === 'deleted' || layout.adjustments.length || hasStyleOverrides(el) || hasRtl(source) || hasRtl(next)) return full;
  const a = clusters(source);
  const b = clusters(next);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Never cut inside a joined word (Devanagari headline, Arabic joins): back off to a free boundary.
  while (p > 0 && p < a.length && (joined(a[p - 1], a[p]) || (p < b.length && joined(b[p - 1], b[p])))) p--;
  while (s > 0 && s < a.length && (joined(a[a.length - s - 1], a[a.length - s]) || (s < b.length && joined(b[b.length - s - 1], b[b.length - s])))) s--;
  if (p === 0 && s === 0) return full;

  const orig = est.params;
  const oldX = (i: number) => orig.originX + (i ? rasterizer.measure(a.slice(0, i).join(''), orig) : 0);
  const newX = (i: number) => layout.params.originX + (i ? rasterizer.measure(b.slice(0, i).join(''), layout.params) : 0);
  const keepPrefix = p > 0 && Math.abs(layout.params.originX - orig.originX) < SAME_PLACE;
  const keepSuffix = s > 0 && Math.abs(newX(b.length - s) - oldX(a.length - s)) < SAME_PLACE;
  if (!keepPrefix && !keepSuffix) return full;
  const from = keepPrefix ? p : 0;
  const toOld = keepSuffix ? a.length - s : a.length;
  const toNew = keepSuffix ? b.length - s : b.length;
  const text = b.slice(from, toNew).join('');
  const params = { ...layout.params, originX: newX(from) };
  return {
    erase: [keepPrefix ? oldX(p) : -Infinity, keepSuffix ? oldX(toOld) : Infinity],
    text,
    params,
    advance: text ? rasterizer.measure(text, params) : 0,
  };
}

function hasStyleOverrides(el: TextElement): boolean {
  return !!el.styleOverrides && Object.values(el.styleOverrides).some((v) => v !== undefined);
}

/**
 * Would a cut between these two clusters split a joined word? Letters of
 * headline and cursive scripts are joined to their neighbours; digits,
 * punctuation and spaces stand alone (Devanagari digits have no headline),
 * so "२०८०" → "२०८१" can keep "२०८" as scanned.
 */
function joined(left: string | undefined, right: string | undefined): boolean {
  const letter = (c: string | undefined) => !!c && /[\p{L}\p{M}]/u.test(c) && hasConnectedScript(c);
  return letter(left) && letter(right);
}
