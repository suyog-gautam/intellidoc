import { applyHandwritingReadings, type HandwritingGroup, type HandwritingReading } from '../ocr/handwritingReadings';
import type { Id, IntellidocDocument, Page, RenderParams, TextAlignment, TextElement, TypographyEstimate } from './model';

/**
 * Command-based editing. Every change to the document model goes through a
 * command so that undo/redo is exact and edits are auditable (provenance).
 * Commands are pure: they return a new document and never mutate the input.
 */
export type EditCommand =
  | { type: 'setText'; elementId: Id; text: string }
  | { type: 'setSourceText'; elementId: Id; sourceText: string }
  | { type: 'deleteElement'; elementId: Id }
  | { type: 'restoreElement'; elementId: Id }
  | { type: 'setAlignment'; elementId: Id; alignment: TextAlignment }
  | { type: 'setStyleOverrides'; elementId: Id; overrides: Partial<RenderParams> | undefined }
  | { type: 'setTypography'; elementId: Id; typography: TypographyEstimate | undefined }
  /** Apply a style (font, size, colour…) taken from another element or chosen by the user. */
  | { type: 'applyStyle'; elementId: Id; style: Partial<RenderParams>; sourceId?: Id }
  /** Add a user text box to a page. */
  | { type: 'addElement'; pageId: Id; element: TextElement }
  /** Move a user-added text box by (dx, dy) page pixels. */
  | { type: 'moveElement'; elementId: Id; dx: number; dy: number }
  /**
   * Handwriting readings for a page (background pass after OCR). Not a user
   * edit: groups whose fragments the user already touched are left alone.
   */
  | { type: 'readHandwriting'; pageId: Id; groups: HandwritingGroup[]; readings: (HandwritingReading | undefined)[] }
  /** Processing output for a page (status, size, OCR content). Not a user edit. */
  | { type: 'updatePage'; pageId: Id; patch: Partial<Pick<Page, 'status' | 'statusMessage' | 'width' | 'height' | 'skew' | 'textElements' | 'layout'>> };

function updateElement(doc: IntellidocDocument, elementId: Id, fn: (el: TextElement) => TextElement): IntellidocDocument {
  let found = false;
  const pages = doc.pages.map((page) => {
    const idx = page.textElements.findIndex((e) => e.id === elementId);
    if (idx < 0) return page;
    found = true;
    const textElements = page.textElements.slice();
    textElements[idx] = fn(textElements[idx]);
    return { ...page, textElements };
  });
  if (!found) throw new Error(`Unknown text element ${elementId}`);
  return { ...doc, pages };
}

function editedState(el: TextElement, text: string): TextElement['state'] {
  return text === el.sourceText && !el.styleOverrides ? 'original' : 'edited';
}

