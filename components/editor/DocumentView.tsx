'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { addedTextBox } from '@/core/document/addedText';
import type { TextElement } from '@/core/document/model';
import type { OrientedBox, Point } from '@/core/geometry';
import type { RasterImage } from '@/core/image/raster';
import { cn } from '@/lib/utils';
import type { ElementStatus } from './useEditor';

export type CanvasMode = 'select' | 'add' | 'pick';

interface Props {
  image: RasterImage;
  elements: readonly TextElement[];
  zoom: number;
  selectedId: string | undefined;
  showOverlays: boolean;
  onSelect(id: string | undefined): void;
  onCommitText(id: string, text: string): void;
  label?: string;
  mode?: CanvasMode;
  statusOf?(id: string): ElementStatus | undefined;
  /** 'add' mode: page point (baseline start) where the user clicked. */
  onPlace?(at: Point): void;
  /** 'pick' mode: element whose style was picked. */
  onPick?(id: string): void;
  /** Move a user-added box by page pixels. */
  onMove?(id: string, dx: number, dy: number): void;
  /** Open the inline editor for this element (e.g. right after adding it). */
  editRequest?: { id: string; nonce: number };
}

function confidenceClass(el: TextElement): string {
  if (el.origin === 'added' || el.state !== 'original') return 'el-edited';
  if (el.ocrConfidence < 60) return 'el-low';
  if (el.ocrConfidence < 85) return 'el-mid';
  return 'el-high';
}

function displayBox(el: TextElement): OrientedBox {
  return el.origin === 'added' && el.typography ? addedTextBox(el.typography.frame, el.typography, el.text, el.styleOverrides) : el.box;
}

const STATUS_LABEL: Record<ElementStatus, string> = { analyzing: 'Matching style…', rendering: 'Updating…' };

/**
 * The document surface: the rendered page on a canvas, plus an editor-only
 * DOM layer (element boxes, inline editor, progress tags). That layer is
 * never part of the rendered raster, so it can never leak into exports.
 *
 * Interaction: click/tap selects; double-click, Enter/F2, or tapping an
 * already selected box edits in place. Added boxes can be dragged or nudged
 * with the arrow keys (Shift = 10 px).
 */
