'use client';

import { FilePlus2, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Point } from '@/core/geometry';
import { canExportPdf, exportPageImage, exportPdf } from '@/lib/browser/exportDocument';
import type { DocumentSession, SessionActivity } from '@/lib/session/documentSession';
import { getOcrLanguage } from '@/core/ocr/languages';
import { plausibleReading } from '@/core/ocr/handwritingReadings';

import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';
import { AppHeader } from '../AppHeader';
import { PageStatusView } from '../pages/PageStatusView';
import { ThumbnailRail } from '../pages/ThumbnailRail';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { ExportMenu, type ExportFormat } from '../toolbar/ExportMenu';
import { Toolbar, type ViewMode } from '../toolbar/Toolbar';
import { DocumentView, type CanvasMode } from './DocumentView';
import { MobileSheet } from './MobileSheet';
import { useEditor } from './useEditor';

/** Least confidence for a reading the user asked for (the background pass wants 0.25–0.6). */
const MANUAL_MIN_CONFIDENCE = 0.3;

const CANVAS_PADDING = 48;

/**
 * Editor layout (web-first, responsive):
 *  - lg+:  thumbnail rail | canvas | properties panel
 *  - md:   canvas | properties panel (page nav in the toolbar)
 *  - <md:  canvas + non-modal bottom sheet
 */
