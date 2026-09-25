/**
 * Downloads the handwriting recognition model (Microsoft TrOCR small,
 * handwritten; ONNX export by Xenova, quantized) into
 * public/vendor/models, so the app serves it same-origin like every other
 * asset: no request ever reveals that a document is being processed.
 *
 * Licence: TrOCR comes from Microsoft's unilm repository (MIT-licensed code); the
 * model card itself states no licence, so check it before commercial use.
 *
 * The model is not on npm, so it comes from Hugging Face at install time,
 * pinned to a revision and verified by SHA-256. Offline installs skip it
 * with a warning; the app then simply doesn't offer handwriting reading.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const REPO = 'Xenova/trocr-small-handwritten';
const REVISION = '2432e24d184b1d964d07ed04f5d9e21d31a59141';
const out = path.join(root, 'public', 'vendor', 'models', 'trocr-small-handwritten');
const cache = path.join(root, '.scratch', 'model-cache', 'trocr-small-handwritten');

/** File → SHA-256 at REVISION. */
const FILES = {
  'onnx/encoder_model_quantized.onnx': '2f29edbd925f8a49c9c7d1349895f960cf09d2efdc76fe23f957048d476e0d03',
  'onnx/decoder_model_quantized.onnx': '40166e4f975b3cecd24bb422db80eb06912777c8e8a56ab44f6bd771ec5df553',
  'config.json': 'ab388d889bdead2a554fc77ae4899caabdb279318e660b457afd29394e8ee43d',
  'generation_config.json': 'cce308da91e0d656e07404c70d4b9c9f5839d426f679eff6fda6dcc0e727e3b6',
  'preprocessor_config.json': '70da3434c33eedb3b56caf4067851741dfeed02f67576dcc3c6407c2533bfaf0',
  'tokenizer.json': '68bcb5468c854362a615f3d2ff6a5e4091a85f4c8198993ed9a30afe0b143737',
};

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // curl honours the environment's proxy settings and follows the CDN redirect.
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', `${dest}.part`, url], { stdio: 'inherit' });
  fs.renameSync(`${dest}.part`, dest);
}

try {
  for (const [file, expected] of Object.entries(FILES)) {
    const cached = path.join(cache, file);
    if (!fs.existsSync(cached) || (expected && sha256(cached) !== expected)) {
      download(`https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`, cached);
    }
    const actual = sha256(cached);
    if (expected && actual !== expected) throw new Error(`${file}: SHA-256 mismatch (${actual})`);
    if (!expected) console.log(`[intellidoc] ${file} sha256 ${actual} (not pinned yet)`);
    if (file === 'tokenizer.json') continue;
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(cached, path.join(out, file));
  }
  // The app only needs id → token to turn output ids into text: a compact list instead of the 4.5 MB tokenizer.
  const tok = JSON.parse(fs.readFileSync(path.join(cache, 'tokenizer.json'), 'utf8'));
  // SentencePiece Unigram: vocab is a list of [piece, score], id = index ("▁" marks a word start).
  const vocab = tok.model.vocab.map(([piece]) => piece);
  for (const t of tok.added_tokens ?? []) vocab[t.id] = t.content;
  fs.writeFileSync(path.join(out, 'vocab.json'), JSON.stringify(vocab));
  const size = Object.keys(FILES)
    .filter((f) => f !== 'tokenizer.json')
    .reduce((n, f) => n + fs.statSync(path.join(out, f)).size, fs.statSync(path.join(out, 'vocab.json')).size);
  console.log(`[intellidoc] handwriting model ready (${(size / 1e6).toFixed(1)} MB)`);
} catch (e) {
  console.warn(`[intellidoc] handwriting model not downloaded (${e instanceof Error ? e.message : e}); handwriting reading will be unavailable.`);
}
