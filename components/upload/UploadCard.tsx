'use client';

import { FileUp, Loader2 } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { OpenProgress } from '@/lib/session/documentSession';
import { cn } from '@/lib/utils';
import { LanguagePicker } from './LanguagePicker';

const STAGE_LABEL: Record<OpenProgress['stage'], string> = {
  validating: 'Checking file',
  decoding: 'Opening file',
  rendering: 'Rendering PDF page',
  preprocessing: 'Preparing page',
  ocr: 'Recognising text',
  recovery: 'Double-checking unclear text',
  building: 'Building editable document',
};

const STAGE_ORDER: OpenProgress['stage'][] = ['validating', 'decoding', 'rendering', 'preprocessing', 'ocr', 'recovery', 'building'];

/** Overall 0..100 estimate: OCR dominates, so it gets most of the bar. */
function overallPercent(p: OpenProgress): number {
  const weights: Record<OpenProgress['stage'], [number, number]> = {
    validating: [0, 3],
    decoding: [3, 8],
    rendering: [8, 15],
    preprocessing: [15, 22],
    ocr: [22, 82],
    recovery: [82, 95],
    building: [95, 100],
  };
  const [from, to] = weights[p.stage];
  return Math.round(from + (to - from) * (p.progress ?? 0.3));
}

interface Props {
  onFile(file: File): void;
  onIntent(): void;
  progress?: OpenProgress;
  error?: string;
  languages: string[];
  onLanguages(codes: string[]): void;
}

export function UploadCard({ onFile, onIntent, progress, error, languages, onLanguages }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const openPicker = () => input.current?.click();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  if (progress) {
    const pct = overallPercent(progress);
    const multi = progress.pageCount !== undefined && progress.pageCount > 1;
    return (
      <section aria-live="polite" className="flex flex-col justify-center rounded-2xl bg-primary p-6 text-primary-foreground shadow-sm sm:p-8 lg:h-full">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin opacity-80" aria-hidden />
          <p className="type-title">{STAGE_LABEL[progress.stage]}…</p>
        </div>
        <div className="mt-6 flex items-end justify-between">
          <span className="type-num text-[31px] leading-none">{pct}%</span>
          {multi && <span className="type-num text-[13px] opacity-70">page 1 of {progress.pageCount}</span>}
        </div>
        <div role="progressbar" aria-label="Processing progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-white transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
        <ol className="mt-6 grid gap-1.5 text-[12.5px]">
          {STAGE_ORDER.filter((s) => s !== 'rendering' || multi || progress.stage === 'rendering').map((s) => {
            const idx = STAGE_ORDER.indexOf(s);
            const cur = STAGE_ORDER.indexOf(progress.stage);
            return (
              <li key={s} className={cn('flex items-center gap-2', idx > cur && 'opacity-40', idx === cur && 'font-semibold')}>
                <span aria-hidden className={cn('size-1.5 rounded-full', idx <= cur ? 'bg-white' : 'bg-white/40')} />
                {STAGE_LABEL[s]}
              </li>
            );
          })}
        </ol>
        {multi && <p className="mt-6 text-[12px] opacity-70">The editor opens after page 1. The remaining pages are read in the background.</p>}
      </section>
    );
  }

  return (
    <section aria-label="Upload a document" onPointerEnter={onIntent} onFocus={onIntent} className="flex flex-col lg:h-full">
      <div
        // The whole card is the control: click/tap, Enter or Space opens the picker.
        role="button"
        tabIndex={0}
        aria-label="Choose a scanned PDF or image, or drop it here"
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        className={cn(
          // Stretches to the height of the hero column on desktop.
          'flex flex-1 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border-strong bg-surface px-6 py-12 text-center shadow-sm transition-colors outline-none hover:border-brand/60 hover:bg-brand-light/40 focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/20 sm:py-16',
          over && 'border-brand bg-brand-light',
        )}
        onDragEnter={onIntent}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span aria-hidden className="grid size-12 place-items-center rounded-full bg-canvas-deep text-muted-foreground">
          <FileUp className="size-5" />
        </span>
        <p className="type-title mt-4">Drop a scanned PDF or image</p>
        <p className="mt-1 text-[13px] text-muted-foreground">PDF (multi-page), PNG, JPEG or WebP · up to 50 MB</p>
        {/* Visual cue only: the click reaches the card, which opens the picker. */}
        <Button size="lg" tabIndex={-1} aria-hidden className="pointer-events-none mt-6 h-11 rounded-lg px-6 text-[14px]">
          Choose file
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf,image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onFile(f);
          }}
        />
      </div>
      <LanguagePicker value={languages} onChange={onLanguages} />
      {error && (
        <Alert variant="destructive" className="mt-4 border-danger-light bg-danger-light text-danger-text">
          <AlertDescription className="text-danger-text">{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
