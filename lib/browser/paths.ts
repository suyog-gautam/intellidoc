/**
 * URL prefix the app is served under: '' locally, '/<repo>' on GitHub Pages.
 *
 * Next.js inlines NEXT_PUBLIC_BASE_PATH at build time. As a fallback (and in
 * Web Workers, whose bundles may not see build-time env), it is derived from
 * the running script's own URL: everything before '/_next/' is the base.
 */
function detectBasePath(): string {
  const fromEnv = process.env.NEXT_PUBLIC_BASE_PATH;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.replace(/\/$/, '');
  if (typeof self !== 'undefined' && self.location) {
    const i = self.location.pathname.indexOf('/_next/');
    if (i >= 0) return self.location.pathname.slice(0, i);
  }
  return '';
}

export const BASE_PATH = detectBasePath();

/** Absolute-path URL of a file under public/vendor (OCR model, WASM, fonts). */
export function vendorUrl(path: string): string {
  return `${BASE_PATH}/vendor/${path.replace(/^\//, '')}`;
}
