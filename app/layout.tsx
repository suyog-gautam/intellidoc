import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { contentSecurityPolicy } from '@/lib/security/csp';
import { cn } from '@/lib/utils';
import './globals.css';

/*
 * UI fonts per docs/Design.md, self-hosted (no third-party font requests:
 * part of the privacy guarantee). Latin subset, only the weights we use;
 * next/font preloads them and adjusts fallback metrics to avoid layout shift.
 */
const inter = localFont({
  src: [
    { path: '../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = localFont({
  src: [{ path: '../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', weight: '500', style: 'normal' }],
  variable: '--font-jetbrains',
  display: 'swap',
  preload: false,
});

export const metadata: Metadata = {
  title: 'IntelliDoc — edit scanned documents, keep the original look',
  description: 'Edit text in scanned PDFs and images while preserving their original visual appearance. Runs entirely in your browser.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#F5F4F0',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn(inter.variable, jetbrains.variable)}>
      {process.env.STATIC_EXPORT === 'true' && (
        // Static hosting (GitHub Pages) can't send headers: deliver the policy in-page.
        <head>
          <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy({ asHeader: false })} />
          <meta name="referrer" content="no-referrer" />
        </head>
      )}
      <body>{children}</body>
    </html>
  );
}
