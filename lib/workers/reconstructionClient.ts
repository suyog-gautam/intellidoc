import type { Page, PageLayout, TextElement, TypographyEstimate } from '@/core/document/model';
import type { RecoveryCropMeta } from '@/core/ocr/recovery';
import type { OcrResult } from '@/core/ocr/types';
import type { RasterImage } from '@/core/image/raster';
import type { WorkerRequest, WorkerResponse } from '@/workers/protocol';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Promise-based façade over the reconstruction worker. */
export class ReconstructionClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('../../workers/reconstruction.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.type === 'error') p.reject(new Error(ev.data.message));
      else p.resolve(ev.data);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Processing worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
    });
  }

  /** Sends a *copy* of the raster; the caller keeps its original untouched. */
  async loadPage(pageKey: string, img: RasterImage): Promise<void> {
    const copy = new Uint8ClampedArray(img.data);
    await this.call({ type: 'loadPage', pageKey, width: img.width, height: img.height, buffer: copy.buffer }, [copy.buffer]);
  }

  /** OCR working copy (illumination-flattened, upscaled for small text) and page skew. */
  async preprocess(pageKey: string): Promise<{ ocrImage: Blob; skew: number; ocrScale: number }> {
    const r = await this.call({ type: 'preprocess', pageKey });
    if (r.type !== 'preprocessed') throw new Error('Unexpected worker response');
    return { ocrImage: r.ocrImage, skew: r.skew, ocrScale: r.ocrScale };
  }

  async recoveryCrops(pageKey: string, ocr: OcrResult): Promise<Array<{ meta: RecoveryCropMeta; image: Blob }>> {
    const r = await this.call({ type: 'recoveryCrops', pageKey, ocr });
    if (r.type !== 'recoveryCrops') throw new Error('Unexpected worker response');
    return r.crops;
  }

  async buildPage(pageKey: string, pageId: string, ocr: OcrResult, skew: number): Promise<{ textElements: TextElement[]; layout: PageLayout }> {
    const r = await this.call({ type: 'buildPage', pageKey, pageId, ocr, skew });
    if (r.type !== 'pageBuilt') throw new Error('Unexpected worker response');
    return { textElements: r.textElements, layout: r.layout };
  }

  async analyze(pageKey: string, page: Page, element: TextElement, languages?: readonly string[]): Promise<TypographyEstimate | undefined> {
    const r = await this.call({ type: 'analyze', pageKey, page, element, languages: languages && [...languages] });
    if (r.type !== 'analyzed') throw new Error('Unexpected worker response');
    return r.typography;
  }

  private async raster(req: DistributiveOmit<WorkerRequest, 'id'>) {
    const r = await this.call(req);
    if (r.type !== 'raster') throw new Error('Unexpected worker response');
    return { image: { width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) } as RasterImage, pending: r.pending, overflowing: r.overflowing };
  }

  /** Output of the page (original + edits). Same renderer as export. */
  render(pageKey: string, page: Page): Promise<{ image: RasterImage; pending: string[]; overflowing: string[] }> {
    return this.raster({ type: 'render', pageKey, page });
  }

  /** A copy of the untouched original page. */
  async getOriginal(pageKey: string): Promise<RasterImage> {
    return (await this.raster({ type: 'getOriginal', pageKey })).image;
  }

  /** Small JPEG of the original page (for thumbnails). */
  async thumbnail(pageKey: string, width: number): Promise<Blob> {
    const r = await this.call({ type: 'thumbnail', pageKey, width });
    if (r.type !== 'encoded') throw new Error('Unexpected worker response');
    return r.blob;
  }

  async encodePage(pageKey: string, page: Page, mimeType: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
    const r = await this.call({ type: 'encodePage', pageKey, page, mimeType, quality });
    if (r.type !== 'encoded') throw new Error('Unexpected worker response');
    return r.blob;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
