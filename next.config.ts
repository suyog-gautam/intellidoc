import type { NextConfig } from 'next';
import { contentSecurityPolicy } from './lib/security/csp';

/**
 * Two modes:
 *  - STATIC_EXPORT=true (GitHub Pages): a fully static site in `out/`, served
 *    under NEXT_PUBLIC_BASE_PATH (e.g. /intellidoc). Static hosts can't set
 *    headers, so the CSP is delivered as a <meta> tag (see app/layout.tsx).
 *  - otherwise (dev / `next start`): security and caching headers from here.
 * The app needs no server either way: all processing is in the browser.
 */
const isStaticExport = process.env.STATIC_EXPORT === 'true';
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isStaticExport
    ? { output: 'export' as const, basePath: basePath || undefined, trailingSlash: true, images: { unoptimized: true } }
    : {
        async headers() {
          return [
            {
              // OCR model, WASM cores and candidate fonts: large, versioned with the
              // app build, never user data. Cache them so repeat visits download nothing.
              source: '/vendor/:path*',
              headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, stale-while-revalidate=86400' }],
            },
            {
              source: '/:path*',
              headers: [
                { key: 'Content-Security-Policy', value: contentSecurityPolicy({ asHeader: true }) },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'no-referrer' },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
