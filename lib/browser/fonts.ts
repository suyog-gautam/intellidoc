import { FONT_CATALOG, fontFaces } from '@/core/typography/fontCatalog';
import { subsetsOf, type FontSubset } from '@/core/text/script';
import { vendorUrl } from './paths';

export const FONT_BASE_URL = vendorUrl('fonts/');

interface FontFaceSetLike {
  add(face: FontFace): void;
}

/** Faces already requested per FontFaceSet (document.fonts / a worker's self.fonts). */
const requested = new WeakMap<FontFaceSetLike, Map<string, Promise<unknown>>>();

/**
 * Register the candidate font faces of the given subsets in a FontFaceSet
 * (document.fonts on the main thread, self.fonts inside a worker) and wait
 * for them to load. Canvas text only uses a web font once it has actually
 * loaded. Each subset is a separate CSS family (see `fontStack`), so the
 * Latin faces (~900 KB) are all a Latin-only document ever downloads;
 * Devanagari, Cyrillic, Greek and extended-Latin faces load the first time
 * such text is analysed or rendered.
 */
export async function loadCandidateFonts(fonts: FontFaceSetLike, subsets: Iterable<FontSubset> = ['latin'], baseUrl = FONT_BASE_URL): Promise<void> {
  let done = requested.get(fonts);
  if (!done) requested.set(fonts, (done = new Map()));
  const loads: Promise<unknown>[] = [];
  for (const font of FONT_CATALOG) {
    for (const face of fontFaces(font, subsets)) {
      const key = `${face.family}/${face.weight}`;
      let load = done.get(key);
      if (!load) {
        const ff = new FontFace(face.family, `url(${baseUrl}${face.file})`, { weight: String(face.weight), style: face.style });
        fonts.add(ff);
        load = ff.load();
        done.set(key, load);
      }
      loads.push(load);
    }
  }
  await Promise.all(loads);
}

/** Load whatever the given texts need (always including Latin). */
export function loadFontsForText(fonts: FontFaceSetLike, texts: Iterable<string>, baseUrl = FONT_BASE_URL): Promise<void> {
  const subsets = new Set<FontSubset>(['latin']);
  for (const t of texts) for (const s of subsetsOf(t)) subsets.add(s);
  return loadCandidateFonts(fonts, subsets, baseUrl);
}
