import type { RasterImage } from '@/core/image/raster';

export interface PhysicalSize {
  /** PDF points (1/72 inch), as the page should appear when printed/exported. */
  widthPt: number;
  heightPt: number;
}

/**
 * A document's pages as rasters, independent of the input format. Images are
 * a single page; PDFs are rendered page by page on demand so a long document
 * never has to be held in memory at once.
 */
export interface PageSource {
  readonly kind: 'image' | 'pdf';
  readonly pageCount: number;
  /** Pages that exist in the file but were not loaded because of limits. */
  readonly skippedPages: number;
  physicalSize(index: number): Promise<PhysicalSize>;
  render(index: number): Promise<RasterImage>;
  dispose(): Promise<void>;
}

/** Assumed resolution for bare images (no reliable DPI metadata in most scans). */
export const IMAGE_ASSUMED_DPI = 300;

export function imagePageSource(raster: RasterImage): PageSource {
  return {
    kind: 'image',
    pageCount: 1,
    skippedPages: 0,
    physicalSize: async () => ({ widthPt: (raster.width * 72) / IMAGE_ASSUMED_DPI, heightPt: (raster.height * 72) / IMAGE_ASSUMED_DPI }),
    render: async () => raster,
    dispose: async () => undefined,
  };
}
