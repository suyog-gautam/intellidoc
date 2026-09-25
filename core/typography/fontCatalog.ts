import type { FontCategory } from '../document/model';
import { FONT_SUBSETS, scriptOfSubset, scriptsOf, subsetOf, type FontSubset, type Script } from '../text/script';

export interface CandidateFontFace {
  weight: 400 | 700;
  style: 'normal' | 'italic';
  subset: FontSubset;
  /** CSS family this face is registered under (one family per subset, see {@link subsetFamily}). */
  family: string;
  /** File name inside the vendor fonts directory. */
  file: string;
}

/**
 * A font we can render with. Scans carry no font metadata, so these are
 * *visual candidates*: several are metric-compatible with common office fonts
 * (noted in `resembles`), which is exactly what most business documents use.
 */
export interface CandidateFont {
  id: string;
  /** CSS family name of the Latin faces (namespaced to avoid clashing with system fonts). */
  family: string;
  displayName: string;
  category: FontCategory;
  resembles: string[];
  /** fontsource package the files come from. */
  pkg: string;
  /** Shipped weights. */
  weights: readonly (400 | 700)[];
  /** Shipped subsets (writing systems the font can draw). */
  subsets: readonly FontSubset[];
  /**
   * Scripts for which the font is a fitting candidate. A Devanagari family
   * also carries Latin letters, but those are secondary designs; it is only
   * tried on Latin text in documents whose language uses Devanagari.
   */
  candidateFor: readonly Script[];
  /**
   * Glyphs this stand-in draws differently from the fonts it `resembles`,
   * mapped to a candidate font whose glyph matches those originals. Applied
   * when the scan itself offers no evidence (the character isn't in the
   * analysed text). Example: Arimo's "1" has a foot serif; Arial's and
   * Helvetica's don't.
   */
  glyphDefaults?: Readonly<Record<string, string>>;
}

/**
 * Upright faces only. Slanted scan text is matched with the synthetic
 * `skewX` render parameter, which fits real scans at least as well as a
 * font's own italic, so shipping italic faces would double the download for
 * no fidelity gain.
 */
const LG: FontSubset[] = ['latin', 'latin-ext'];
const LGC: FontSubset[] = [...LG, 'cyrillic'];
const LGCG: FontSubset[] = [...LGC, 'greek'];
const DEVA: FontSubset[] = [...LG, 'devanagari'];

interface Extra {
  weights?: readonly (400 | 700)[];
  candidateFor?: readonly Script[];
  glyphDefaults?: Record<string, string>;
}

function font(id: string, displayName: string, category: FontCategory, resembles: string[], subsets: FontSubset[], extra: Extra = {}): CandidateFont {
  return {
    id,
    family: `IDF ${displayName}`,
    displayName,
    category,
    resembles,
    pkg: id,
    weights: extra.weights ?? [400, 700],
    subsets,
    candidateFor: extra.candidateFor ?? [...new Set(subsets.map(scriptOfSubset))],
    ...(extra.glyphDefaults ? { glyphDefaults: extra.glyphDefaults } : {}),
  };
}

