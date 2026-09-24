import type { IntellidocDocument, Page } from '@/core/document/model';
import { buildImagePdf, type PdfImagePage } from '@/core/export/pdfWriter';
import type { ReconstructionClient } from '@/lib/workers/reconstructionClient';

/**
 * Exports are produced by the worker's renderPage (the same renderer as the
 * on-screen preview) and never include editor overlays.
 */

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function baseName(doc: IntellidocDocument): string {
  return doc.source.fileName.replace(/\.[^.]+$/, '') || 'document';
}

export async function exportPageImage(client: ReconstructionClient, doc: IntellidocDocument, page: Page, type: 'image/png' | 'image/jpeg'): Promise<void> {
  const blob = await client.encodePage(page.sourceRef, page, type, type === 'image/jpeg' ? 0.95 : undefined);
  const suffix = doc.pages.length > 1 ? `-page${page.index + 1}` : '';
  download(blob, `${baseName(doc)}${suffix}-edited.${type === 'image/png' ? 'png' : 'jpg'}`);
}

/** True when every page has finished processing (ready or failed). */
export function canExportPdf(doc: IntellidocDocument): boolean {
  return doc.pages.every((p) => p.status === 'ready' || p.status === 'failed') && doc.pages.some((p) => p.status === 'ready');
}

/**
 * Multi-page PDF of the edited document, keeping each page's physical size
 * (the original PDF's page size, or the assumed DPI for images). Pages are
 * rendered and encoded one at a time to bound memory.
 */
export async function exportPdf(client: ReconstructionClient, doc: IntellidocDocument, onProgress?: (done: number, total: number) => void): Promise<{ skipped: number }> {
  const ready = doc.pages.filter((p) => p.status === 'ready');
  const pages: PdfImagePage[] = [];
  for (const [i, page] of ready.entries()) {
    onProgress?.(i, ready.length);
    const blob = await client.encodePage(page.sourceRef, page, 'image/jpeg', 0.95);
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), widthPt: page.physical.widthPt, heightPt: page.physical.heightPt });
  }
  onProgress?.(ready.length, ready.length);
  const pdf = buildImagePdf(pages, { title: `${baseName(doc)} (edited)` });
  download(new Blob([pdf.slice().buffer], { type: 'application/pdf' }), `${baseName(doc)}-edited.pdf`);
  return { skipped: doc.pages.length - ready.length };
}
