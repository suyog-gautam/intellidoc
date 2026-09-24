/**
 * Content Security Policy. Documents never leave the browser, so the policy
 * only has to allow same-origin assets (fonts, OCR model, WASM) plus blob:
 * for workers. Shared by the dev/server headers and the static-export <meta>.
 */
const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
];

/** `frame-ancestors` is only valid as an HTTP header, not in a <meta> tag. */
export function contentSecurityPolicy({ asHeader }: { asHeader: boolean }): string {
  return (asHeader ? [...DIRECTIVES, "frame-ancestors 'none'"] : DIRECTIVES).join('; ');
}
