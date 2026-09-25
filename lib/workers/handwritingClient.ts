import type { RasterImage } from '@/core/image/raster';
import type { HandwritingReading } from '@/core/ocr/handwritingPass';
import { vendorUrl } from '@/lib/browser/paths';
import type { HandwritingRequest, HandwritingResponse } from '@/workers/handwriting.worker';

let available: Promise<boolean> | undefined;

/** Is the handwriting model deployed? (Offline installs skip its download.) */
export function handwritingAvailable(): Promise<boolean> {
  return (available ??= fetch(vendorUrl('models/trocr-small-handwritten/vocab.json'), { method: 'HEAD' })
    .then((r) => r.ok)
    .catch(() => false));
}

/** Unload the model after this long without work: it holds ~300 MB. */
const IDLE_MS = 60_000;

/** Promise façade over the handwriting worker, created on first use and released when idle. */
export class HandwritingClient {
  private worker: Worker | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (r: HandwritingResponse) => void>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../../workers/handwriting.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<HandwritingResponse>) => {
        this.pending.get(ev.data.id)?.(ev.data);
        this.pending.delete(ev.data.id);
        if (!this.pending.size) this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS);
      };
    }
    return this.worker;
  }

  recognize(img: RasterImage): Promise<HandwritingReading | undefined> {
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    const copy = new Uint8ClampedArray(img.data);
    return new Promise((resolve) => {
      this.pending.set(id, (r) => resolve(r.error || r.text === undefined ? undefined : { text: r.text, confidence: r.confidence ?? 0 }));
      this.w.postMessage({ id, width: img.width, height: img.height, buffer: copy.buffer } satisfies HandwritingRequest, [copy.buffer]);
    });
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = undefined;
    for (const done of this.pending.values()) done({ id: 0, error: 'disposed' });
    this.pending.clear();
  }
}
