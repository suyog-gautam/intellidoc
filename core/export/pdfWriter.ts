/**
 * Minimal PDF writer for raster documents.
 *
 * Each page is one JPEG image (embedded as-is with DCTDecode, no re-encoding)
 * placed on a page of the given physical size. That is exactly what a
 * scanned document is, so this covers export of edited scans without pulling
 * a large PDF library into the bundle. The interface is small so a full PDF
 * engine can replace it later (e.g. to keep a text layer).
 */

export interface JpegInfo {
  width: number;
  height: number;
  components: 1 | 3 | 4;
}

/** Read dimensions and component count from a JPEG's SOF marker. */
export function readJpegInfo(jpeg: Uint8Array): JpegInfo {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    // Standalone markers without length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (jpeg[i + 2] << 8) | jpeg[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (jpeg[i + 5] << 8) | jpeg[i + 6];
      const width = (jpeg[i + 7] << 8) | jpeg[i + 8];
      const components = jpeg[i + 9];
      if (components !== 1 && components !== 3 && components !== 4) throw new Error(`Unsupported JPEG component count ${components}`);
      return { width, height, components };
    }
    i += 2 + length;
  }
  throw new Error('JPEG has no frame header');
}

export interface PdfImagePage {
  jpeg: Uint8Array;
  /** Page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  /** Where the image goes on the page, in points from the bottom-left. Defaults to full page. */
  placement?: { x: number; y: number; width: number; height: number };
  /** /Rotate entry (viewer rotation), default 0. */
  rotate?: 0 | 90 | 180 | 270;
}

export interface PdfMetadata {
  title?: string;
  producer?: string;
}

const encoder = new TextEncoder();

function pdfString(s: string): string {
  // Literal string with escapes; restrict to printable ASCII for safety.
  const ascii = s.replace(/[^\x20-\x7e]/g, '?');
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function buildImagePdf(pages: readonly PdfImagePage[], meta: PdfMetadata = {}): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObject = (id: number) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };

  // Object ids: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageId = (i: number) => 4 + i * 3;
  const contentId = (i: number) => 5 + i * 3;
  const imageId = (i: number) => 6 + i * 3;
  const objectCount = 3 + pages.length * 3;

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObject(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>\nendobj\n`);
  beginObject(3);
  push(`<< /Producer ${pdfString(meta.producer ?? 'IntelliDoc')}${meta.title ? ` /Title ${pdfString(meta.title)}` : ''} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const info = readJpegInfo(page.jpeg);
    const place = page.placement ?? { x: 0, y: 0, width: page.widthPt, height: page.heightPt };
    const colorSpace = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const content = `q ${num(place.width)} 0 0 ${num(place.height)} ${num(place.x)} ${num(place.y)} cm /Im0 Do Q\n`;

    beginObject(pageId(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.widthPt)} ${num(page.heightPt)}]` +
        `${page.rotate ? ` /Rotate ${page.rotate}` : ''} /Resources << /XObject << /Im0 ${imageId(i)} 0 R >> >> /Contents ${contentId(i)} 0 R >>\nendobj\n`,
    );
    beginObject(contentId(i));
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    beginObject(imageId(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} ` +
        `/BitsPerComponent 8 /Filter /DCTDecode${info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
