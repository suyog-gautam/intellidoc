import { scriptOf, type Script } from '../text/script';
import { languagesForScript, languagesFromLocales } from './languages';
import type { ScriptDetection } from './types';

/** OSD confidence above which its script is trusted (measured: 1.4–1.6 for correct CJK, 8–73 for alphabets). */
export const OSD_MIN_CONFIDENCE = 1;
/** Headline-joined words that make a page Devanagari/Bengali/Gurmukhi (a stray match or two is noise). */
export const MIN_HEADLINE_WORDS = 5;

/** Headline scripts are told apart by recognising a band of the page with all three models at once. */
export const HEADLINE_PROBE_LANGUAGES = ['hin', 'ben', 'pan'] as const;

export interface LanguageEvidence {
  /** Tesseract OSD on page 1, if it produced a result. */
  osd?: ScriptDetection;
  /** Headline-joined words found on page 1. */
  headlineWords: number;
  /** Text recognised from the headline band with HEADLINE_PROBE_LANGUAGES, when headlines were found. */
  headlineProbeText?: string;
  /** Browser languages (navigator.languages), to pick a language within a script. */
  locales: readonly string[];
}

export interface LanguageChoice {
  languages: string[];
  /** How the choice was made, for the UI. */
  source: 'script' | 'headline' | 'locale';
  script?: string;
}

/** The script most characters of `text` belong to. */
export function dominantScript(text: string): Script | undefined {
  const counts = new Map<Script, number>();
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: Script | undefined;
  let n = 0;
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c];
  return best;
}

const HEADLINE_SCRIPTS: Partial<Record<Script, string>> = { devanagari: 'Devanagari', bengali: 'Bengali', gurmukhi: 'Gurmukhi' };

/**
 * Choose OCR languages for "Auto":
 *   1. Headline-joined words are strong evidence for Devanagari, Bengali or
 *      Gurmukhi, which OSD can't see (it needs separate characters). The
 *      probe text tells the three apart. This wins over an OSD "Latin",
 *      since such documents often carry English too.
 *   2. Otherwise a confident OSD script.
 *   3. Otherwise the browser's language (plus English).
 * Within a script, the browser's language picks the language (Nepali vs
 * Hindi); English is added as a second language for non-Latin documents.
 */
export function chooseLanguages(e: LanguageEvidence): LanguageChoice {
  if (e.headlineWords >= MIN_HEADLINE_WORDS && e.headlineProbeText) {
    const s = dominantScript(e.headlineProbeText);
    const osdName = s && HEADLINE_SCRIPTS[s];
    const langs = osdName && languagesForScript(osdName, e.locales);
    if (langs) return { languages: langs, source: 'headline', script: osdName };
  }
  if (e.osd && e.osd.confidence >= OSD_MIN_CONFIDENCE) {
    const langs = languagesForScript(e.osd.script, e.locales);
    if (langs) return { languages: langs, source: 'script', script: e.osd.script };
  }
  return { languages: languagesFromLocales(e.locales), source: 'locale' };
}
