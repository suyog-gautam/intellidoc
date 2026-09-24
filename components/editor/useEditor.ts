'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAddedElement } from '@/core/document/addedText';
import { createHistory, execute, redo, replacePresent, undo, type EditCommand, type History } from '@/core/document/history';
import { elementIsModified, type Page, type TextElement, type TypographyEstimate } from '@/core/document/model';
import type { Point } from '@/core/geometry';
import type { RasterImage } from '@/core/image/raster';
import { getFont } from '@/core/typography/fontCatalog';
import { effectiveStyle, type TextStyle } from '@/core/typography/styleTransfer';
import type { DocumentSession } from '@/lib/session/documentSession';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';

export type ElementStatus = 'analyzing' | 'rendering';

export interface CopiedStyle {
  style: TextStyle;
  sourceId: string;
  /** Human label, e.g. "Arimo Bold 32px". */
  label: string;
}

export interface EditorState {
  history: History;
  pageIndex: number;
  setPageIndex(i: number): void;
  page: Page;
  /** Original raster of the current page (undefined while loading / not ready). */
  original: RasterImage | undefined;
  /** Latest rendered output of the current page (same renderer as export). */
  rendered: RasterImage | undefined;
  rendering: boolean;
  analyzing: ReadonlySet<string>;
  /** Per-element progress so feedback can be shown right on the text. */
  statusOf(id: string): ElementStatus | undefined;
  /** True while any change is still being applied to the preview. */
  updating: boolean;
  overflowing: readonly string[];
  error: string | undefined;
  setError(e: string | undefined): void;
  selectedId: string | undefined;
  select(id: string | undefined): void;
  run(cmd: EditCommand): void;
  undo(): void;
  redo(): void;
  /** Place a new text box at a page point; style comes from the nearest recognised text. Returns its id. */
  addTextAt(at: Point): Promise<string | undefined>;
  copiedStyle: CopiedStyle | undefined;
  copyStyle(id: string): Promise<void>;
  pasteStyle(id: string): void;
  /** Eyedropper: the next text clicked (on any page) gives its style to `pickTargetId`. */
  pickTargetId: string | undefined;
  startPick(targetId: string): void;
  cancelPick(): void;
  pickFrom(sourceId: string): Promise<void>;
}

const RENDER_DEBOUNCE_MS = 120;

export function styleLabel(style: TextStyle): string {
  return `${getFont(style.fontId).displayName} ${style.weight >= 700 ? 'Bold' : 'Regular'} ${Math.round(style.fontSize)}px`;
}

/** Commands that change how an element looks, so its preview must be refreshed. */
function touchedElement(cmd: EditCommand): string | undefined {
  if (cmd.type === 'addElement') return cmd.element.id;
  if (cmd.type === 'updatePage' || cmd.type === 'setTypography') return undefined;
  return cmd.elementId;
}