export function applyCommand(doc: IntellidocDocument, cmd: EditCommand): IntellidocDocument {
  switch (cmd.type) {
    case 'updatePage': {
      if (!doc.pages.some((p) => p.id === cmd.pageId)) throw new Error(`Unknown page ${cmd.pageId}`);
      return { ...doc, pages: doc.pages.map((p) => (p.id === cmd.pageId ? { ...p, ...cmd.patch } : p)) };
    }
    case 'readHandwriting': {
      const page = doc.pages.find((p) => p.id === cmd.pageId);
      if (!page) throw new Error(`Unknown page ${cmd.pageId}`);
      const untouched = (id: Id) => page.textElements.find((e) => e.id === id)?.state === 'original';
      const keep = cmd.groups.map((g) => g.elementIds.every(untouched));
      const content = applyHandwritingReadings(
        page,
        cmd.groups.filter((_, i) => keep[i]),
        cmd.readings.filter((_, i) => keep[i]),
        page.skew,
        page.id,
      );
      return { ...doc, pages: doc.pages.map((p) => (p.id === page.id ? { ...p, ...content } : p)) };
    }
    case 'setText':
      return updateElement(doc, cmd.elementId, (el) => ({ ...el, text: cmd.text, state: editedState(el, cmd.text) }));
    case 'setSourceText':
      // Correcting OCR invalidates typography fitted against the wrong glyphs.
      return updateElement(doc, cmd.elementId, (el) => {
        const text = el.state === 'original' ? cmd.sourceText : el.text;
        const next = { ...el, sourceText: cmd.sourceText, text, typography: undefined };
        return { ...next, state: el.state === 'deleted' ? 'deleted' : editedState(next, text) };
      });
    case 'deleteElement':
      return updateElement(doc, cmd.elementId, (el) => ({ ...el, state: 'deleted' }));
    case 'restoreElement':
      return updateElement(doc, cmd.elementId, (el) => ({ ...el, state: editedState(el, el.text) }));
    case 'setAlignment':
      return updateElement(doc, cmd.elementId, (el) => ({ ...el, alignment: cmd.alignment, alignmentLocked: true }));
    case 'setStyleOverrides':
      return updateElement(doc, cmd.elementId, (el) => {
        const next = { ...el, styleOverrides: cmd.overrides, styleSourceId: cmd.overrides ? el.styleSourceId : undefined };
        return { ...next, state: el.state === 'deleted' ? 'deleted' : editedState(next, el.text) };
      });
    case 'applyStyle':
      return updateElement(doc, cmd.elementId, (el) => {
        // `undefined` in the patch means "back to detected" for that property.
        const merged: Record<string, unknown> = { ...el.styleOverrides, ...cmd.style };
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        const styleOverrides = Object.keys(merged).length ? (merged as Partial<RenderParams>) : undefined;
        const next = { ...el, styleOverrides, styleSourceId: cmd.sourceId ?? (styleOverrides ? el.styleSourceId : undefined) };
        return { ...next, state: el.state === 'deleted' ? 'deleted' : el.origin === 'added' ? 'edited' : editedState(next, el.text) };
      });
    case 'addElement': {
      if (!doc.pages.some((p) => p.id === cmd.pageId)) throw new Error(`Unknown page ${cmd.pageId}`);
      return { ...doc, pages: doc.pages.map((p) => (p.id === cmd.pageId ? { ...p, textElements: [...p.textElements, cmd.element] } : p)) };
    }
    case 'moveElement':
      return updateElement(doc, cmd.elementId, (el) => {
        if (el.origin !== 'added') throw new Error('Only added text boxes can be moved');
        const shift = <T extends { cx: number; cy: number }>(b: T): T => ({ ...b, cx: b.cx + cmd.dx, cy: b.cy + cmd.dy });
        return {
          ...el,
          box: shift(el.box),
          bbox: { ...el.bbox, x: el.bbox.x + cmd.dx, y: el.bbox.y + cmd.dy },
          typography: el.typography && { ...el.typography, frame: shift(el.typography.frame) },
        };
      });
    case 'setTypography':
      return updateElement(doc, cmd.elementId, (el) => ({
        ...el,
        typography: cmd.typography,
        alignment: !el.alignmentLocked && cmd.typography ? cmd.typography.inferredAlignment : el.alignment,
      }));
  }
}

export interface History {
  readonly present: IntellidocDocument;
  readonly past: readonly IntellidocDocument[];
  readonly future: readonly IntellidocDocument[];
}

const MAX_HISTORY = 200;

export function createHistory(doc: IntellidocDocument): History {
  return { present: doc, past: [], future: [] };
}

/**
 * Apply a user edit. `setTypography` / `updatePage` are processing output, not a user action, so
 * callers should use {@link replacePresent} for it to keep it out of undo.
 */
export function execute(h: History, cmd: EditCommand): History {
  const next = applyCommand(h.present, cmd);
  const past = [...h.past, h.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { present: next, past, future: [] };
}

/** Update the present without creating an undo step (e.g. background analysis results). */
export function replacePresent(h: History, cmd: EditCommand): History {
  const apply = (d: IntellidocDocument) => {
    try {
      return applyCommand(d, cmd);
    } catch {
      return d;
    }
  };
  return { present: apply(h.present), past: h.past.map(apply), future: h.future.map(apply) };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  return { present: previous, past: h.past.slice(0, -1), future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { present: next, past: [...h.past, h.present], future: rest };
}
