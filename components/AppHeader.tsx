import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

/** Wordmark + on-device badge. `children` go on the right (e.g. editor actions). */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-7 place-items-center rounded-sm bg-primary text-[13px] font-semibold text-primary-foreground">
          iD
        </span>
        <span className="type-title">IntelliDoc</span>
      </div>
      <span className="ml-1 hidden items-center gap-1 rounded-full bg-ok-light px-2.5 py-1 text-[12px] font-medium text-ok-text sm:inline-flex">
        <ShieldCheck className="size-3.5" aria-hidden />
        Processed on this device
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>
    </header>
  );
}
