'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { elementIsModified, type Page } from '@/core/document/model';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';
import { cn } from '@/lib/utils';

const THUMB_WIDTH = 96;

/**
 * Page rail for multi-page documents. Thumbnails are small JPEGs made by the
 * worker and requested only when scrolled into view, so a 50-page PDF
 * doesn't decode 50 previews up front.
 */
export function ThumbnailRail({ pages, current, onSelect, client }: { pages: readonly Page[]; current: number; onSelect(i: number): void; client: ReconstructionClient }) {
  return (
    <nav aria-label="Pages" className="flex w-[136px] shrink-0 flex-col border-r border-border bg-surface">
      <p className="type-label px-4 pt-4 pb-2 text-muted-foreground">
        Pages <span className="type-num ml-1 text-[10px]">{pages.length}</span>
      </p>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {pages.map((p) => (
          <li key={p.id}>
            <Thumb page={p} active={p.index === current} onClick={() => onSelect(p.index)} client={client} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Thumb({ page, active, onClick, client }: { page: Page; active: boolean; onClick(): void; client: ReconstructionClient }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const ready = page.status === 'ready';
  const edited = page.textElements.some(elementIsModified);
  const aspect = page.physical.heightPt / Math.max(1, page.physical.widthPt);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !ready || url) return;
    let revoked = false;
    let objectUrl: string | undefined;
    client
      .thumbnail(page.sourceRef, THUMB_WIDTH * 2)
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ready, client, page.sourceRef]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={`Page ${page.index + 1}${page.status !== 'ready' ? ` (${page.status})` : ''}${edited ? ', edited' : ''}`}
      className="group block w-full text-left"
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-sm border bg-canvas transition-shadow',
          active ? 'border-brand ring-2 ring-brand/25' : 'border-border-mid group-hover:border-border-strong',
        )}
        style={{ aspectRatio: `1 / ${aspect}` }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-tertiary">
            {page.status === 'failed' ? <AlertTriangle className="size-4 text-danger" aria-hidden /> : <Loader2 className={cn('size-4', page.status !== 'pending' && 'animate-spin')} aria-hidden />}
          </span>
        )}
        {edited && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ok ring-2 ring-surface" />}
      </span>
      <span className={cn('type-num mt-1.5 block text-center text-[11px]', active ? 'text-brand-text' : 'text-muted-foreground')}>
        {page.index + 1}
        {page.status === 'processing' && <span className="ml-1 font-sans text-[10px]">reading…</span>}
        {page.status === 'pending' && <span className="ml-1 font-sans text-[10px]">queued</span>}
      </span>
    </button>
  );
}