export function useEditor(client: ReconstructionClient, session: DocumentSession): EditorState {
  const [history, setHistory] = useState<History>(() => createHistory(session.initial));
  const [pageIndex, setPageIndexState] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [original, setOriginal] = useState<{ pageId: string; image: RasterImage }>();
  const [rendered, setRendered] = useState<{ pageId: string; image: RasterImage }>();
  const [rendering, setRendering] = useState(false);
  const [analyzing, setAnalyzing] = useState<ReadonlySet<string>>(new Set());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [overflowing, setOverflowing] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const [copiedStyle, setCopiedStyle] = useState<CopiedStyle>();
  const [pickTargetId, setPickTargetId] = useState<string>();
  const inFlight = useRef(new Map<string, Promise<TypographyEstimate | undefined>>());
  const renderGeneration = useRef(0);
  const historyRef = useRef(history);
  historyRef.current = history;

  const page = history.present.pages[pageIndex];
  const ready = page.status === 'ready';

  // Background page processing results (not undoable edits).
  useEffect(() => session.subscribe((cmd) => setHistory((h) => replacePresent(h, cmd))), [session]);

  const setPageIndex = useCallback((i: number) => {
    setPageIndexState(i);
    setSelectedId(undefined);
  }, []);

  const locate = (id: string): { page: Page; element: TextElement } | undefined => {
    for (const p of historyRef.current.present.pages) {
      const element = p.textElements.find((e) => e.id === id);
      if (element) return { page: p, element };
    }
    return undefined;
  };

  // Fetch the untouched original of the current page from the worker.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    client
      .getOriginal(page.sourceRef)
      .then((image) => !cancelled && setOriginal({ pageId: page.id, image }))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, page.id, page.sourceRef, ready]);

  /** Analyse an element once (deduplicated); results update the model without an undo step. */
  const ensureAnalyzed = useCallback(
    (el: TextElement, onPage: Page): Promise<TypographyEstimate | undefined> => {
      if (el.typography) return Promise.resolve(el.typography);
      const running = inFlight.current.get(el.id);
      if (running) return running;
      const job = (async () => {
        setAnalyzing((s) => new Set(s).add(el.id));
        try {
          const typography = await client.analyze(onPage.sourceRef, onPage, el);
          if (!typography) setError(`Could not analyse the style of “${el.sourceText}”. It will not be re-rendered.`);
          setHistory((h) => {
            // Only apply if the source text wasn't corrected meanwhile.
            const current = h.present.pages[onPage.index].textElements.find((e) => e.id === el.id);
            if (!current || current.sourceText !== el.sourceText) return h;
            return replacePresent(h, { type: 'setTypography', elementId: el.id, typography });
          });
          return typography;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return undefined;
        } finally {
          inFlight.current.delete(el.id);
          setAnalyzing((s) => {
            const n = new Set(s);
            n.delete(el.id);
            return n;
          });
        }
      })();
      inFlight.current.set(el.id, job);
      return job;
    },
    [client],
  );

  // Analyse the selection eagerly, and any modified element missing typography.
  useEffect(() => {
    if (!ready) return;
    for (const el of page.textElements) {
      if (el.origin === 'added') continue;
      if (el.id === selectedId || (elementIsModified(el) && !el.typography)) void ensureAnalyzed(el, page);
    }
  }, [selectedId, page, ready, ensureAnalyzed]);

  // Re-render the current page when its model changes (debounced, latest wins).
  useEffect(() => {
    const generation = ++renderGeneration.current;
    if (!ready || !page.textElements.some(elementIsModified)) {
      setRendered(undefined);
      setOverflowing([]);
      setRendering(false);
      setDirty((d) => (d.size ? new Set() : d));
      return;
    }
    const pendingAnalysis = page.textElements.some((e) => elementIsModified(e) && !e.typography);
    const timer = setTimeout(async () => {
      setRendering(true);
      const covered = new Set(page.textElements.map((e) => e.id));
      try {
        const result = await client.render(page.sourceRef, page);
        if (generation !== renderGeneration.current) return;
        setRendered({ pageId: page.id, image: result.image });
        setOverflowing(result.overflowing);
        // Everything this render included is now up to date, except elements
        // still waiting for their style analysis (rendered on the next pass).
        if (!pendingAnalysis) setDirty((d) => new Set([...d].filter((id) => !covered.has(id))));
      } catch (e) {
        if (generation === renderGeneration.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (generation === renderGeneration.current) setRendering(false);
      }
    }, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, page, ready]);

  const run = useCallback((cmd: EditCommand) => {
    setError(undefined);
    const touched = touchedElement(cmd);
    if (touched) setDirty((d) => new Set(d).add(touched));
    setHistory((h) => {
      try {
        return execute(h, cmd);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return h;
      }
    });
  }, []);

  const addTextAt = useCallback(
    async (at: Point): Promise<string | undefined> => {
      const p = historyRef.current.present.pages[pageIndex];
      // Default style: the nearest recognised text (already analysed ones first).
      const candidates = p.textElements.filter((e) => e.origin !== 'added' && e.state !== 'deleted' && e.sourceText.trim().length > 1);
      if (candidates.length === 0) {
        setError('Add text needs at least one recognised text on this page to take a style from.');
        return undefined;
      }
      const dist = (e: TextElement) => Math.hypot(e.box.cx - at.x, e.box.cy - at.y) * (e.typography ? 0.8 : 1);
      const source = candidates.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      const typography = await ensureAnalyzed(source, p);
      if (!typography) return undefined;
      const id = `${p.id}-a${Date.now().toString(36)}`;
      const element = createAddedElement({ id, pageId: p.id, at, text: '', source: { id: source.id, typography, overrides: source.styleOverrides } });
      run({ type: 'addElement', pageId: p.id, element });
      setSelectedId(id);
      return id;
    },
    [pageIndex, ensureAnalyzed, run],
  );

  const styleOfElement = useCallback(
    async (id: string): Promise<TextStyle | undefined> => {
      const found = locate(id);
      if (!found) return undefined;
      const typography = found.element.typography ?? (await ensureAnalyzed(found.element, found.page));
      return typography && effectiveStyle(typography, found.element.styleOverrides);
    },
    [ensureAnalyzed],
  );

  const copyStyle = useCallback(
    async (id: string) => {
      const style = await styleOfElement(id);
      if (style) setCopiedStyle({ style, sourceId: id, label: styleLabel(style) });
    },
    [styleOfElement],
  );

  const pasteStyle = useCallback(
    (id: string) => {
      if (copiedStyle) run({ type: 'applyStyle', elementId: id, style: copiedStyle.style, sourceId: copiedStyle.sourceId });
    },
    [copiedStyle, run],
  );

  const pickFrom = useCallback(
    async (sourceId: string) => {
      const target = pickTargetId;
      if (!target || sourceId === target) return;
      setPickTargetId(undefined);
      const style = await styleOfElement(sourceId);
      if (!style) return;
      run({ type: 'applyStyle', elementId: target, style, sourceId });
      // Return to the element being styled (the source may be on another page).
      const back = locate(target);
      if (back) setPageIndexState(back.page.index);
      setSelectedId(target);
    },
    [pickTargetId, styleOfElement, run],
  );

  const statusOf = useCallback(
    (id: string): ElementStatus | undefined => (analyzing.has(id) ? 'analyzing' : dirty.has(id) ? 'rendering' : undefined),
    [analyzing, dirty],
  );

  return {
    history,
    pageIndex,
    setPageIndex,
    page,
    original: original?.pageId === page.id ? original.image : undefined,
    rendered: rendered?.pageId === page.id ? rendered.image : undefined,
    rendering,
    analyzing,
    statusOf,
    updating: rendering || dirty.size > 0 || analyzing.size > 0,
    overflowing,
    error,
    setError,
    selectedId,
    select: setSelectedId,
    run,
    undo: useCallback(() => setHistory(undo), []),
    redo: useCallback(() => setHistory(redo), []),
    addTextAt,
    copiedStyle,
    copyStyle,
    pasteStyle,
    pickTargetId,
    startPick: setPickTargetId,
    cancelPick: useCallback(() => setPickTargetId(undefined), []),
    pickFrom,
  };
}
