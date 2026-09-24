import { describe, expect, it } from 'vitest';
import { buildImagePdf, readJpegInfo } from '@/core/export/pdfWriter';
import { createRaster } from '@/core/image/raster';
import { validateUpload } from '@/lib/image/validateUpload';
import { openNodePdf } from '@/lib/node/nodePdf';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { PageStore } from '@/workers/pageStore';
import { syntheticScanJpeg } from '../helpers/synthetic';

// Synthetic scans (no private documents in the repo).
const rasterizer = createNodeRasterizer();
const scan1 = await syntheticScanJpeg(rasterizer, 1200, 1680, 1);
const scan2 = await syntheticScanJpeg(rasterizer, 1620, 2265, 2);

function scannedPdf(): Uint8Array {
  const i2 = readJpegInfo(scan2.jpeg);
  return buildImagePdf([
    // Full-bleed scan at 300 DPI.
    { jpeg: scan1.jpeg, widthPt: (1200 * 72) / 300, heightPt: (1680 * 72) / 300 },
    // Letter page with the scan inset by half an inch.
    { jpeg: scan2.jpeg, widthPt: 612, heightPt: 792, placement: { x: 36, y: 36, width: 540, height: (540 * i2.height) / i2.width } },
  ]);
}

describe('PDF writer', () => {
  it('reads JPEG frame info', () => {
    expect(readJpegInfo(scan1.jpeg)).toMatchObject({ width: 1200, height: 1680 });
  });

  it('produces a structurally valid PDF', () => {
    const pdf = new TextDecoder('latin1').decode(scannedPdf());
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Count 2');
  });
});

describe('scanned PDF input', () => {
  it('renders each page at the native resolution of its scan', async () => {
    const src = await openNodePdf(scannedPdf());
    try {
      expect(src.pageCount).toBe(2);
      expect(await src.physicalSize(0)).toEqual({ widthPt: 288, heightPt: 403.2 });
      expect(await src.physicalSize(1)).toEqual({ widthPt: 612, heightPt: 792 });

      const page1 = await src.render(0);
      expect([page1.width, page1.height]).toEqual([1200, 1680]);
      // Pixel-faithful: matches the embedded JPEG decoded directly.
      const direct = scan1.raster;
      let diff = 0;
      for (let i = 0; i < direct.data.length; i += 4 * 97) diff += Math.abs(direct.data[i] - page1.data[i]);
      expect(diff / (direct.data.length / (4 * 97))).toBeLessThan(3);

      // Inset scan: 540 pt hold 1620 px => 3 px/pt (216 DPI), so the page renders at 612*3 x 792*3.
      const page2 = await src.render(1);
      expect([page2.width, page2.height]).toEqual([1836, 2376]);
    } finally {
      await src.dispose();
    }
  });

  it('rejects damaged PDFs with a user-facing message', async () => {
    const broken = new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf\n%%EOF');
    await expect(openNodePdf(broken)).rejects.toMatchObject({ userMessage: expect.stringContaining('could not be read') });
  });
});

describe('upload sniffing', () => {
  it('detects PDFs by content, even with leading junk', async () => {
    const pdf = new File([new Uint8Array([0, 1, 2]), scannedPdf().slice().buffer as ArrayBuffer], 'scan.bin');
    expect(await validateUpload(pdf)).toBe('application/pdf');
  });

  it('prefers image magic bytes over an embedded %PDF- string', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...new TextEncoder().encode('%PDF-1.7 in exif')]);
    expect(await validateUpload(new File([jpeg], 'x.pdf'))).toBe('image/jpeg');
  });
});

describe('worker page store', () => {
  it('keeps pages bit-exact under a memory budget', async () => {
    let encodes = 0;
    const store = new PageStore(
      {
        encode: async (img) => {
          encodes++;
          return new Blob([JSON.stringify({ w: img.width, h: img.height, d: Array.from(img.data) })]);
        },
        decode: async (blob) => {
          const o = JSON.parse(await blob.text()) as { w: number; h: number; d: number[] };
          return { width: o.w, height: o.h, data: Uint8ClampedArray.from(o.d) };
        },
      },
      2 * 16 * 16 * 4, // room for two 16x16 pages
    );
    const pages = [1, 2, 3].map((v) => createRaster(16, 16, [v, v, v, 255]));
    for (const [i, p] of pages.entries()) await store.put(`p${i}`, p);
    expect(encodes).toBe(1); // oldest page was packed
    for (const [i, p] of pages.entries()) expect((await store.get(`p${i}`)).data).toEqual(p.data);
  });
});
