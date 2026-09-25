import type { OrientedBox, Point } from '../geometry';
import { clusters } from '../text/script';
import { orientedBoundingRect } from '../geometry';
import type { Id, RenderParams, TextElement, TypographyEstimate } from './model';

export interface AddTextOptions {
  id: Id;
  pageId: Id;
  /** Page point where the text's baseline starts (left end). */
  at: Point;
  text: string;
  /** Style source: an analysed element's estimate and its user overrides. */
  source: { id: Id; typography: TypographyEstimate; overrides?: Partial<RenderParams> };
}

/**
 * Create a user text box that looks like `source`: same font, size, weight,
 * ink colour, optical blur and rotation. The source's analysis frame is
 * reused (so the renderer has the same local geometry), re-anchored so the
 * pen origin lands on the clicked point. Nothing is removed from the page.
 */
export function createAddedElement(o: AddTextOptions): TextElement {
  const src = o.source.typography;
  const { width: W, height: H, angle } = src.frame;
  const originX = Math.max(4, src.measured.inkHeight * 0.4);
  const baselineY = src.params.baselineY;
  // Local (originX, baselineY) must map to o.at: centre = at - R(angle)·(origin - size/2).
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lx = originX - W / 2;
  const ly = baselineY - H / 2;
  const frame: OrientedBox = { cx: o.at.x - (lx * c - ly * s), cy: o.at.y - (lx * s + ly * c), width: W, height: H, angle };
  const typography: TypographyEstimate = {
    ...src,
    frame,
    textBox: { x: originX, y: baselineY - src.measured.inkHeight, width: 1, height: src.measured.inkHeight },
    // A free-standing box can grow in both directions.
    slot: { left: -1e6, right: 1e6, leftBounded: false, rightBounded: false },
    inferredAlignment: 'left',
    params: { ...src.params, originX, baselineY },
  };
  const box = addedTextBox(frame, typography, o.text, o.source.overrides);
  return {
    id: o.id,
    pageId: o.pageId,
    origin: 'added',
    sourceText: '',
    text: o.text,
    bbox: orientedBoundingRect(box),
    box,
    ocrConfidence: 100,
    readingOrder: Number.MAX_SAFE_INTEGER,
    lineId: `${o.id}-line`,
    words: [],
    state: 'edited',
    alignment: 'left',
    typography,
    styleOverrides: o.source.overrides ? { ...o.source.overrides } : undefined,
    styleSourceId: o.source.id,
  };
}

/**
 * Approximate on-page box of an added text (for the editor overlay; the exact
 * glyph extent is only known to the renderer). ~0.55 em per character.
 */
export function addedTextBox(frame: OrientedBox, est: TypographyEstimate, text: string, overrides?: Partial<RenderParams>): OrientedBox {
  const p = { ...est.params, ...overrides };
  const h = Math.max(est.measured.inkHeight, p.fontSize * 0.72) * 1.35;
  const w = Math.max(h * 1.5, clusters(text).length * p.fontSize * 0.55 * p.scaleX + p.letterSpacing * text.length);
  // Box from the pen origin rightwards, centred on the cap-height band.
  const lx = est.params.originX + w / 2 - frame.width / 2;
  const ly = est.params.baselineY - h * 0.4 - frame.height / 2;
  const c = Math.cos(frame.angle);
  const s = Math.sin(frame.angle);
  return { cx: frame.cx + lx * c - ly * s, cy: frame.cy + lx * s + ly * c, width: w, height: h, angle: frame.angle };
}
