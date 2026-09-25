import type { CjkRegion, Script } from '../text/script';

/**
 * OCR languages IntelliDoc ships models for (Tesseract `best_int` LSTM
 * models, copied to public/vendor by postinstall, so recognition never
 * contacts a third party). Together they cover the world's most spoken
 * languages. Each entry lists the scripts its text uses: that decides which
 * candidate fonts are fitted and which font files load.
 *
 * To add a language: add `@tesseract.js-data/<code>` to package.json and an
 * entry here. A new *script* also needs its Unicode blocks in
 * core/text/script.ts and fonts for it in the font catalogue.
 */
export interface OcrLanguage {
  /** Tesseract language code. */
  code: string;
  /** English name. */
  name: string;
  /** Name in the language itself, for the picker. */
  nativeName: string;
  scripts: readonly Script[];
  /** Han glyph convention (Chinese, Japanese, Korean). */
  cjkRegion?: CjkRegion;
  /** BCP 47 language tags (lowercase prefixes) that suggest this language, used by auto-detection. */
  locales: readonly string[];
}

const L = (code: string, name: string, nativeName: string, scripts: Script[], locales: string[], cjkRegion?: CjkRegion): OcrLanguage => ({
  code,
  name,
  nativeName,
  scripts,
  locales,
  ...(cjkRegion ? { cjkRegion } : {}),
});

/** Ordered roughly by number of speakers, so the picker lists the most useful first. */
export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  L('eng', 'English', 'English', ['latin'], ['en']),
  L('chi_sim', 'Chinese (Simplified)', '简体中文', ['han'], ['zh', 'zh-cn', 'zh-sg', 'zh-hans'], 'sc'),
  L('hin', 'Hindi', 'हिन्दी', ['devanagari'], ['hi']),
  L('spa', 'Spanish', 'Español', ['latin'], ['es']),
  L('fra', 'French', 'Français', ['latin'], ['fr']),
  L('ara', 'Arabic', 'العربية', ['arabic'], ['ar']),
  L('ben', 'Bengali', 'বাংলা', ['bengali'], ['bn', 'as']),
  L('por', 'Portuguese', 'Português', ['latin'], ['pt']),
  L('rus', 'Russian', 'Русский', ['cyrillic'], ['ru', 'be', 'kk']),
  L('urd', 'Urdu', 'اردو', ['arabic'], ['ur']),
  L('ind', 'Indonesian', 'Bahasa Indonesia', ['latin'], ['id']),
  L('deu', 'German', 'Deutsch', ['latin'], ['de']),
  L('jpn', 'Japanese', '日本語', ['han', 'kana'], ['ja'], 'jp'),
  L('mar', 'Marathi', 'मराठी', ['devanagari'], ['mr']),
  L('tel', 'Telugu', 'తెలుగు', ['telugu'], ['te']),
  L('tur', 'Turkish', 'Türkçe', ['latin'], ['tr']),
  L('tam', 'Tamil', 'தமிழ்', ['tamil'], ['ta']),
  L('vie', 'Vietnamese', 'Tiếng Việt', ['latin'], ['vi']),
  L('kor', 'Korean', '한국어', ['hangul', 'han'], ['ko'], 'kr'),
  L('ita', 'Italian', 'Italiano', ['latin'], ['it']),
  L('fas', 'Persian', 'فارسی', ['arabic'], ['fa']),
  L('tha', 'Thai', 'ไทย', ['thai'], ['th']),
  L('guj', 'Gujarati', 'ગુજરાતી', ['gujarati'], ['gu']),
  L('pan', 'Punjabi', 'ਪੰਜਾਬੀ', ['gurmukhi'], ['pa']),
  L('kan', 'Kannada', 'ಕನ್ನಡ', ['kannada'], ['kn']),
  L('mal', 'Malayalam', 'മലയാളം', ['malayalam'], ['ml']),
  L('nep', 'Nepali', 'नेपाली', ['devanagari'], ['ne']),
  L('chi_tra', 'Chinese (Traditional)', '繁體中文', ['han'], ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'], 'tc'),
  L('pol', 'Polish', 'Polski', ['latin'], ['pl']),
  L('ukr', 'Ukrainian', 'Українська', ['cyrillic'], ['uk']),
  L('msa', 'Malay', 'Bahasa Melayu', ['latin'], ['ms']),
  L('swa', 'Swahili', 'Kiswahili', ['latin'], ['sw']),
  L('tgl', 'Filipino', 'Filipino', ['latin'], ['fil', 'tl']),
  L('nld', 'Dutch', 'Nederlands', ['latin'], ['nl']),
  L('ron', 'Romanian', 'Română', ['latin'], ['ro']),
  L('ell', 'Greek', 'Ελληνικά', ['greek'], ['el']),
  L('ces', 'Czech', 'Čeština', ['latin'], ['cs']),
  L('hun', 'Hungarian', 'Magyar', ['latin'], ['hu']),
  L('swe', 'Swedish', 'Svenska', ['latin'], ['sv']),
  L('heb', 'Hebrew', 'עברית', ['hebrew'], ['he', 'iw']),
];

/** Pseudo-language: detect the script from page 1 and choose the languages automatically. */
export const AUTO = 'auto';
export const DEFAULT_OCR_LANGUAGES: readonly string[] = [AUTO];

/** Tesseract gets slower and less accurate with every extra model; three covers bilingual documents plus English. */
export const MAX_OCR_LANGUAGES = 3;

