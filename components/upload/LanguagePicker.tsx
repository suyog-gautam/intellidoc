'use client';

import { useEffect, useState } from 'react';
import { AUTO, DEFAULT_OCR_LANGUAGES, MAX_OCR_LANGUAGES, normalizeLanguages, OCR_LANGUAGES } from '@/core/ocr/languages';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'intellidoc.ocrLanguages';
/** Shown up front (the most spoken, plus this app's first users); the rest sit behind "More languages". */
const FEATURED = ['eng', 'chi_sim', 'hin', 'spa', 'ara', 'nep'];

/** Document languages for OCR, remembered per browser (a convenience only: falls back to Auto). */
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

const chipClass = (on: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors outline-none focus-visible:ring-4 focus-visible:ring-brand/20 disabled:opacity-40',
    on ? 'border-brand bg-brand-light font-medium text-brand-text' : 'border-border bg-surface hover:border-border-strong',
  );

/**
 * Which languages the document is written in. "Auto" (the default) detects
 * the script of page 1 and picks the matching languages; choosing languages
 * yourself skips detection. Plain toggle buttons keep the start page free of
 * menu libraries.
 */
export function LanguagePicker({ value, onChange }: Props) {
  const auto = value[0] === AUTO;
  const [open, setOpen] = useState(() => value.some((c) => c !== AUTO && !FEATURED.includes(c)));
  const full = !auto && value.length >= MAX_OCR_LANGUAGES;

  const toggle = (code: string) => {
    if (auto) onChange([code]);
    else if (value.includes(code)) onChange(value.length > 1 ? value.filter((c) => c !== code) : [AUTO]);
    else if (!full) onChange([...value, code]);
  };

  const chip = (code: string) => {
    const lang = OCR_LANGUAGES.find((l) => l.code === code)!;
    const on = !auto && value.includes(code);
    return (
      <button key={code} type="button" aria-pressed={on} disabled={!on && full} onClick={() => toggle(code)} className={chipClass(on)}>
        <span>{lang.nativeName}</span>
        {lang.nativeName !== lang.name && <span className="text-[11.5px] text-muted-foreground">{lang.name}</span>}
      </button>
    );
  };

  return (
    <fieldset className="mt-4 rounded-xl border border-border bg-surface p-3">
      <legend className="type-label px-1 text-muted-foreground">Document language</legend>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={auto} onClick={() => onChange([AUTO])} className={chipClass(auto)}>
          Auto-detect
        </button>
        {FEATURED.map(chip)}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center rounded-full px-2 text-[13px] font-medium text-brand hover:underline"
        >
          {open ? 'Fewer' : `${OCR_LANGUAGES.length - FEATURED.length} more`}
        </button>
      </div>
      {open && <div className="mt-2 flex flex-wrap gap-2">{OCR_LANGUAGES.filter((l) => !FEATURED.includes(l.code)).map((l) => chip(l.code))}</div>}
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        {auto
          ? 'Detects the script of the first page (Latin, Chinese, Arabic, Devanagari…) and reads it with the matching language, plus English.'
          : `Up to ${MAX_OCR_LANGUAGES}, e.g. Nepali + English for a bilingual form.`}{' '}
        Models download once and stay on this device.
      </p>
    </fieldset>
  );
}
