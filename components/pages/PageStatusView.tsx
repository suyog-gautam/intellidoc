'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { Page } from '@/core/document/model';

/** Placeholder for pages that are still being processed or failed. */
export function PageStatusView({ page, loading }: { page: Page; loading: boolean }) {
  const failed = page.status === 'failed';
  let title: string;
  let text: string;
  if (loading) {
    title = 'Loading page…';
    text = '';
  } else if (failed) {
    title = `Page ${page.index + 1} couldn't be read`;
    text = page.statusMessage ?? 'This page could not be processed.';
  } else if (page.status === 'processing') {
    title = `Reading page ${page.index + 1}…`;
    text = 'Recognising text in the background. You can keep editing other pages.';
  } else {
    title = `Page ${page.index + 1} is queued`;
    text = 'Pages are read one after another in the background.';
  }
  return (
    <div role="status" aria-live="polite" className="mx-auto mt-16 flex max-w-sm flex-col items-center rounded-xl border border-border bg-surface p-8 text-center">
      {failed ? <AlertTriangle className="size-6 text-danger" aria-hidden /> : <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />}
      <p className="type-title mt-3">{title}</p>
      {text && <p className="mt-1 text-[13px] text-muted-foreground">{text}</p>}
    </div>
  );
}
