import type { LayoutLine, PageLayout, TextElement } from '../document/model';
import { orientedFromAxisAligned, unionRects, type Rect } from '../geometry';
import { scriptsOf } from '../text/script';

/**
 * Handwriting readings applied to the document model: which readings are
 * credible, and how they replace Tesseract's fragments. Kept apart from the
 * line finder (handwritingPass.ts, image analysis in the worker) so the
 * editor bundle stays small.
 */

/**
 * Recogniser confidence needed to use a reading. Automatic mode would rather
 * miss a field than invent one: the user can still ask for a reading of any
 * selected text ("Read as handwriting").
 */
const ACCEPT_ABOVE = 0.45;

/** Page-OCR confidence (%) above which an element's text is kept as read. */
const KEEP_CONFIDENT = 85;

export interface HandwritingGroup {
  elementIds: string[];
  /** Page-pixel crop around the group (text box plus margin). */
  rect: Rect;
}

export interface HandwritingReading {
  text: string;
  /** 0..1 */
  confidence: number;
}

/**
 * Is a reading plausible for its crop? Recognisers trained on text
 * hallucinate on junk: repeated tokens ("000 000 000 …") or far more
 * characters than a line of this width can hold.
 */
export function plausibleReading(text: string, rect: Rect): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  if ([...counts.values()].some((n) => n >= 3)) return false;
  // One letter repeated ("mm", "iii"): ruled-paper texture, not writing.
  const alnum = text.replace(/[^\p{L}\p{N}]/gu, '');
  if (alnum.length >= 2 && /^(.)\1+$/u.test(alnum.toLowerCase())) return false;
  // Handwriting holds at most ~2.5 characters per line-height of width.
  return text.replace(/\s/g, '').length <= Math.max(3, (rect.width / Math.max(1, rect.height)) * 2.5);
}

export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Is a reading good enough to use without the user asking? Measured on real
 * forms: numbers read by digit-constrained decoding score 0.27–0.99 (their
 * score is taken under the unconstrained model); words need ≥ 0.45, and
 * short words ≥ 0.6, which keeps signatures and ornaments ("Gas", "an") out.
 */
export function acceptReading(r: HandwritingReading, rect: Rect): boolean {
  if (!plausibleReading(r.text, rect)) return false;
  const alnum = r.text.replace(/[^\p{L}\p{N}]/gu, '');
  if (!alnum) return false;
  if (/^[\d\s/\-.,:]+$/.test(r.text)) return r.confidence >= 0.25 && (alnum.length >= 2 || r.confidence >= 0.8);
  // One or two letters are almost always a stray mark or ruling, not an entry.
  if (alnum.length < 3) return false;
  if (alnum.length < 5) return r.confidence >= 0.6;
  return r.confidence >= ACCEPT_ABOVE;
}

/** Replace each group's fragments with one element holding the recogniser's reading, when credible. */
export function applyHandwritingReadings(
  content: { textElements: TextElement[]; layout: PageLayout },
  groups: readonly HandwritingGroup[],
  readings: readonly (HandwritingReading | undefined)[],
  skew: number,
  pageId: string,
): { textElements: TextElement[]; layout: PageLayout } {
  const replace = new Map<string, TextElement>();
  const drop = new Set<string>();
  const added: string[] = [];
  groups.forEach((g, i) => {
    const r = readings[i];
    if (!r || !acceptReading(r, g.rect)) return;
    const els = g.elementIds.map((id) => content.textElements.find((e) => e.id === id)!).filter(Boolean);
    // The model reads English: never replace text the page OCR read in another script.
    if (els.some((e) => [...scriptsOf(e.sourceText)].some((sc) => sc !== 'latin'))) return;
    // New text only where the page OCR found none: elsewhere it would duplicate a line read as part of another element.
    if (!els.length) {
      const box = shrink(g.rect);
      const covered = content.textElements.reduce((n, e) => n + overlap(e.bbox, box), 0);
      if (covered > box.width * box.height * 0.3) return;
    }
    // Print the page OCR read confidently is not handwriting: keep it (the model would paraphrase it).
    if (els.some((e) => e.ocrConfidence >= KEEP_CONFIDENT && e.sourceText.replace(/[^\p{L}\p{N}]/gu, '').length >= 3)) return;
    // Same text as the page OCR: nothing to fix, and its (often higher) confidence stays.
    const squash = (t: string) => t.replace(/\s+/g, '').toLowerCase();
    if (els.length && squash(els.map((e) => e.sourceText).join('')) === squash(r.text)) return;
    const inner = { x: g.rect.x, y: g.rect.y, width: g.rect.width, height: g.rect.height };
    const bbox = els.length ? unionRects([...els.map((e) => e.bbox), shrink(inner)]) : shrink(inner);
    // Text Tesseract missed completely becomes a new element on its own line (ids from its position: lines arrive one by one).
    const key = `${Math.round(g.rect.x)}-${Math.round(g.rect.y)}`;
    const first: TextElement = els[0] ?? {
      id: `${pageId}-hw${key}`,
      pageId,
      sourceText: '',
      text: '',
      bbox,
      box: orientedFromAxisAligned(bbox, skew),
      ocrConfidence: 0,
      readingOrder: content.textElements.length + i,
      lineId: `${pageId}-hwl${key}`,
      words: [],
      state: 'original',
      alignment: 'left',
    };
    if (!els.length) added.push(first.id);
    const confidence = Math.min(75, Math.round(r.confidence * 100));
    replace.set(first.id, {
      ...first,
      sourceText: r.text,
      text: r.text,
      bbox,
      box: orientedFromAxisAligned(bbox, skew),
      ocrConfidence: confidence,
      words: [{ text: r.text, bbox, confidence }],
      // Per-word styles were measured on the fragments; the element is re-measured when analysed.
      visualStyle: first.visualStyle,
      recognizer: 'handwriting',
    });
    for (const e of els.slice(1)) drop.add(e.id);
  });
  if (!replace.size) return content;
  const textElements = [...content.textElements.filter((e) => !drop.has(e.id)).map((e) => replace.get(e.id) ?? e), ...added.map((id) => replace.get(id)!)];
  const lines: LayoutLine[] = [
    ...content.layout.lines.map((l) => ({ ...l, elementIds: l.elementIds.filter((id) => !drop.has(id)) })),
    ...added.map((id) => ({ id: replace.get(id)!.lineId, elementIds: [id], bbox: replace.get(id)!.bbox })),
  ];
  return { textElements, layout: { ...content.layout, lines } };
}

/** The text box inside a crop rect (undo cropRect's margins). */
function shrink(r: Rect): Rect {
  const h = r.height / 1.3;
  const my = h * 0.15;
  const mx = h * 0.3;
  return { x: r.x + mx, y: r.y + my, width: Math.max(1, r.width - 2 * mx), height: Math.max(1, r.height - 2 * my) };
}