export function DocumentView(p: Props) {
  const { image, elements, zoom, selectedId, showOverlays, onSelect, onCommitText, label, mode = 'select', statusOf, onPlace, onPick, onMove, editRequest } = p;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | undefined>(undefined);
  const [dragOffset, setDragOffset] = useState<{ id: string; dx: number; dy: number }>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [image]);

  const startEdit = (el: TextElement) => {
    onSelect(el.id);
    setEditingId(el.id);
    setDraft(el.text);
  };

  useEffect(() => {
    if (!editRequest) return;
    const el = elements.find((e) => e.id === editRequest.id);
    if (el) startEdit(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest?.nonce]);

  const commit = () => {
    if (editingId) onCommitText(editingId, draft);
    setEditingId(undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEditingId(undefined);
  };

  const onSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode === 'add' && onPlace) {
      const r = e.currentTarget.getBoundingClientRect();
      onPlace({ x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom });
      return;
    }
    if (mode === 'select') onSelect(undefined);
  };

  const onBoxPointerDown = (e: PointerEvent<HTMLButtonElement>, el: TextElement) => {
    if (mode !== 'select' || el.origin !== 'added' || el.id !== selectedId) return;
    drag.current = { id: el.id, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onBoxPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setDragOffset({ id: d.id, dx, dy });
  };
  const onBoxPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = undefined;
    setDragOffset(undefined);
    if (d?.moved && onMove) {
      onMove(d.id, (e.clientX - d.x) / zoom, (e.clientY - d.y) / zoom);
      // Swallow the click that follows a drag.
      e.currentTarget.dataset.dragged = '1';
    }
  };

  const w = image.width * zoom;
  const h = image.height * zoom;
  return (
    <figure className="m-0 shrink-0">
      {label && <figcaption className="type-label mb-2 text-muted-foreground">{label}</figcaption>}
      <div
        className={cn('relative bg-surface shadow-[0_1px_3px_rgba(21,20,18,0.08),0_8px_24px_rgba(21,20,18,0.06)]', mode === 'add' && 'cursor-crosshair', mode === 'pick' && 'cursor-copy')}
        style={{ width: w, height: h }}
        onClick={onSurfaceClick}
      >
        <canvas ref={canvasRef} className="block" style={{ width: w, height: h }} aria-label={label ?? 'Document page'} />
        <div className={cn('absolute inset-0', mode === 'add' && 'pointer-events-none')}>
          {elements.map((el) => {
            if (el.origin === 'added' && el.state === 'deleted') return null;
            const box = displayBox(el);
            const off = dragOffset?.id === el.id ? dragOffset : undefined;
            const style = {
              left: (box.cx - box.width / 2) * zoom + (off?.dx ?? 0),
              top: (box.cy - box.height / 2) * zoom + (off?.dy ?? 0),
              width: box.width * zoom,
              height: box.height * zoom,
              transform: `rotate(${box.angle}rad)`,
            };
            const selected = el.id === selectedId;
            const status = statusOf?.(el.id);
            if (editingId === el.id) {
              return (
                <input
                  key={el.id}
                  className="inline-editor"
                  style={{ ...style, fontSize: Math.max(12, box.height * zoom * 0.7), width: Math.max(style.width, 160) }}
                  value={draft}
                  autoFocus
                  placeholder={el.origin === 'added' ? 'Type text…' : undefined}
                  aria-label={el.origin === 'added' ? 'New text' : `Edit text: ${el.sourceText}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  onBlur={commit}
                  onClick={(e) => e.stopPropagation()}
                />
              );
            }
            return (
              <div key={el.id}>
                <button
                  type="button"
                  className={cn(
                    'el-box',
                    (showOverlays || selected || el.origin === 'added') && confidenceClass(el),
                    el.origin === 'added' && 'border-dashed',
                    selected && 'el-selected',
                    mode === 'pick' && el.id !== p.selectedId && 'el-pickable',
                    status && 'el-busy',
                    selected && el.origin === 'added' && mode === 'select' && 'cursor-move touch-none',
                  )}
                  style={style}
                  title={el.origin === 'added' ? 'Added text' : `${el.text} (OCR ${el.ocrConfidence.toFixed(0)}%)`}
                  aria-label={`${el.origin === 'added' ? 'Added text' : 'Text'}: ${el.text || '(empty)'}`}
                  aria-pressed={selected}
                  onPointerDown={(e) => onBoxPointerDown(e, el)}
                  onPointerMove={onBoxPointerMove}
                  onPointerUp={onBoxPointerUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.currentTarget.dataset.dragged) {
                      delete e.currentTarget.dataset.dragged;
                      return;
                    }
                    if (mode === 'pick') {
                      if (el.origin !== 'added') onPick?.(el.id);
                      return;
                    }
                    if (selected) startEdit(el);
                    else onSelect(el.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (mode === 'select') startEdit(el);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'F2') {
                      e.preventDefault();
                      if (mode === 'pick') onPick?.(el.id);
                      else startEdit(el);
                      return;
                    }
                    if (el.origin === 'added' && selected && onMove && e.key.startsWith('Arrow')) {
                      e.preventDefault();
                      const step = (e.shiftKey ? 10 : 1) / zoom;
                      onMove(el.id, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
                    }
                  }}
                />
                {status && (
                  <span
                    role="status"
                    className="pointer-events-none absolute z-[3] flex -translate-y-full items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-primary-foreground shadow"
                    style={{ left: style.left, top: style.top - 4 }}
                  >
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    {STATUS_LABEL[status]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </figure>
  );
}
