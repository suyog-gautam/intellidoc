import type { RenderParams, TypographyEstimate } from '../document/model';
import { createMask } from '../image/filters';
import type { TextRasterizer } from '../rendering/textRasterizer';
import { measureInk } from './inkMetrics';

/**
 * The part of RenderParams that describes how text *looks* (not where it is).
 * This is what "copy style", "paste style" and "match style from…" transfer
 * between elements, pages and user-added text boxes.
 */
export type TextStyle = Pick<
  RenderParams,
  'fontId' | 'weight' | 'italic' | 'fontSize' | 'scaleX' | 'letterSpacing' | 'wordSpacing' | 'skewX' | 'embolden' | 'blur' | 'color' | 'opacity'
>;

export const STYLE_KEYS: readonly (keyof TextStyle)[] = [
  'fontId',
  'weight',
  'italic',
  'fontSize',
  'scaleX',
  'letterSpacing',
  'wordSpacing',
  'skewX',
  'embolden',
  'blur',
  'color',
  'opacity',
];

export function extractStyle(p: RenderParams): TextStyle {
  const out = {} as Record<string, unknown>;
  for (const k of STYLE_KEYS) out[k] = Array.isArray(p[k]) ? [...(p[k] as number[])] : p[k];
  return out as TextStyle;
}

/** Style of an analysed element, including user overrides on top of the detection. */
export function effectiveStyle(est: TypographyEstimate, overrides?: Partial<RenderParams>): TextStyle {
  return extractStyle({ ...est.params, ...overrides });
}

const capCache = new Map<string, number>();

/** Cap height (px) of a face at 100px, measured from rendered pixels. */
function capHeight(r: TextRasterizer, fontId: string, weight: number): number {
  const key = `${fontId}/${weight}`;
  const cached = capCache.get(key);
  if (cached) return cached;
  const p = { fontId, weight, italic: false, fontSize: 100, scaleX: 1, letterSpacing: 0, wordSpacing: 0, skewX: 0, embolden: 0, originX: 10, baselineY: 120 };
  const cov = r.coverage('HXE', p, 260, 150);
  const mask = createMask(260, 150);
  for (let i = 0; i < cov.data.length; i++) mask.data[i] = cov.data[i] >= 0.5 ? 1 : 0;
  const h = measureInk(mask)?.height ?? 72;
  capCache.set(key, h);
  return h;
}

/**
 * Resolve the parameters to render with: detected params + user overrides.
 * When the user switches to a different font without choosing a size, the
 * size is re-derived so capital letters keep the same height on the page,
 * and the width scale fitted for the old font is reset.
 */
export function resolveParams(base: RenderParams, overrides: Partial<RenderParams> | undefined, rasterizer: TextRasterizer): RenderParams {
  const defined = Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v !== undefined)) as Partial<RenderParams>;
  const p = { ...base, ...defined };
  overrides = defined;
  const fontChanged = overrides?.fontId !== undefined && (overrides.fontId !== base.fontId || (overrides.weight ?? base.weight) !== base.weight);
  if (fontChanged && overrides?.fontSize === undefined) {
    const from = capHeight(rasterizer, base.fontId, base.weight);
    const to = capHeight(rasterizer, p.fontId, p.weight);
    p.fontSize = base.fontSize * (from / to);
    if (overrides?.scaleX === undefined) p.scaleX = 1;
    if (overrides?.letterSpacing === undefined) p.letterSpacing = 0;
  }
  return p;
}