export const FONT_CATALOG: readonly CandidateFont[] = [
  // Arimo is metric-compatible with Arial, but its "1" has a foot serif that Arial's and Helvetica's lack.
  font('arimo', 'Arimo', 'sans', ['Arial', 'Helvetica'], LGCG, { glyphDefaults: { '1': 'roboto' } }),
  font('tinos', 'Tinos', 'serif', ['Times New Roman', 'Times'], LGCG),
  font('cousine', 'Cousine', 'mono', ['Courier New'], LGCG),
  font('carlito', 'Carlito', 'sans', ['Calibri'], LGCG),
  font('roboto', 'Roboto', 'sans', ['Roboto'], LGCG),
  font('open-sans', 'Open Sans', 'sans', ['Segoe UI', 'Verdana'], LGCG),
  font('roboto-condensed', 'Roboto Condensed', 'condensed', ['Arial Narrow'], LGCG),
  font('noto-serif', 'Noto Serif', 'serif', ['Noto Serif', 'Droid Serif'], LGCG),
  // Metric-compatible with common Microsoft fonts.
  font('caladea', 'Caladea', 'serif', ['Cambria'], LG),
  font('gelasio', 'Gelasio', 'serif', ['Georgia'], LG),
  // Classic office / print families.
  font('libre-franklin', 'Libre Franklin', 'sans', ['Franklin Gothic'], LGC),
  font('eb-garamond', 'EB Garamond', 'serif', ['Garamond'], LGCG),
  font('libre-baskerville', 'Libre Baskerville', 'serif', ['Baskerville', 'Book Antiqua'], LG),
  font('archivo-narrow', 'Archivo Narrow', 'condensed', ['Arial Narrow'], LG),
  font('ibm-plex-mono', 'IBM Plex Mono', 'mono', ['Consolas', 'Lucida Console'], LGC),
  // Frequent in modern, generated PDFs (web apps, invoices, reports).
  font('inter', 'Inter', 'sans', ['Helvetica Neue', 'Segoe UI'], LGCG),
  font('lato', 'Lato', 'sans', ['Lato', 'Gill Sans'], LG),
  font('montserrat', 'Montserrat', 'sans', ['Montserrat', 'Century Gothic'], LGC),
  font('source-sans-3', 'Source Sans 3', 'sans', ['Myriad Pro'], LGCG),
  font('noto-sans', 'Noto Sans', 'sans', ['Noto Sans', 'Droid Sans'], LGCG),
  font('pt-sans', 'PT Sans', 'sans', ['PT Sans', 'Trebuchet MS'], LGC),
  font('pt-serif', 'PT Serif', 'serif', ['PT Serif'], LGC),

  // Devanagari (Nepali, Hindi, Marathi). Each also carries matching Latin
  // letters and digits for mixed-script documents.
  font('noto-sans-devanagari', 'Noto Sans Devanagari', 'sans', ['Mangal', 'Nirmala UI'], DEVA, { candidateFor: ['devanagari'] }),
  font('noto-serif-devanagari', 'Noto Serif Devanagari', 'serif', ['Devanagari serif (book)'], DEVA, { candidateFor: ['devanagari'] }),
  font('mukta', 'Mukta', 'sans', ['Devanagari sans (humanist)'], DEVA, { candidateFor: ['devanagari'] }),
  font('hind', 'Hind', 'sans', ['Devanagari sans (UI)'], DEVA, { candidateFor: ['devanagari'] }),
  font('yantramanav', 'Yantramanav', 'sans', ['Devanagari sans (Roboto companion)'], DEVA, { candidateFor: ['devanagari'] }),
  font('poppins', 'Poppins', 'sans', ['Poppins', 'Futura'], DEVA, { candidateFor: ['latin', 'devanagari'] }),
  font('tiro-devanagari-hindi', 'Tiro Devanagari Hindi', 'serif', ['Devanagari traditional (Kokila-like)'], DEVA, { weights: [400], candidateFor: ['devanagari'] }),
  font('martel', 'Martel', 'serif', ['Devanagari traditional (high contrast)'], DEVA, { candidateFor: ['devanagari'] }),
  font('laila', 'Laila', 'serif', ['Devanagari text (book)'], DEVA, { candidateFor: ['devanagari'] }),
  font('karma', 'Karma', 'serif', ['Devanagari traditional (calligraphic)'], DEVA, { candidateFor: ['devanagari'] }),
  font('khand', 'Khand', 'condensed', ['Devanagari condensed'], DEVA, { candidateFor: ['devanagari'] }),

  // Handwriting: filled-in forms, handwritten invoices and receipts.
  font('kalam', 'Kalam', 'handwriting', ['Handwriting (print)'], DEVA, { candidateFor: ['latin', 'devanagari'] }),
  font('caveat', 'Caveat', 'handwriting', ['Handwriting (cursive)'], LGC),
  font('patrick-hand', 'Patrick Hand', 'handwriting', ['Handwriting (block)'], LG, { weights: [400] }),
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

/** CSS family of one subset of a font. Latin keeps the plain family name. */
export function subsetFamily(font: CandidateFont, subset: FontSubset): string {
  return subset === 'latin' ? font.family : `${font.family} ${subset}`;
}

/** Faces of a font, optionally restricted to some subsets. */
export function fontFaces(font: CandidateFont, subsets: Iterable<FontSubset> = font.subsets): CandidateFontFace[] {
  const wanted = new Set(subsets);
  const out: CandidateFontFace[] = [];
  for (const subset of font.subsets) {
    if (!wanted.has(subset)) continue;
    for (const weight of font.weights) {
      out.push({ weight, style: 'normal', subset, family: subsetFamily(font, subset), file: `${font.pkg}-${subset}-${weight}-normal.woff2` });
    }
  }
  return out;
}

/** Font drawing the subsets a family lacks, chosen to be as close in style as the catalogue allows. */
function fallbackFont(font: CandidateFont, subset: FontSubset): CandidateFont | undefined {
  const serif = font.category === 'serif';
  let id: string;
  if (subset === 'devanagari') id = font.category === 'handwriting' ? 'kalam' : serif ? 'noto-serif-devanagari' : 'noto-sans-devanagari';
  else id = serif ? 'noto-serif' : 'noto-sans';
  const f = BY_ID.get(id);
  return f && f.subsets.includes(subset) ? f : undefined;
}

/** Families each face-loading call must cover so that `fontStack(fontId)` renders every subset. */
export function stackFonts(fontId: string): { font: CandidateFont; subset: FontSubset }[] {
  const font = getFont(fontId);
  const out = font.subsets.map((subset) => ({ font, subset }));
  for (const subset of FONT_SUBSETS) {
    if (font.subsets.includes(subset)) continue;
    const fb = fallbackFont(font, subset);
    if (fb) out.push({ font: fb, subset });
  }
  return out;
}

const stackCache = new Map<string, string>();

/**
 * CSS font-family list for a candidate: its own subsets first, then
 * same-style fallbacks for writing systems it lacks, so a Devanagari word
 * typed into an Arimo line still renders (in Noto Sans Devanagari) rather
 * than as missing-glyph boxes. Canvas picks a family per character.
 */
export function fontStack(fontId: string): string {
  let s = stackCache.get(fontId);
  if (!s) {
    s = stackFonts(fontId)
      .map(({ font, subset }) => `"${subsetFamily(font, subset)}"`)
      .join(', ');
    stackCache.set(fontId, s);
  }
  return s;
}

export function cssFont(fontId: string, weight: number, italic: boolean, sizePx: number): string {
  return `${italic ? 'italic ' : ''}${weight} ${sizePx}px ${fontStack(fontId)}`;
}

/** Can this font draw every character of `text` from its own faces? */
export function fontCovers(font: CandidateFont, text: string): boolean {
  for (const ch of text) {
    const s = subsetOf(ch.codePointAt(0)!);
    if (s && !font.subsets.includes(s)) return false;
  }
  return true;
}

/**
 * Fitting candidates for `text`. `contextScripts` are the scripts of the
 * document's languages: they widen the choice for script-neutral text (a
 * number in a Nepali document may be set in a Devanagari family's digits)
 * and for Latin words in such documents.
 */
export function candidateFonts(text: string, contextScripts: Iterable<Script> = ['latin']): CandidateFont[] {
  const consider = new Set<Script>([...scriptsOf(text), ...contextScripts]);
  if (consider.size === 0) consider.add('latin');
  const covering = FONT_CATALOG.filter((f) => fontCovers(f, text));
  const preferred = covering.filter((f) => f.candidateFor.some((s) => consider.has(s)));
  if (preferred.length) return preferred;
  return covering.length ? covering : [...FONT_CATALOG];
}
