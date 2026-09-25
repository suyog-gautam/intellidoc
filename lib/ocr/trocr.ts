import type * as Ort from 'onnxruntime-web';
import type { RasterImage } from '@/core/image/raster';

/**
 * Handwriting line recognition with Microsoft's TrOCR (small, trained on
 * handwritten English lines), run on-device with ONNX Runtime Web. Tesseract
 * is trained on print; on handwritten entries it returns fragments like
 * "Va m ." where TrOCR reads "Rival Bag House".
 *
 * Minimal pipeline, no ML framework: resize the line to 384×384 and
 * normalise, run the image encoder once, then decode greedily token by token
 * (the decoder without KV cache: short lines make that cheap), and join the
 * SentencePiece pieces into text. Confidence is the mean probability of the
 * chosen tokens, so garbage (e.g. a Devanagari line fed to this English
 * model) comes back with a low score and is not used.
 */

export interface TrocrAssets {
  /** Loads a model file (path relative to the model directory). */
  bytes(path: string): Promise<Uint8Array>;
  json(path: string): Promise<unknown>;
}

export interface HandwritingResult {
  text: string;
  /** Mean probability of the decoded tokens, 0..1. */
  confidence: number;
}

const SIZE = 384;
const MAX_TOKENS = 48;

export class TrocrEngine {
  private ready: Promise<{ encoder: Ort.InferenceSession; decoder: Ort.InferenceSession; vocab: string[]; start: number; eos: number }> | undefined;

  constructor(
    private readonly ort: typeof Ort,
    private readonly assets: TrocrAssets,
  ) {}

  private load() {
    return (this.ready ??= (async () => {
      const [enc, dec, vocab, gen] = await Promise.all([
        this.assets.bytes('onnx/encoder_model_quantized.onnx'),
        this.assets.bytes('onnx/decoder_model_quantized.onnx'),
        this.assets.json('vocab.json') as Promise<string[]>,
        this.assets.json('generation_config.json') as Promise<{ decoder_start_token_id: number; eos_token_id: number }>,
      ]);
      const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [encoder, decoder] = await Promise.all([this.ort.InferenceSession.create(enc, opts), this.ort.InferenceSession.create(dec, opts)]);
      return { encoder, decoder, vocab, start: gen.decoder_start_token_id, eos: gen.eos_token_id };
    })());
  }

  /**
   * Read one line. Also decodes a second time allowing only digits and
   * separators: the model learned English text and prefers words ("good"
   * for a handwritten "9000"), yet amounts and dates are what forms are
   * edited for. The numeric reading wins when the model finds it at least
   * half as likely as the free one.
   */
  async recognize(line: RasterImage): Promise<HandwritingResult> {
    const { encoder, vocab } = await this.load();
    const pixels = new this.ort.Tensor('float32', preprocess(line), [1, 3, SIZE, SIZE]);
    const encoded = await encoder.run({ [encoder.inputNames[0]]: pixels });
    const hidden = encoded[encoder.outputNames[0]];
    const free = await this.decode(hidden);
    const numeric = await this.decode(hidden, numericMask(vocab));
    // Numbers: prefer the digit reading unless the free reading is clearly more likely (real words).
    // Measured on real handwriting: digit readings of numbers score 0.65–1.0 of the free reading, of words ≤ 0.07.
    return numeric.text && /\d/.test(numeric.text) && numeric.confidence >= Math.max(0.2, free.confidence * 0.5) ? numeric : free;
  }

  private async decode(hidden: Ort.Tensor, allowed?: Uint8Array): Promise<HandwritingResult> {
    const { decoder, vocab, start, eos } = await this.load();
    const ids: number[] = [start];
    let probSum = 0;
    for (let step = 0; step < MAX_TOKENS; step++) {
      const feeds: Record<string, Ort.Tensor> = {};
      for (const name of decoder.inputNames) {
        if (name === 'input_ids') feeds[name] = new this.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
        else if (name === 'encoder_hidden_states') feeds[name] = hidden;
        else if (name === 'encoder_attention_mask') feeds[name] = new this.ort.Tensor('int64', new BigInt64Array(hidden.dims[1]).fill(1n), [1, hidden.dims[1]]);
      }
      const out = await decoder.run(feeds);
      const logits = out[decoder.outputNames[0]];
      const v = logits.dims[2];
      const data = logits.data as Float32Array;
      const offset = (ids.length - 1) * v;
      let best = 0;
      let max = -Infinity;
      let top = -Infinity;
      for (let k = 0; k < v; k++) {
        top = Math.max(top, data[offset + k]);
        if ((allowed ? allowed[k] || k === eos : true) && data[offset + k] > max) [max, best] = [data[offset + k], k];
      }
      let z = 0;
      for (let k = 0; k < v; k++) z += Math.exp(data[offset + k] - top);
      // Probability of the chosen token under the unconstrained distribution.
      const p = Math.exp(max - top) / z;
      if (best === eos) break;
      ids.push(best);
      probSum += p;
    }
    const n = ids.length - 1;
    return { text: detokenize(ids.slice(1), vocab), confidence: n ? probSum / n : 0 };
  }

  async dispose(): Promise<void> {
    const r = await this.ready?.catch(() => undefined);
    await r?.encoder.release();
    await r?.decoder.release();
    this.ready = undefined;
  }
}

/** Line image → normalised NCHW float32, 384×384 (bilinear), as the model's DeiT processor does. */
export function preprocess(img: RasterImage): Float32Array {
  const out = new Float32Array(3 * SIZE * SIZE);
  const sx = img.width / SIZE;
  const sy = img.height / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < SIZE; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const at = (xx: number, yy: number) => img.data[(yy * img.width + xx) * 4 + c];
        const v = (at(x0, y0) * (1 - wx) + at(x1, y0) * wx) * (1 - wy) + (at(x0, y1) * (1 - wx) + at(x1, y1) * wx) * wy;
        out[c * SIZE * SIZE + y * SIZE + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return out;
}

const masks = new WeakMap<readonly string[], Uint8Array>();

/** Tokens made only of digits and number punctuation (with or without the word-start mark). */
function numericMask(vocab: readonly string[]): Uint8Array {
  let m = masks.get(vocab);
  if (!m) {
    m = new Uint8Array(vocab.length);
    vocab.forEach((piece, i) => {
      const bare = piece?.replace(/^▁/, '');
      if (bare && /^[0-9/\-.,:]+$/.test(bare)) m![i] = 1;
    });
    masks.set(vocab, m);
  }
  return m;
}

/** SentencePiece pieces → text: "▁" starts a new word; special tokens are dropped. */
export function detokenize(ids: readonly number[], vocab: readonly string[]): string {
  let s = '';
  for (const id of ids) {
    const piece = vocab[id];
    if (!piece || /^<.*>$/.test(piece)) continue;
    s += piece.replace(/▁/g, ' ');
  }
  return s.trim().replace(/\s+/g, ' ');
}