const BY_CODE = new Map(OCR_LANGUAGES.map((l) => [l.code, l]));

export function getOcrLanguage(code: string): OcrLanguage | undefined {
  return BY_CODE.get(code);
}

/** Known codes only, without duplicates, at most MAX_OCR_LANGUAGES, never empty. "auto" stands alone. */
export function normalizeLanguages(codes: Iterable<string>): string[] {
  const list = [...codes];
  if (list.includes(AUTO)) return [AUTO];
  const out: string[] = [];
  for (const c of list) if (BY_CODE.has(c) && !out.includes(c)) out.push(c);
  return out.length ? out.slice(0, MAX_OCR_LANGUAGES) : [...DEFAULT_OCR_LANGUAGES];
}

/** Scripts used by a set of OCR languages (the document's writing systems). */
export function scriptsOfLanguages(codes: Iterable<string>): Script[] {
  const out = new Set<Script>();
  for (const c of codes) for (const s of BY_CODE.get(c)?.scripts ?? []) out.add(s);
  return [...out];
}

export function cjkRegionsOfLanguages(codes: Iterable<string>): CjkRegion[] {
  const out = new Set<CjkRegion>();
  for (const c of codes) {
    const r = BY_CODE.get(c)?.cjkRegion;
    if (r) out.add(r);
  }
  return [...out];
}

/**
 * Tesseract OSD script names → our scripts. OSD reports the dominant script
 * of the page; Japanese pages come back as "Japanese" (kana present), Korean
 * as "Hangul"/"Korean", Chinese as "Han" (sometimes "HanS"/"HanT").
 */
const OSD_SCRIPTS: Record<string, Script | 'han-sc' | 'han-tc' | 'japanese' | 'korean'> = {
  latin: 'latin',
  fraktur: 'latin',
  cyrillic: 'cyrillic',
  greek: 'greek',
  arabic: 'arabic',
  hebrew: 'hebrew',
  devanagari: 'devanagari',
  bengali: 'bengali',
  gurmukhi: 'gurmukhi',
  gujarati: 'gujarati',
  tamil: 'tamil',
  telugu: 'telugu',
  kannada: 'kannada',
  malayalam: 'malayalam',
  thai: 'thai',
  han: 'han',
  hans: 'han-sc',
  hant: 'han-tc',
  japanese: 'japanese',
  hiragana: 'japanese',
  katakana: 'japanese',
  hangul: 'korean',
  korean: 'korean',
};

/** Candidate languages per detected script, the first being the default when no locale matches. */
const SCRIPT_LANGUAGES: Record<string, readonly string[]> = {
  latin: ['eng', 'spa', 'fra', 'por', 'ind', 'deu', 'tur', 'vie', 'ita', 'pol', 'msa', 'swa', 'tgl', 'nld', 'ron', 'ces', 'hun', 'swe'],
  cyrillic: ['rus', 'ukr'],
  greek: ['ell'],
  arabic: ['ara', 'urd', 'fas'],
  hebrew: ['heb'],
  devanagari: ['hin', 'nep', 'mar'],
  bengali: ['ben'],
  gurmukhi: ['pan'],
  gujarati: ['guj'],
  tamil: ['tam'],
  telugu: ['tel'],
  kannada: ['kan'],
  malayalam: ['mal'],
  thai: ['tha'],
  han: ['chi_sim', 'chi_tra'],
  'han-sc': ['chi_sim'],
  'han-tc': ['chi_tra'],
  japanese: ['jpn'],
  korean: ['kor'],
};

/** The language a locale tag (e.g. "ne-NP", "zh-TW") points to among `candidates`, if any. */
function fromLocales(candidates: readonly string[], locales: readonly string[]): string | undefined {
  for (const raw of locales) {
    const tag = raw.toLowerCase();
    // Most specific first: "zh-tw" before "zh".
    let best: { code: string; len: number } | undefined;
    for (const code of candidates) {
      for (const l of BY_CODE.get(code)!.locales) {
        if ((tag === l || tag.startsWith(`${l}-`)) && (!best || l.length > best.len)) best = { code, len: l.length };
      }
    }
    if (best) return best.code;
  }
  return undefined;
}

/**
 * OCR languages for a page whose dominant script OSD detected. The script
 * narrows the choice; the browser's locales pick the language within it
 * (Devanagari: Nepali for a "ne" locale, otherwise Hindi). Non-Latin
 * documents usually contain English too (names, amounts, codes), so English
 * is added as the second language. Returns undefined for an unknown or
 * unreliable detection, so the caller can fall back.
 */
export function languagesForScript(osdScript: string, locales: readonly string[] = []): string[] | undefined {
  const key = OSD_SCRIPTS[osdScript.trim().toLowerCase()];
  if (!key) return undefined;
  const candidates = SCRIPT_LANGUAGES[key];
  if (!candidates) return undefined;
  const primary = fromLocales(candidates, locales) ?? candidates[0];
  if (key === 'latin') return primary === 'eng' ? ['eng'] : [primary, 'eng'];
  return [primary, 'eng'];
}

/** Languages to use when detection is unavailable or unsure: the browser's own language plus English. */
export function languagesFromLocales(locales: readonly string[]): string[] {
  const primary = fromLocales(
    OCR_LANGUAGES.map((l) => l.code),
    locales,
  );
  return !primary || primary === 'eng' ? ['eng'] : [primary, 'eng'];
}
