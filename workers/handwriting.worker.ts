/// <reference lib="webworker" />
/**
 * Handwriting recognition worker (TrOCR on ONNX Runtime Web). Separate from
 * the reconstruction worker so a few seconds of recognition never delay
 * previews. The model (~64 MB) and runtime load on first use, same-origin.
 */
// The plain WASM build: the default entry also carries WebGPU (a larger, separate runtime file).
import * as ort from 'onnxruntime-web/wasm';
import { TrocrEngine } from '@/lib/ocr/trocr';
import { vendorUrl } from '@/lib/browser/paths';

export type HandwritingRequest = { id: number; width: number; height: number; buffer: ArrayBuffer };
export type HandwritingResponse = { id: number; text?: string; confidence?: number; error?: string };

declare const self: DedicatedWorkerGlobalScope;

// Same-origin runtime files (never a CDN). Threads need cross-origin isolation, which static hosting can't promise.
ort.env.wasm.wasmPaths = new URL(vendorUrl('ort/'), self.location.href).href;
ort.env.wasm.numThreads = 1;

const MODEL = vendorUrl('models/trocr-small-handwritten/');
const engine = new TrocrEngine(ort, {
  bytes: async (p) => new Uint8Array(await (await fetch(MODEL + p)).arrayBuffer()),
  json: async (p) => (await fetch(MODEL + p)).json(),
});

// One line at a time: the model is single-threaded anyway, and order is preserved.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<HandwritingRequest>) => {
  const { id, width, height, buffer } = ev.data;
  queue = queue.then(async () => {
    try {
      const r = await engine.recognize({ width, height, data: new Uint8ClampedArray(buffer) });
      self.postMessage({ id, text: r.text, confidence: r.confidence } satisfies HandwritingResponse);
    } catch (e) {
      self.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies HandwritingResponse);
    }
  });
};
