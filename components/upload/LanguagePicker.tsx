'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_OCR_LANGUAGES, MAX_OCR_LANGUAGES, normalizeLanguages, OCR_LANGUAGES } from '@/core/ocr/languages';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'intellidoc.ocrLanguages';
/** Shown up front; the rest sit behind "More languages". */
const FEATURED = ['eng', 'nep', 'hin'];

/** Document languages for OCR, remembered per browser (a convenience only: falls back to English). */
export function useOcrLanguages(): [string[], (codes: string[]) => void] {
  const [codes, setCodes] = useState<string[]>([...DEFAULT_OCR_LANGUAGES]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setCodes(normalizeLanguages(JSON.parse(saved) as string[]));
    } catch {
      // Storage blocked or corrupt: keep the default.
    }
  }, []);
  const update = (next: string[]) => {
    const normalized = normalizeLanguages(next);
    setCodes(normalized);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Not persisted; the choice still applies to this visit.
    }
  };
  return [codes, update];
}

interface Props {
  value: string[];
  onChange(codes: string[]): void;
}

/**
 * Which languages the document is written in. Tesseract needs the model for
 * each script up front (a Nepali page read with the English model is noise),
 * so this is chosen before upload. Plain toggle buttons keep the start page
 * free of menu libraries.
 */
export function LanguagePicker({ value, onChange }: Props) {
  const more = OCR_LANGUAGES.filter((l) => !FEATURED.includes(l.code));
  const [open, setOpen] = useState(() => value.some((c) => !FEATURED.includes(c)));
  const full = value.length >= MAX_OCR_LANGUAGES;

  const toggle = (code: string) => {
    if (value.includes(code)) {
      if (value.length > 1) onChange(value.filter((c) => c !== code));
    } else if (!full) onChange([...value, code]);
  };

  const chip = (code: string) => {
    const lang = OCR_LANGUAGES.find((l) => l.code === code)!;
    const on = value.includes(code);
    return (
      <button
        key={code}
        type="button"
        aria-pressed={on}
        disabled={!on && full}
        onClick={() => toggle(code)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors outline-none focus-visible:ring-4 focus-visible:ring-brand/20 disabled:opacity-40',
          on ? 'border-brand bg-brand-light font-medium text-brand-text' : 'border-border bg-surface hover:border-border-strong',
        )}
      >
        <span lang={code === 'eng' ? 'en' : undefined}>{lang.nativeName}</span>
        {lang.nativeName !== lang.name && <span className="text-[11.5px] text-muted-foreground">{lang.name}</span>}
      </button>
    );
  };

  return (
    <fieldset className="mt-4 rounded-xl border border-border bg-surface p-3">
      <legend className="type-label px-1 text-muted-foreground">Document language</legend>
      <div className="flex flex-wrap gap-2">
        {FEATURED.map(chip)}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center rounded-full px-2 text-[13px] font-medium text-brand hover:underline"
        >
          {open ? 'Fewer' : 'More languages'}
        </button>
      </div>
      {open && <div className="mt-2 flex flex-wrap gap-2">{more.map((l) => chip(l.code))}</div>}
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Pick up to {MAX_OCR_LANGUAGES}, e.g. Nepali + English for a bilingual form. Models download once and stay on this device.
      </p>
    </fieldset>
  );
}
