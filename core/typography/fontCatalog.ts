import type { FontCategory } from '../document/model';

export interface CandidateFontFace {
  weight: 400 | 700;
  style: 'normal' | 'italic';
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
  /** CSS family name used when registering the faces (namespaced to avoid clashing with system fonts). */
  family: string;
  displayName: string;
  category: FontCategory;
  resembles: string[];
  faces: CandidateFontFace[];
}

/**
 * Upright faces only. Slanted scan text is matched with the synthetic
 * `skewX` render parameter, which fits real scans at least as well as a
 * font's own italic, so shipping italic faces would double the download for
 * no fidelity gain.
 */
function faces(pkg: string): CandidateFontFace[] {
  return ([400, 700] as const).map((weight) => ({ weight, style: 'normal' as const, file: `${pkg}-latin-${weight}-normal.woff2` }));
}

export const FONT_CATALOG: readonly CandidateFont[] = [
  { id: 'arimo', family: 'IDF Arimo', displayName: 'Arimo', category: 'sans', resembles: ['Arial', 'Helvetica'], faces: faces('arimo') },
  { id: 'tinos', family: 'IDF Tinos', displayName: 'Tinos', category: 'serif', resembles: ['Times New Roman', 'Times'], faces: faces('tinos') },
  { id: 'cousine', family: 'IDF Cousine', displayName: 'Cousine', category: 'mono', resembles: ['Courier New'], faces: faces('cousine') },
  { id: 'carlito', family: 'IDF Carlito', displayName: 'Carlito', category: 'sans', resembles: ['Calibri'], faces: faces('carlito') },
  { id: 'roboto', family: 'IDF Roboto', displayName: 'Roboto', category: 'sans', resembles: ['Roboto'], faces: faces('roboto') },
  { id: 'open-sans', family: 'IDF Open Sans', displayName: 'Open Sans', category: 'sans', resembles: ['Segoe UI', 'Verdana'], faces: faces('open-sans') },
  { id: 'roboto-condensed', family: 'IDF Roboto Condensed', displayName: 'Roboto Condensed', category: 'condensed', resembles: ['Arial Narrow'], faces: faces('roboto-condensed') },
  { id: 'noto-serif', family: 'IDF Noto Serif', displayName: 'Noto Serif', category: 'serif', resembles: ['Noto Serif', 'Droid Serif'], faces: faces('noto-serif') },
  // Metric-compatible with common Microsoft fonts.
  { id: 'caladea', family: 'IDF Caladea', displayName: 'Caladea', category: 'serif', resembles: ['Cambria'], faces: faces('caladea') },
  { id: 'gelasio', family: 'IDF Gelasio', displayName: 'Gelasio', category: 'serif', resembles: ['Georgia'], faces: faces('gelasio') },
  // Classic office / print families.
  { id: 'libre-franklin', family: 'IDF Libre Franklin', displayName: 'Libre Franklin', category: 'sans', resembles: ['Franklin Gothic'], faces: faces('libre-franklin') },
  { id: 'eb-garamond', family: 'IDF EB Garamond', displayName: 'EB Garamond', category: 'serif', resembles: ['Garamond'], faces: faces('eb-garamond') },
  { id: 'libre-baskerville', family: 'IDF Libre Baskerville', displayName: 'Libre Baskerville', category: 'serif', resembles: ['Baskerville', 'Book Antiqua'], faces: faces('libre-baskerville') },
  { id: 'archivo-narrow', family: 'IDF Archivo Narrow', displayName: 'Archivo Narrow', category: 'condensed', resembles: ['Arial Narrow'], faces: faces('archivo-narrow') },
  { id: 'ibm-plex-mono', family: 'IDF IBM Plex Mono', displayName: 'IBM Plex Mono', category: 'mono', resembles: ['Consolas', 'Lucida Console'], faces: faces('ibm-plex-mono') },
  // Frequent in modern, generated PDFs (web apps, invoices, reports).
  { id: 'inter', family: 'IDF Inter', displayName: 'Inter', category: 'sans', resembles: ['Helvetica Neue', 'Segoe UI'], faces: faces('inter') },
  { id: 'lato', family: 'IDF Lato', displayName: 'Lato', category: 'sans', resembles: ['Lato', 'Gill Sans'], faces: faces('lato') },
  { id: 'montserrat', family: 'IDF Montserrat', displayName: 'Montserrat', category: 'sans', resembles: ['Montserrat', 'Century Gothic'], faces: faces('montserrat') },
  { id: 'source-sans-3', family: 'IDF Source Sans 3', displayName: 'Source Sans 3', category: 'sans', resembles: ['Myriad Pro'], faces: faces('source-sans-3') },
  { id: 'noto-sans', family: 'IDF Noto Sans', displayName: 'Noto Sans', category: 'sans', resembles: ['Noto Sans', 'Droid Sans'], faces: faces('noto-sans') },
  { id: 'pt-sans', family: 'IDF PT Sans', displayName: 'PT Sans', category: 'sans', resembles: ['PT Sans', 'Trebuchet MS'], faces: faces('pt-sans') },
  { id: 'pt-serif', family: 'IDF PT Serif', displayName: 'PT Serif', category: 'serif', resembles: ['PT Serif'], faces: faces('pt-serif') },
];

export function getFont(id: string): CandidateFont {
  const f = FONT_CATALOG.find((c) => c.id === id);
  if (!f) throw new Error(`Unknown font ${id}`);
  return f;
}

export function cssFont(fontId: string, weight: number, italic: boolean, sizePx: number): string {
  return `${italic ? 'italic ' : ''}${weight} ${sizePx}px "${getFont(fontId).family}"`;
}
