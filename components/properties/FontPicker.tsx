'use client';

import { useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FONT_CATALOG, getFont, type CandidateFont } from '@/core/typography/fontCatalog';
import type { FontCategory } from '@/core/document/model';
import { scriptsOf, type Script } from '@/core/text/script';

const AUTO = '__auto__';
const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  condensed: 'Condensed',
  mono: 'Monospace',
  handwriting: 'Handwriting',
};
const CATEGORY_ORDER: FontCategory[] = ['sans', 'serif', 'condensed', 'mono', 'handwriting'];

/** Writing systems in picker order, with the label of their group. */
const SCRIPT_GROUPS: [Script, string][] = [
  ['latin', 'Latin, Cyrillic, Greek'],
  ['han', 'Chinese, Japanese, Korean'],
  ['devanagari', 'Devanagari'],
  ['arabic', 'Arabic, Urdu, Persian'],
  ['bengali', 'Bengali'],
  ['tamil', 'Tamil'],
  ['telugu', 'Telugu'],
  ['gujarati', 'Gujarati'],
  ['gurmukhi', 'Punjabi (Gurmukhi)'],
  ['kannada', 'Kannada'],
  ['malayalam', 'Malayalam'],
  ['thai', 'Thai'],
  ['hebrew', 'Hebrew'],
];

/** Picker group of a font: its first script, with kana/hangul under CJK. */
function groupOf(f: CandidateFont): Script {
  const s = f.scripts[0];
  return s === 'kana' || s === 'hangul' ? 'han' : s === 'cyrillic' || s === 'greek' ? 'latin' : s;
}

function byCategory(fonts: CandidateFont[]): CandidateFont[] {
  return [...fonts].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}

let previewFonts: Promise<((id: string) => string) | undefined> | undefined;

interface Props {
  /** User-chosen font id, or undefined for "Auto". */
  value: string | undefined;
  detected: CandidateFont;
  /** The element's text: fonts that can write it are listed first. */
  text: string;
  onChange(fontId: string | undefined): void;
  id?: string;
}

/**
 * Font chooser: "Auto" keeps the font detected from the scan; any bundled
 * candidate can be chosen instead. Fonts for the element's own script come
 * first; the rest are grouped by writing system. Entries are previewed in
 * their own typeface; those files (one small slice per font) load only when
 * the list is first opened.
 */
export function FontPicker({ value, detected, text, onChange, id }: Props) {
  const [stack, setStack] = useState<(id: string) => string>();
  const scripts = scriptsOf(text);
  const own = scripts.size ? [...scripts].map((s) => (s === 'kana' || s === 'hangul' ? 'han' : s === 'cyrillic' || s === 'greek' ? 'latin' : s)) : ['latin'];
  const suggested = new Set(own);
  const groups = SCRIPT_GROUPS.filter(([s]) => FONT_CATALOG.some((f) => groupOf(f) === s)).sort(([a], [b]) => Number(suggested.has(b)) - Number(suggested.has(a)));

  return (
    <Select
      value={value ?? AUTO}
      onValueChange={(v) => onChange(v === AUTO ? undefined : v)}
      onOpenChange={(open) => {
        if (!open || stack) return;
        previewFonts ??= Promise.all([import('@/lib/browser/fonts'), import('@/core/typography/fontFaces')])
          .then(async ([{ loadFaces }, { facesFor, fontStack }]) => {
            const faces = FONT_CATALOG.flatMap((f) => facesFor([f.id], f.displayName).filter((face) => face.weight === 400));
            await loadFaces(document.fonts, faces);
            return (fontId: string) => fontStack(fontId, getFont(fontId).displayName);
          })
          .catch(() => undefined);
        void previewFonts.then((fn) => fn && setStack(() => fn));
      }}
    >
      <SelectTrigger id={id} className="h-10 w-full rounded-md border-transparent bg-canvas text-[14px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={AUTO}>
          Auto <span className="text-muted-foreground">· detected {detected.displayName}</span>
        </SelectItem>
        {groups.map(([script, label]) => (
          <SelectGroup key={script}>
            <SelectLabel className="type-label text-muted-foreground">
              {label}
              {suggested.has(script) && ' · this text'}
            </SelectLabel>
            {byCategory(FONT_CATALOG.filter((f) => groupOf(f) === script)).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                <span style={stack ? { fontFamily: `${stack(f.id)}, sans-serif`, fontSize: 15 } : undefined}>{f.displayName}</span>
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {f.category === 'handwriting' ? CATEGORY_LABEL.handwriting : f.resembles[0]}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
