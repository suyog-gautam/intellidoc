/**
 * Memory and CPU budgets for this device, so the editor degrades gracefully
 * on low-end phones instead of the tab being killed.
 *
 * Measured on phone photos: a 3.7 MP challan whose small print is upscaled 3×
 * for OCR peaks at ~2 GB in the browser (Tesseract holds the 34 MP working
 * image several times over); the handwriting model adds ~300 MB. Low-end
 * Android phones give a tab well under 1 GB. The budgets below trade a little
 * OCR accuracy on small print for staying alive there; normal devices keep
 * the full-quality path.
 *
 * Works in windows and workers (`navigator` exists in both).
 */
export type DeviceTier = 'low' | 'mid' | 'high';

export interface DeviceBudgets {
  tier: DeviceTier;
  /** Largest page raster kept for editing; larger images are downscaled on open. */
  imagePixels: number;
  /** Largest upscaled working image handed to OCR. */
  ocrPixels: number;
  /** Decoded page rasters kept in memory before older pages are compressed. */
  pageCacheBytes: number;
  /** Read handwriting automatically after OCR (else only on request). */
  autoHandwriting: boolean;
}

interface NavigatorHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { saveData?: boolean };
}

export function deviceTier(nav: NavigatorHints | undefined = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorHints)): DeviceTier {
  // deviceMemory is Chromium-only (rounded, capped at 8); Safari/Firefox don't say, so assume a mid-range device.
  const memory = nav?.deviceMemory ?? 4;
  const cores = nav?.hardwareConcurrency ?? 4;
  if (memory <= 2 || cores <= 2) return 'low';
  if (memory < 8 || cores < 4) return 'mid';
  return 'high';
}

const BUDGETS: Record<DeviceTier, Omit<DeviceBudgets, 'tier' | 'autoHandwriting'>> = {
  high: { imagePixels: 40_000_000, ocrPixels: 40_000_000, pageCacheBytes: 600 * 1024 * 1024 },
  mid: { imagePixels: 16_000_000, ocrPixels: 20_000_000, pageCacheBytes: 250 * 1024 * 1024 },
  low: { imagePixels: 9_000_000, ocrPixels: 10_000_000, pageCacheBytes: 100 * 1024 * 1024 },
};

export function deviceBudgets(nav: NavigatorHints | undefined = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorHints)): DeviceBudgets {
  const tier = deviceTier(nav);
  return { tier, ...BUDGETS[tier], autoHandwriting: tier !== 'low' && !nav?.connection?.saveData };
}
