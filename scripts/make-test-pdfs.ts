/**
 * Build a 2-page scanned-PDF fixture (npm run slice -- output/fixtures/<file>.pdf).
 * Uses JPEGs from the git-ignored "test files/" folder when present, otherwise
 * synthetic scans, so no private document is ever needed or committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildImagePdf, readJpegInfo, type PdfImagePage } from '@/core/export/pdfWriter';
import { createNodeRasterizer } from '@/lib/node/nodeRuntime';
import { syntheticScanJpeg } from '@/tests/helpers/synthetic';

const dir = 'test files';
let jpegs: Uint8Array[] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f)))) : [];
if (jpegs.length === 0) {
  const r = createNodeRasterizer();
  jpegs = [(await syntheticScanJpeg(r, 2160, 3020, 1)).jpeg, (await syntheticScanJpeg(r, 2160, 3015, 2)).jpeg];
  console.log('No JPEGs in "test files/": using synthetic scans.');
}

const pages: PdfImagePage[] = jpegs.map((jpeg, i) => {
  const info = readJpegInfo(jpeg);
  if (i % 2 === 0) return { jpeg, widthPt: (info.width * 72) / 300, heightPt: (info.height * 72) / 300 };
  // Every other page: US Letter with the scan inset by half an inch.
  return { jpeg, widthPt: 612, heightPt: 792, placement: { x: 36, y: 36, width: 540, height: (540 * info.height) / info.width } };
});

fs.mkdirSync('output/fixtures', { recursive: true });
const out = path.join('output', 'fixtures', `scanned-${pages.length}page.pdf`);
fs.writeFileSync(out, buildImagePdf(pages, { title: 'IntelliDoc scanned fixture' }));
console.log(`wrote ${out}`);
