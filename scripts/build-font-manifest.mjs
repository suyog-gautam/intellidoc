/**
 * Generates core/typography/fontFaces.json: for every candidate font of the
 * catalogue (core/typography/fontCatalog.ts, `font('<pkg>', ...)` entries),
 * the font files fontsource ships and the unicode ranges each one covers.
 *
 * Fonts are cut into slices ("latin", "devanagari", or ~100 numbered slices
 * for Chinese/Japanese/Korean). Knowing the ranges lets the app register
 * one family per slice and download only the slices a document's text
 * needs, identically in the browser and in Node tests.
 *
 * Run after adding a font to the catalogue: `npm run fonts:manifest`.
 * The output is committed; postinstall copies exactly the files it lists.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const fontsDir = path.join(root, 'node_modules', '@fontsource');
const catalog = fs.readFileSync(path.join(root, 'core', 'typography', 'fontCatalog.ts'), 'utf8');
const packages = [...new Set([...catalog.matchAll(/^\s*font\('([a-z0-9-]+)'/gm)].map((m) => m[1]))];

const WEIGHTS = [400, 700];
const ranges = [];
const rangeIndex = new Map();
const fonts = {};

for (const pkg of packages) {
  const dir = path.join(fontsDir, pkg);
  const unicode = JSON.parse(fs.readFileSync(path.join(dir, 'unicode.json'), 'utf8'));
  const weights = WEIGHTS.filter((w) => Object.keys(unicode).some((k) => fs.existsSync(path.join(dir, 'files', `${pkg}-${k.replace(/[[\]]/g, '')}-${w}-normal.woff2`))));
  if (!weights.length) throw new Error(`${pkg}: no 400/700 woff2 files`);
  const slices = [];
  for (const [key, value] of Object.entries(unicode)) {
    const id = key.replace(/[[\]]/g, '');
    if (!weights.every((w) => fs.existsSync(path.join(dir, 'files', `${pkg}-${id}-${w}-normal.woff2`)))) continue;
    const compact = value.replace(/U\+/gi, '').toLowerCase();
    let idx = rangeIndex.get(compact);
    if (idx === undefined) {
      idx = ranges.length;
      ranges.push(compact);
      rangeIndex.set(compact, idx);
    }
    slices.push([id, idx]);
  }
  fonts[pkg] = { weights, slices };
}

const out = path.join(root, 'core', 'typography', 'fontFaces.json');
fs.writeFileSync(out, JSON.stringify({ ranges, fonts }) + '\n');
const files = Object.values(fonts).reduce((n, f) => n + f.slices.length * f.weights.length, 0);
console.log(`[intellidoc] font manifest: ${packages.length} fonts, ${files} files, ${ranges.length} distinct ranges -> ${path.relative(root, out)}`);
