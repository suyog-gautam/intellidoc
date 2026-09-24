'use client';

import { useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FONT_CATALOG, type CandidateFont } from '@/core/typography/fontCatalog';
import type { FontCategory } from '@/core/document/model';
import { loadCandidateFonts } from '@/lib/browser/fonts';

const AUTO = '__auto__';
const GROUPS: { category: FontCategory; label: string }[] = [
  { category: 'sans', label: 'Sans serif' },
  { category: 'serif', label: 'Serif' },
  { category: 'condensed', label: 'Condensed' },
  { category: 'mono', label: 'Monospace' },
];

let previewFonts: Promise<void> | undefined;

interface Props {
  /** User-chosen font id, or undefined for "Auto". */
  value: string | undefined;
  detected: CandidateFont;
  onChange(fontId: string | undefined): void;
  id?: string;
}

/**
 * Font chooser: "Auto" keeps the font detected from the scan; any bundled
 * candidate can be chosen instead. Entries are previewed in their own
 * typeface; those fonts load only when the list is first opened.
 */
export function FontPicker({ value, detected, onChange, id }: Props) {
  const [previews, setPreviews] = useState(false);
  return (
    <Select
      value={value ?? AUTO}
      onValueChange={(v) => onChange(v === AUTO ? undefined : v)}
      onOpenChange={(open) => {
        if (!open || previews) return;
        previewFonts ??= loadCandidateFonts(document.fonts).catch(() => undefined);
        void previewFonts.then(() => setPreviews(true));
      }}
    >
      <SelectTrigger id={id} className="h-10 w-full rounded-md border-transparent bg-canvas text-[14px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={AUTO}>
          Auto <span className="text-muted-foreground">· detected {detected.displayName}</span>
        </SelectItem>
        {GROUPS.map((g) => {
          const fonts = FONT_CATALOG.filter((f) => f.category === g.category);
          if (!fonts.length) return null;
          return (
            <SelectGroup key={g.category}>
              <SelectLabel className="type-label text-muted-foreground">{g.label}</SelectLabel>
              {fonts.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={previews ? { fontFamily: `"${f.family}", sans-serif`, fontSize: 15 } : undefined}>{f.displayName}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">{f.resembles[0]}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
      </SelectContent>
    </Select>
  );
}
