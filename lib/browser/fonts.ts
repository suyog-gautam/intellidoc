import { FONT_CATALOG } from '@/core/typography/fontCatalog';
import { vendorUrl } from './paths';

export const FONT_BASE_URL = vendorUrl('fonts/');

interface FontFaceSetLike {
  add(face: FontFace): void;
}

/**
 * Register every candidate font face in the given FontFaceSet (document.fonts
 * on the main thread, self.fonts inside a worker) and wait for them to load.
 * Canvas text only uses a web font once it has actually loaded.
 */
export async function loadCandidateFonts(fonts: FontFaceSetLike, baseUrl = FONT_BASE_URL): Promise<void> {
  const loads: Promise<FontFace>[] = [];
  for (const font of FONT_CATALOG) {
    for (const face of font.faces) {
      const ff = new FontFace(font.family, `url(${baseUrl}${face.file})`, { weight: String(face.weight), style: face.style });
      fonts.add(ff);
      loads.push(ff.load());
    }
  }
  await Promise.all(loads);
}
