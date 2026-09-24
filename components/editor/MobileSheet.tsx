'use client';

import { ChevronUp, PencilLine, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  /** Selected text, or undefined when nothing is selected. */
  title: string | undefined;
  onClose(): void;
  /** Collapse while the user needs the page (e.g. picking a style source). */
  forceCollapsed?: boolean;
  children: ReactNode;
}

/**
 * Non-modal bottom sheet for phones (Design.md: panel-handle).
 *
 * The page stays visible and tappable above it. Selecting text opens it
 * expanded; it can be collapsed to a one-line summary (tap the handle or drag
 * it down) and expanded again (tap or drag up). With no selection it shows a
 * short hint instead of hiding, so the next step is always obvious.
 */
export function MobileSheet({ title, onClose, children, forceCollapsed }: Props) {
  const [expanded, setExpanded] = useState(false);
  const dragStart = useRef<number | undefined>(undefined);

  useEffect(() => {
    setExpanded(title !== undefined && !forceCollapsed);
  }, [title, forceCollapsed]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragStart.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragStart.current === undefined) return;
    const dy = e.clientY - dragStart.current;
    dragStart.current = undefined;
    if (Math.abs(dy) < 8) setExpanded((v) => !v);
    else setExpanded(dy < 0);
  };

  return (
    <section
      aria-label="Text properties"
      className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-border bg-surface shadow-[0_-8px_30px_rgba(21,20,18,0.08)] md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <button
        type="button"
        className="flex w-full touch-none justify-center pt-2.5 pb-1"
        aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
        aria-expanded={expanded}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <span className="h-[3px] w-[30px] rounded-full bg-border-strong" />
      </button>

      {title === undefined ? (
        <p className="flex items-center gap-2 px-5 pt-1 pb-4 text-[13px] text-muted-foreground">
          <PencilLine className="size-4" aria-hidden /> Tap any text on the page to edit it.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 px-5 pb-2">
            <p className="min-w-0 flex-1 truncate font-semibold">{title || '(empty)'}</p>
            {!expanded && (
              <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setExpanded(true)}>
                <ChevronUp /> Edit
              </Button>
            )}
            <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
          <div className={cn('overflow-y-auto overscroll-contain transition-[max-height] duration-200', expanded ? 'max-h-[58dvh]' : 'max-h-0')}>{children}</div>
        </>
      )}
    </section>
  );
}
