/**
 * Copies runtime assets (OCR engine, OCR language model, candidate fonts)
 * from node_modules into public/vendor so the app never has to fetch them
 * from a third-party CDN. Keeping everything same-origin is part of the
 * privacy guarantee: no network request ever reveals that a document is
 * being processed.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'public', 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyMatching(dir, pattern, destDir) {
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (pattern.test(name)) {
      copy(path.join(dir, name), path.join(destDir, name));
      count++;
    }
  }
  return count;
}

if (!fs.existsSync(nm)) process.exit(0);

// Tesseract.js worker script + WASM cores.
copy(path.join(nm, 'tesseract.js', 'dist', 'worker.min.js'), path.join(out, 'tesseract', 'worker.min.js'));
// Only the LSTM builds with embedded WASM (*-lstm.wasm.js): IntelliDoc runs
// Tesseract in LSTM-only mode, and the browser worker loads the .wasm.js form.
// tesseract.js picks plain / SIMD / relaxed-SIMD at runtime, so all three ship.
fs.rmSync(path.join(out, 'tesseract', 'core'), { recursive: true, force: true });
copyMatching(path.join(nm, 'tesseract.js-core'), /^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/, path.join(out, 'tesseract', 'core'));
// Script detection (OSD) runs on Tesseract's legacy engine: those full cores
// load only when a document is opened with language "Auto".
copyMatching(path.join(nm, 'tesseract.js-core'), /^tesseract-core(-simd|-relaxedsimd)?\.wasm\.js$/, path.join(out, 'tesseract', 'core'));
copy(path.join(nm, '@tesseract.js-data', 'osd', '4.0.0', 'osd.traineddata.gz'), path.join(out, 'tesseract', 'lang', 'osd.traineddata.gz'));
// OCR language models: every language of the catalogue (core/ocr/languages.ts).
// The browser downloads only the ones the user picks, once, then caches them.
const languageSource = fs.readFileSync(path.join(root, 'core', 'ocr', 'languages.ts'), 'utf8');
const OCR_LANGUAGE_CODES = [...languageSource.matchAll(/^\s*L\('([a-z_]+)'/gm)].map((m) => m[1]);
for (const code of OCR_LANGUAGE_CODES) {
  // best_int (smaller, faster) where published; a few languages only ship the 4.0.0 model.
  const variant = fs.existsSync(path.join(nm, '@tesseract.js-data', code, '4.0.0_best_int')) ? '4.0.0_best_int' : '4.0.0';
  copy(path.join(nm, '@tesseract.js-data', code, variant, `${code}.traineddata.gz`), path.join(out, 'tesseract', 'lang', `${code}.traineddata.gz`));
}

// ONNX Runtime Web (handwriting recognition): the CPU WASM build and its loader.
fs.rmSync(path.join(out, 'ort'), { recursive: true, force: true });
copyMatching(path.join(nm, 'onnxruntime-web', 'dist'), /^ort-wasm-simd-threaded\.(wasm|mjs)$/, path.join(out, 'ort'));

// pdf.js worker plus the resources it fetches at runtime (CMaps for CJK text,
// standard fonts, WASM image decoders for JPX/JBIG2 scans, ICC profiles).
copy(path.join(nm, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'), path.join(out, 'pdfjs', 'pdf.worker.min.mjs'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = path.join(nm, 'pdfjs-dist', dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, 'pdfjs', dir), { recursive: true });
}

// Candidate fonts: exactly the files of the font manifest (generated from the
// catalogue by scripts/build-font-manifest.mjs). The app downloads only the
// slices a document's text needs.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'core', 'typography', 'fontFaces.json'), 'utf8'));
fs.rmSync(path.join(out, 'fonts'), { recursive: true, force: true });
let fonts = 0;
for (const [pkg, { weights, slices }] of Object.entries(manifest.fonts)) {
  for (const [id] of slices) {
    for (const w of weights) {
      const file = `${pkg}-${id}-${w}-normal.woff2`;
      copy(path.join(nm, '@fontsource', pkg, 'files', file), path.join(out, 'fonts', file));
      fonts++;
    }
  }
}

console.log(`[intellidoc] vendor assets copied (${fonts} font files, ${OCR_LANGUAGE_CODES.length} OCR languages)`);
