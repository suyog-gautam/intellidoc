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
copy(
  path.join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  path.join(out, 'tesseract', 'lang', 'eng.traineddata.gz'),
);

// pdf.js worker plus the resources it fetches at runtime (CMaps for CJK text,
// standard fonts, WASM image decoders for JPX/JBIG2 scans, ICC profiles).
copy(path.join(nm, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'), path.join(out, 'pdfjs', 'pdf.worker.min.mjs'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = path.join(nm, 'pdfjs-dist', dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, 'pdfjs', dir), { recursive: true });
}

// Candidate fonts for typography matching (see core/typography/fontCatalog.ts).
const fontsDir = path.join(nm, '@fontsource');
let fonts = 0;
// Only the document-matching candidates. The package list is read from the
// font catalog (single source of truth); UI fonts are bundled by next/font.
const catalogSource = fs.readFileSync(path.join(root, 'core', 'typography', 'fontCatalog.ts'), 'utf8');
const CANDIDATE_PACKAGES = [...new Set([...catalogSource.matchAll(/faces\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
for (const pkg of CANDIDATE_PACKAGES) {
  fonts += copyMatching(path.join(fontsDir, pkg, 'files'), /-latin-(400|700)-normal\.woff2$/, path.join(out, 'fonts'));
}

console.log(`[intellidoc] vendor assets copied (${fonts} font files)`);