export function Editor({ client, session, onClose }: { client: ReconstructionClient; session: DocumentSession; onClose(): void }) {
  const ed = useEditor(client, session);
  const [zoom, setZoom] = useState(0.4);
  const [autoFit, setAutoFit] = useState(true);
  const [view, setView] = useState<ViewMode>('edited');
  // Boxes on every word are useful on a large screen but clutter a phone;
  // there, text stays tappable and the selected box is always outlined.
  const [showOverlays, setShowOverlays] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches);
  const [exporting, setExporting] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [editRequest, setEditRequest] = useState<{ id: string; nonce: number }>();
  const scrollRef = useRef<HTMLDivElement>(null);

  const doc = ed.history.present;
  const [canReadHandwriting, setCanReadHandwriting] = useState(false);
  const [activity, setActivity] = useState<SessionActivity>({});
  useEffect(() => session.subscribeActivity(setActivity), [session]);
  useEffect(() => {
    let live = true;
    void session.canReadHandwriting().then((ok) => live && setCanReadHandwriting(ok));
    return () => {
      live = false;
    };
  }, [session]);
  const output = ed.rendered ?? ed.original;
  const selected = ed.page.textElements.find((e) => e.id === ed.selectedId);
  const pagesDone = doc.pages.filter((p) => p.status === 'ready' || p.status === 'failed').length;
  const multi = doc.pages.length > 1;
  const picking = ed.pickTargetId !== undefined;
  const mode: CanvasMode = picking ? 'pick' : adding ? 'add' : 'select';
  const styleSource = selected?.styleSourceId ? doc.pages.flatMap((p) => p.textElements).find((e) => e.id === selected.styleSourceId) : undefined;

  // Fit the page width to the canvas area, until the user zooms manually.
  const fit = useCallback(() => {
    const el = scrollRef.current;
    const pageWidth = ed.page.width || ed.original?.width;
    if (!el || !pageWidth) return;
    const columns = view === 'side-by-side' ? 2 : 1;
    const available = (el.clientWidth - CANVAS_PADDING - (columns - 1) * 24) / columns;
    setZoom(Math.max(0.1, Math.min(1.5, available / pageWidth)));
  }, [ed.page.width, ed.original?.width, view]);

  useLayoutEffect(() => {
    if (autoFit) fit();
  }, [autoFit, fit]);

  useEffect(() => {
    if (!autoFit) return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFit, fit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAdding(false);
        ed.cancelPick();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        ed.undo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        ed.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ed.undo, ed.redo, ed.cancelPick]);

  const onExport = async (format: ExportFormat) => {
    ed.setError(undefined);
    try {
      if (format === 'pdf') {
        const { skipped } = await exportPdf(client, doc, (done, total) => setExporting(`Page ${Math.min(done + 1, total)}/${total}`));
        if (skipped > 0) ed.setError(`${skipped} page(s) could not be processed and were left out of the PDF.`);
      } else {
        setExporting('Exporting');
        await exportPageImage(client, doc, ed.page, format);
      }
    } catch (e) {
      ed.setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(undefined);
    }
  };

  const onPlace = async (at: Point) => {
    setAdding(false);
    setPlacing(true);
    try {
      const id = await ed.addTextAt(at);
      if (id) setEditRequest({ id, nonce: Date.now() });
    } finally {
      setPlacing(false);
    }
  };

  const commitText = (id: string, text: string) => {
    const el = ed.page.textElements.find((e) => e.id === id);
    // An added box left empty is removed rather than kept as an invisible element.
    if (el?.origin === 'added' && !text.trim()) {
      ed.run({ type: 'deleteElement', elementId: id });
      ed.select(undefined);
      return;
    }
    if (el && el.text !== text) ed.run({ type: 'setText', elementId: id, text });
  };

  const onMove = (id: string, dx: number, dy: number) => ed.run({ type: 'moveElement', elementId: id, dx, dy });

  const hw = activity.handwriting;
  const background = pagesDone < doc.pages.length ? `Reading pages ${pagesDone}/${doc.pages.length}` : hw ? `Reading handwriting ${hw.done + 1}/${hw.total}` : undefined;
  const status = ed.updating ? 'Updating…' : background;

  const readHandwriting = async (elementId: string) => {
    const page = doc.pages.find((p) => p.textElements.some((e) => e.id === elementId));
    const el = page?.textElements.find((e) => e.id === elementId);
    if (!page || !el) return false;
    const r = await session.readHandwriting(page.sourceRef, el.bbox);
    // Asked for explicitly, so the bar is lower than the background pass's, but junk (e.g. print in another script) is still refused.
    if (!r?.text || r.confidence < MANUAL_MIN_CONFIDENCE || !plausibleReading(r.text, el.bbox)) return false;
    ed.run({ type: 'setSourceText', elementId, sourceText: r.text });
    return true;
  };

  const panelProps = (el: typeof selected) => ({
    element: el,
    status: el ? ed.statusOf(el.id) : undefined,
    styleUnavailable: !!el && ed.styleUnavailable(el),
    overflowing: !!el && ed.overflowing.includes(el.id),
    run: ed.run,
    copiedStyle: ed.copiedStyle,
    onCopyStyle: () => void (el && ed.copyStyle(el.id)),
    onPasteStyle: () => el && ed.pasteStyle(el.id),
    onPickStyle: () => (el && !picking ? ed.startPick(el.id) : ed.cancelPick()),
    picking,
    styleSourceText: styleSource?.text,
    onReadHandwriting: canReadHandwriting && el ? () => readHandwriting(el.id) : undefined,
  });

  const viewProps = {
    zoom,
    showOverlays,
    mode,
    statusOf: ed.statusOf,
    onSelect: ed.select,
    onCommitText: commitText,
    onPlace: (at: Point) => void onPlace(at),
    onPick: (id: string) => void ed.pickFrom(id),
    onMove,
    editRequest,
  };

  const modeHint = picking
    ? multi
      ? 'Click any text (switch pages if you like) to copy its style.'
      : 'Click any text to copy its style.'
    : adding
      ? 'Click on the page where the new text should start.'
      : placing
        ? 'Matching the style of nearby text…'
        : undefined;

  return (
    // Tooltips (Radix + floating positioning) are editor-only, so their code
    // loads with the editor chunk rather than on the start page.
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col overflow-hidden">
        <AppHeader>
          <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground md:block" title={doc.source.fileName}>
            {doc.source.fileName}
          </span>
          <LanguageBadge languages={session.languages} detected={session.detection !== undefined} />
          <Button variant="ghost" className="h-9 rounded-lg" onClick={onClose} aria-label="New document">
            <FilePlus2 />
            <span className="hidden sm:inline">New</span>
          </Button>
          <ExportMenu
            busy={exporting}
            canExportPdf={canExportPdf(doc) && !exporting}
            canExportPage={ed.page.status === 'ready' && !exporting}
            pageCount={doc.pages.length}
            pageNumber={ed.pageIndex + 1}
            onExport={(f) => void onExport(f)}
          />
        </AppHeader>
        <Toolbar
          canUndo={ed.history.past.length > 0}
          canRedo={ed.history.future.length > 0}
          onUndo={ed.undo}
          onRedo={ed.redo}
          zoom={zoom}
          onZoom={(z) => {
            setAutoFit(false);
            setZoom(z);
          }}
          onFit={() => setAutoFit(true)}
          view={view}
          onView={setView}
          showOverlays={showOverlays}
          onToggleOverlays={setShowOverlays}
          pageIndex={ed.pageIndex}
          pages={doc.pages}
          onPage={ed.setPageIndex}
          status={status}
          adding={adding}
          onToggleAdd={() => {
            ed.cancelPick();
            setAdding((a) => !a);
            if (view !== 'edited') setView('edited');
          }}
        />
        {modeHint && (
          <div role="status" className="flex shrink-0 items-center gap-2 bg-brand px-4 py-2 text-[13px] font-medium text-white">
            {placing && <Loader2 className="size-4 animate-spin" aria-hidden />}
            <span className="min-w-0 flex-1">{modeHint}</span>
            {!placing && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2.5 text-white hover:bg-white/15 hover:text-white"
                onClick={() => {
                  setAdding(false);
                  ed.cancelPick();
                }}
              >
                <X /> Cancel <span className="hidden text-white/70 sm:inline">(Esc)</span>
              </Button>
            )}
          </div>
        )}
        {canReadHandwriting && !session.autoHandwriting && ed.page.textElements.some((e) => e.ocrConfidence < 60) && (
          <p role="status" className="shrink-0 bg-brand-light px-4 py-2 text-[12.5px] text-brand-text">
            Data Saver is on, so handwriting isn&apos;t read automatically. Tap the text, then <span className="font-medium">Read as handwriting</span>.
          </p>
        )}
        {session.warnings.map((w) => (
          <p key={w} role="status" className="shrink-0 bg-warn-light px-4 py-2 text-[12.5px] text-warn">
            {w}
          </p>
        ))}
        {ed.error && (
          <Alert variant="destructive" className="m-2 w-auto shrink-0 rounded-md border-danger-light bg-danger-light">
            <AlertDescription className="text-danger-text">{ed.error}</AlertDescription>
          </Alert>
        )}

        <div className="flex min-h-0 flex-1">
          {multi && (
            <div className="hidden lg:flex">
              <ThumbnailRail pages={doc.pages} current={ed.pageIndex} onSelect={ed.setPageIndex} client={client} />
            </div>
          )}
          <div className="relative min-w-0 flex-1">
            <main ref={scrollRef} aria-label="Page" className="absolute inset-0 overflow-auto bg-canvas-deep p-6 pb-40 md:pb-6">
              {ed.page.status !== 'ready' || !output || !ed.original ? (
                <PageStatusView page={ed.page} loading={ed.page.status === 'ready'} />
              ) : view === 'side-by-side' ? (
                <div className="mx-auto flex w-max gap-6">
                  <DocumentView image={ed.original} elements={[]} zoom={zoom} selectedId={undefined} showOverlays={false} onSelect={() => undefined} onCommitText={() => undefined} label="Original" />
                  <DocumentView {...viewProps} image={output} elements={ed.page.textElements} selectedId={ed.selectedId} label="Edited" />
                </div>
              ) : (
                <div className="mx-auto w-max">
                  <DocumentView
                    {...viewProps}
                    image={view === 'original' ? ed.original : output}
                    elements={view === 'original' ? [] : ed.page.textElements}
                    selectedId={ed.selectedId}
                    mode={view === 'original' ? 'select' : mode}
                  />
                </div>
              )}
            </main>
            {/* Visible progress over the page, not only in the toolbar corner. */}
            {ed.updating && ed.page.status === 'ready' && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute bottom-44 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-medium whitespace-nowrap text-primary-foreground shadow-lg md:bottom-6"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {ed.analyzing.size > 0 ? 'Matching the original style…' : 'Updating preview…'}
              </div>
            )}
            {/* Phones have no toolbar status: say quietly why text may still change. */}
            {!ed.updating && background && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground shadow-md md:hidden"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {background}
              </div>
            )}
          </div>
          <aside aria-label="Properties" className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface md:block xl:w-[340px]">
            <PropertiesPanel {...panelProps(selected)} />
          </aside>
        </div>

        <MobileSheet title={selected ? selected.text || 'New text' : undefined} onClose={() => ed.select(undefined)} forceCollapsed={picking || adding}>
          {selected && <PropertiesPanel key={selected.id} {...panelProps(selected)} />}
        </MobileSheet>
      </div>
    </TooltipProvider>
  );
}

/** The document's OCR languages; "detected" when Auto chose them. To change them, open the file again with other languages. */
function LanguageBadge({ languages, detected }: { languages: readonly string[]; detected: boolean }) {
  const names = languages.map((c) => getOcrLanguage(c)?.nativeName ?? c);
  const label = `${detected ? 'Detected' : 'Language'}: ${names.join(' + ')}`;
  return (
    <span className="hidden shrink-0 rounded-full bg-canvas px-2.5 py-1 text-[12px] text-muted-foreground lg:inline" title={`${label}. To read it in other languages, open the file again and pick them.`}>
      {label}
    </span>
  );
}
