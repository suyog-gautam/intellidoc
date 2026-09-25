import type { Script } from '../text/script';

/**
 * OCR languages IntelliDoc ships models for (Tesseract `best_int` LSTM
 * models, copied to public/vendor by postinstall, so recognition never
 * contacts a third party). Each entry lists the scripts its text uses: that
 * decides which candidate fonts are fitted and which font subsets load.
 *
 * To add a language: add `@tesseract.js-data/<code>` to package.json and an
 * entry here. A new script also needs fonts with that subset in the font
 * catalogue and its unicode ranges in core/text/script.ts.
 */
export interface OcrLanguage {
  /** Tesseract language code. */
  code: string;
  /** English name. */
  name: string;
  /** Name in the language itself, for the picker. */
  nativeName: string;
  scripts: readonly Script[];
}

export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: 'eng', name: 'English', nativeName: 'English', scripts: ['latin'] },
  { code: 'nep', name: 'Nepali', nativeName: 'नेपाली', scripts: ['devanagari'] },
  { code: 'hin', name: 'Hindi', nativeName: 'हिन्दी', scripts: ['devanagari'] },
  { code: 'mar', name: 'Marathi', nativeName: 'मराठी', scripts: ['devanagari'] },
  { code: 'fra', name: 'French', nativeName: 'Français', scripts: ['latin'] },
  { code: 'deu', name: 'German', nativeName: 'Deutsch', scripts: ['latin'] },
  { code: 'spa', name: 'Spanish', nativeName: 'Español', scripts: ['latin'] },
  { code: 'por', name: 'Portuguese', nativeName: 'Português', scripts: ['latin'] },
  { code: 'ita', name: 'Italian', nativeName: 'Italiano', scripts: ['latin'] },
  { code: 'nld', name: 'Dutch', nativeName: 'Nederlands', scripts: ['latin'] },
  { code: 'pol', name: 'Polish', nativeName: 'Polski', scripts: ['latin'] },
  { code: 'tur', name: 'Turkish', nativeName: 'Türkçe', scripts: ['latin'] },
  { code: 'rus', name: 'Russian', nativeName: 'Русский', scripts: ['cyrillic'] },
  { code: 'ukr', name: 'Ukrainian', nativeName: 'Українська', scripts: ['cyrillic'] },
  { code: 'ell', name: 'Greek', nativeName: 'Ελληνικά', scripts: ['greek'] },
];

export const DEFAULT_OCR_LANGUAGES: readonly string[] = ['eng'];

/** Tesseract gets slower and less accurate with every extra model; three covers bilingual documents plus English. */
export const MAX_OCR_LANGUAGES = 3;

const BY_CODE = new Map(OCR_LANGUAGES.map((l) => [l.code, l]));

export function getOcrLanguage(code: string): OcrLanguage | undefined {
  return BY_CODE.get(code);
}

/** Known codes only, without duplicates, at most MAX_OCR_LANGUAGES, never empty. */
export function normalizeLanguages(codes: Iterable<string>): string[] {
  const out: string[] = [];
  for (const c of codes) if (BY_CODE.has(c) && !out.includes(c)) out.push(c);
  return out.length ? out.slice(0, MAX_OCR_LANGUAGES) : [...DEFAULT_OCR_LANGUAGES];
}

/** Scripts used by a set of OCR languages (the document's writing systems). */
export function scriptsOfLanguages(codes: Iterable<string>): Script[] {
  const out = new Set<Script>();
  for (const c of codes) for (const s of BY_CODE.get(c)?.scripts ?? []) out.add(s);
  return [...out];
}
