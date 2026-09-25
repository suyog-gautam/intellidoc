import type { FontCategory } from '../document/model';
import type { CjkRegion, Script } from '../text/script';

/**
 * A font we can render with. Scans carry no font metadata, so these are
 * *visual candidates*: several are metric-compatible with common office fonts
 * (noted in `resembles`), which is exactly what most business documents use.
 *
 * This module is metadata only, so UI code can list fonts cheaply. Which
 * characters a font can draw, its files and weights come from the generated
 * manifest (fontFaces.ts / fontFaces.json).
 */
export interface CandidateFont {
  id: string;
  /** CSS family prefix (namespaced to avoid clashing with system fonts); each file slice appends its id. */
  family: string;
  displayName: string;
  category: FontCategory;
  resembles: string[];
  /** fontsource package the files come from. */
  pkg: string;
  /**
   * Scripts for which the font is a fitting candidate (when it also covers
   * the text). A Devanagari or Arabic family carries Latin letters too, but
   * those are secondary designs, so it's tried on Latin text only in
   * documents whose language uses its script.
   */
  scripts: readonly Script[];
  /** For Han characters: the regional glyph convention the font follows. */
  cjkRegion?: CjkRegion;
  /**
   * Glyphs this stand-in draws differently from the fonts it `resembles`,
   * mapped to a candidate font whose glyph matches those originals. Applied
   * when the scan itself offers no evidence (the character isn't in the
   * analysed text). Example: Arimo's "1" has a foot serif; Arial's and
   * Helvetica's don't.
   */
  glyphDefaults?: Readonly<Record<string, string>>;
}

interface Extra {
  scripts?: readonly Script[];
  cjkRegion?: CjkRegion;
  glyphDefaults?: Record<string, string>;
}

/** Latin-script print families: candidates for every alphabet they happen to cover. */
const EUROPEAN: Script[] = ['latin', 'cyrillic', 'greek', 'hebrew'];

function font(id: string, displayName: string, category: FontCategory, resembles: string[], scripts: readonly Script[], extra: Extra = {}): CandidateFont {
  return {
    id,
    family: `IDF ${displayName}`,
    displayName,
    category,
    resembles,
    pkg: id,
    scripts: extra.scripts ?? scripts,
    ...(extra.cjkRegion ? { cjkRegion: extra.cjkRegion } : {}),
    ...(extra.glyphDefaults ? { glyphDefaults: extra.glyphDefaults } : {}),
  };
}

/*
 * Upright faces only. Slanted scan text is matched with the synthetic
 * `skewX` render parameter, which fits real scans at least as well as a
 * font's own italic, so shipping italic faces would double the download for
 * no fidelity gain.
 */
