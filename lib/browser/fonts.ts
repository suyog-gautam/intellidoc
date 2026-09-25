import { getFont } from '@/core/typography/fontCatalog';
import { facesFor, type FaceRef } from '@/core/typography/fontFaces';
import { vendorUrl } from './paths';

export const FONT_BASE_URL = vendorUrl('fonts/');

interface FontFaceSetLike {
  add(face: FontFace): void;
}

/** Faces already requested per FontFaceSet (document.fonts / a worker's self.fonts). */
const requested = new WeakMap<FontFaceSetLike, Map<string, Promise<unknown>>>();

/**
 * Register font files in a FontFaceSet (document.fonts on the main thread,
 * self.fonts inside a worker) and wait for them to load. Canvas text only
 * uses a web font once it has actually loaded. Each file is one slice of a
 * font under its own family name (see core/typography/fontFaces.ts), so a
 * page of Chinese downloads only the slices holding its characters.
 */
export async function loadFaces(fonts: FontFaceSetLike, faces: Iterable<FaceRef>, baseUrl = FONT_BASE_URL): Promise<void> {
  let done = requested.get(fonts);
  if (!done) requested.set(fonts, (done = new Map()));
  const loads: Promise<unknown>[] = [];
  for (const face of faces) {
    let load = done.get(face.file);
    if (!load) {
      const ff = new FontFace(face.family, `url(${baseUrl}${face.file})`, { weight: String(face.weight), style: 'normal', unicodeRange: face.unicodeRange });
      fonts.add(ff);
      load = ff.load();
      done.set(face.file, load);
    }
    loads.push(load);
  }
  await Promise.all(loads);
}

/** Load what drawing `texts` in these fonts needs, including glyph-variant donors and fallbacks for other scripts. */
export function loadFontsFor(fonts: FontFaceSetLike, fontIds: Iterable<string>, texts: Iterable<string>, baseUrl = FONT_BASE_URL): Promise<void> {
  const ids = new Set<string>();
  for (const id of fontIds) {
    ids.add(id);
    for (const donor of Object.values(getFont(id).glyphDefaults ?? {})) ids.add(donor);
  }
  const text = [...texts].join(' ');
  return loadFaces(fonts, facesFor(ids, text), baseUrl);
}