export const FONT_CATALOG: readonly CandidateFont[] = [
  // Arimo is metric-compatible with Arial, but its "1" has a foot serif that Arial's and Helvetica's lack.
  font('arimo', 'Arimo', 'sans', ['Arial', 'Helvetica'], EUROPEAN, { glyphDefaults: { '1': 'roboto' } }),
  font('tinos', 'Tinos', 'serif', ['Times New Roman', 'Times'], EUROPEAN),
  font('cousine', 'Cousine', 'mono', ['Courier New'], EUROPEAN),
  font('carlito', 'Carlito', 'sans', ['Calibri'], EUROPEAN),
  font('roboto', 'Roboto', 'sans', ['Roboto'], EUROPEAN),
  font('open-sans', 'Open Sans', 'sans', ['Segoe UI', 'Verdana'], EUROPEAN),
  font('roboto-condensed', 'Roboto Condensed', 'condensed', ['Arial Narrow'], EUROPEAN),
  font('noto-serif', 'Noto Serif', 'serif', ['Noto Serif', 'Droid Serif'], EUROPEAN),
  // Metric-compatible with common Microsoft fonts.
  font('caladea', 'Caladea', 'serif', ['Cambria'], EUROPEAN),
  font('gelasio', 'Gelasio', 'serif', ['Georgia'], EUROPEAN),
  // Classic office / print families.
  font('libre-franklin', 'Libre Franklin', 'sans', ['Franklin Gothic'], EUROPEAN),
  font('eb-garamond', 'EB Garamond', 'serif', ['Garamond'], EUROPEAN),
  font('libre-baskerville', 'Libre Baskerville', 'serif', ['Baskerville', 'Book Antiqua'], EUROPEAN),
  font('archivo-narrow', 'Archivo Narrow', 'condensed', ['Arial Narrow'], EUROPEAN),
  font('ibm-plex-mono', 'IBM Plex Mono', 'mono', ['Consolas', 'Lucida Console'], EUROPEAN),
  // Frequent in modern, generated PDFs (web apps, invoices, reports).
  font('inter', 'Inter', 'sans', ['Helvetica Neue', 'Segoe UI'], EUROPEAN),
  font('lato', 'Lato', 'sans', ['Lato', 'Gill Sans'], EUROPEAN),
  font('montserrat', 'Montserrat', 'sans', ['Montserrat', 'Century Gothic'], EUROPEAN),
  font('source-sans-3', 'Source Sans 3', 'sans', ['Myriad Pro'], EUROPEAN),
  font('noto-sans', 'Noto Sans', 'sans', ['Noto Sans', 'Droid Sans'], EUROPEAN),
  font('pt-sans', 'PT Sans', 'sans', ['PT Sans', 'Trebuchet MS'], EUROPEAN),
  font('pt-serif', 'PT Serif', 'serif', ['PT Serif'], EUROPEAN),

  // Devanagari (Hindi, Nepali, Marathi).
  font('noto-sans-devanagari', 'Noto Sans Devanagari', 'sans', ['Mangal', 'Nirmala UI'], ['devanagari']),
  font('noto-serif-devanagari', 'Noto Serif Devanagari', 'serif', ['Devanagari serif (book)'], ['devanagari']),
  font('mukta', 'Mukta', 'sans', ['Devanagari sans (humanist)'], ['devanagari']),
  font('hind', 'Hind', 'sans', ['Devanagari sans (UI)'], ['devanagari']),
  font('yantramanav', 'Yantramanav', 'sans', ['Devanagari sans (Roboto companion)'], ['devanagari']),
  font('poppins', 'Poppins', 'sans', ['Poppins', 'Futura'], ['latin', 'devanagari']),
  font('tiro-devanagari-hindi', 'Tiro Devanagari Hindi', 'serif', ['Devanagari traditional (Kokila-like)'], ['devanagari']),
  font('martel', 'Martel', 'serif', ['Devanagari traditional (high contrast)'], ['devanagari']),
  font('laila', 'Laila', 'serif', ['Devanagari text (book)'], ['devanagari']),
  font('karma', 'Karma', 'serif', ['Devanagari traditional (calligraphic)'], ['devanagari']),
  font('khand', 'Khand', 'condensed', ['Devanagari condensed'], ['devanagari']),

  // Other Indic scripts: Bengali, Gurmukhi (Punjabi), Gujarati, Tamil, Telugu, Kannada, Malayalam.
  font('noto-sans-bengali', 'Noto Sans Bengali', 'sans', ['Vrinda', 'Nirmala UI'], ['bengali']),
  font('noto-serif-bengali', 'Noto Serif Bengali', 'serif', ['Bengali serif (book)'], ['bengali']),
  font('hind-siliguri', 'Hind Siliguri', 'sans', ['Bengali sans (UI)'], ['bengali']),
  font('noto-sans-gurmukhi', 'Noto Sans Gurmukhi', 'sans', ['Raavi', 'Nirmala UI'], ['gurmukhi']),
  font('noto-serif-gurmukhi', 'Noto Serif Gurmukhi', 'serif', ['Gurmukhi serif'], ['gurmukhi']),
  font('mukta-mahee', 'Mukta Mahee', 'sans', ['Gurmukhi sans (humanist)'], ['gurmukhi']),
  font('noto-sans-gujarati', 'Noto Sans Gujarati', 'sans', ['Shruti', 'Nirmala UI'], ['gujarati']),
  font('noto-serif-gujarati', 'Noto Serif Gujarati', 'serif', ['Gujarati serif'], ['gujarati']),
  font('hind-vadodara', 'Hind Vadodara', 'sans', ['Gujarati sans (UI)'], ['gujarati']),
  font('noto-sans-tamil', 'Noto Sans Tamil', 'sans', ['Latha', 'Nirmala UI'], ['tamil']),
  font('noto-serif-tamil', 'Noto Serif Tamil', 'serif', ['Tamil serif (book)'], ['tamil']),
  font('mukta-malar', 'Mukta Malar', 'sans', ['Tamil sans (humanist)'], ['tamil']),
  font('noto-sans-telugu', 'Noto Sans Telugu', 'sans', ['Gautami', 'Nirmala UI'], ['telugu']),
  font('noto-serif-telugu', 'Noto Serif Telugu', 'serif', ['Telugu serif'], ['telugu']),
  font('hind-guntur', 'Hind Guntur', 'sans', ['Telugu sans (UI)'], ['telugu']),
  font('noto-sans-kannada', 'Noto Sans Kannada', 'sans', ['Tunga', 'Nirmala UI'], ['kannada']),
  font('noto-serif-kannada', 'Noto Serif Kannada', 'serif', ['Kannada serif'], ['kannada']),
  font('baloo-tamma-2', 'Baloo Tamma 2', 'sans', ['Kannada rounded'], ['kannada']),
  font('noto-sans-malayalam', 'Noto Sans Malayalam', 'sans', ['Kartika', 'Nirmala UI'], ['malayalam']),
  font('noto-serif-malayalam', 'Noto Serif Malayalam', 'serif', ['Malayalam serif'], ['malayalam']),
  font('manjari', 'Manjari', 'sans', ['Malayalam rounded'], ['malayalam']),

  // Arabic script (Arabic, Urdu, Persian) and Hebrew. Right-to-left.
  font('noto-naskh-arabic', 'Noto Naskh Arabic', 'serif', ['Naskh (standard Arabic print)'], ['arabic']),
  font('noto-sans-arabic', 'Noto Sans Arabic', 'sans', ['Segoe UI (Arabic)', 'Tahoma (Arabic)'], ['arabic']),
  font('amiri', 'Amiri', 'serif', ['Traditional Arabic', 'Naskh (book)'], ['arabic']),
  font('cairo', 'Cairo', 'sans', ['Arabic geometric sans'], ['arabic']),
  font('vazirmatn', 'Vazirmatn', 'sans', ['Persian sans (Tahoma-like)'], ['arabic']),
  font('noto-nastaliq-urdu', 'Noto Nastaliq Urdu', 'serif', ['Jameel Noori Nastaleeq', 'Nastaliq (Urdu)'], ['arabic']),
  font('noto-sans-hebrew', 'Noto Sans Hebrew', 'sans', ['Arial Hebrew', 'Segoe UI (Hebrew)'], ['hebrew']),
  font('noto-serif-hebrew', 'Noto Serif Hebrew', 'serif', ['Hebrew serif'], ['hebrew']),
  font('rubik', 'Rubik', 'sans', ['Rubik'], ['latin', 'cyrillic', 'hebrew']),
  font('frank-ruhl-libre', 'Frank Ruhl Libre', 'serif', ['Frank Rühl (Hebrew print)'], ['hebrew']),

  // Thai.
  font('noto-sans-thai', 'Noto Sans Thai', 'sans', ['Leelawadee', 'Tahoma (Thai)'], ['thai']),
  font('noto-serif-thai', 'Noto Serif Thai', 'serif', ['Angsana (looped)'], ['thai']),
  font('sarabun', 'Sarabun', 'sans', ['TH Sarabun (Thai government standard)'], ['thai']),
  font('kanit', 'Kanit', 'sans', ['Thai loopless sans'], ['thai']),

  // Chinese, Japanese, Korean. Downloaded in slices, only for the characters a document uses.
  font('noto-sans-sc', 'Noto Sans SC', 'sans', ['Microsoft YaHei', 'Hei (simplified)'], ['han'], { cjkRegion: 'sc' }),
  font('noto-serif-sc', 'Noto Serif SC', 'serif', ['SimSun', 'Song (simplified)'], ['han'], { cjkRegion: 'sc' }),
  font('noto-sans-tc', 'Noto Sans TC', 'sans', ['Microsoft JhengHei', 'Hei (traditional)'], ['han'], { cjkRegion: 'tc' }),
  font('noto-sans-jp', 'Noto Sans JP', 'sans', ['Meiryo', 'Yu Gothic'], ['han', 'kana'], { cjkRegion: 'jp' }),
  font('noto-serif-jp', 'Noto Serif JP', 'serif', ['MS Mincho', 'Yu Mincho'], ['han', 'kana'], { cjkRegion: 'jp' }),
  font('noto-sans-kr', 'Noto Sans KR', 'sans', ['Malgun Gothic', 'Dotum'], ['hangul', 'han'], { cjkRegion: 'kr' }),
  font('noto-serif-kr', 'Noto Serif KR', 'serif', ['Batang', 'Myeongjo'], ['hangul', 'han'], { cjkRegion: 'kr' }),

  // Handwriting: filled-in forms, handwritten invoices and receipts, in several scripts and hands.
  font('caveat', 'Caveat', 'handwriting', ['Handwriting (cursive)'], ['latin', 'cyrillic']),
  font('patrick-hand', 'Patrick Hand', 'handwriting', ['Handwriting (neat print)'], ['latin']),
  font('indie-flower', 'Indie Flower', 'handwriting', ['Handwriting (rounded print)'], ['latin']),
  font('reenie-beanie', 'Reenie Beanie', 'handwriting', ['Handwriting (quick, narrow)'], ['latin']),
  font('kalam', 'Kalam', 'handwriting', ['Handwriting (print, Latin + Devanagari)'], ['latin', 'devanagari']),
  font('aref-ruqaa', 'Aref Ruqaa', 'handwriting', ['Ruqʿah (everyday Arabic handwriting)'], ['arabic']),
  font('sriracha', 'Sriracha', 'handwriting', ['Thai handwriting'], ['thai']),
  font('ma-shan-zheng', 'Ma Shan Zheng', 'handwriting', ['Chinese brush handwriting (Kai)'], ['han'], { cjkRegion: 'sc' }),
  font('klee-one', 'Klee One', 'handwriting', ['Japanese pen handwriting'], ['han', 'kana'], { cjkRegion: 'jp' }),
  font('nanum-pen-script', 'Nanum Pen Script', 'handwriting', ['Korean pen handwriting'], ['hangul'], { cjkRegion: 'kr' }),
];

const BY_ID = new Map(FONT_CATALOG.map((f) => [f.id, f]));

export function getFont(id: string): CandidateFont {
  const f = BY_ID.get(id);
  if (!f) throw new Error(`Unknown font ${id}`);
  return f;
}

export function hasFont(id: string): boolean {
  return BY_ID.has(id);
}
