/**
 * Vertical-slice benchmark: the first engineering proof from the brief.
 *
 *   load scan -> OCR -> document model -> analyse typography -> edit text
 *   -> remove/reconstruct -> render replacement -> compare -> export
 *
 * Usage: npm run slice [-- <image-or-pdf> ...]   (defaults to everything in the git-ignored "test files/")
 * Outputs go to output/<image>/.
 *
 * It also runs a *self-reconstruction* check: each analysed element is
 * re-rendered with its own original text. A perfect system would reproduce
 * the scan exactly, so the residual error is a direct, document-independent
 * measure of visual fidelity that we can track across algorithm changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyCommand } from '@/core/document/history';
import type { IntellidocDocument, Page, TextElement } from '@/core/document/model';
import { clampRectToBounds, expandRect, orientedBoundingRect } from '@/core/geometry';
import { createRaster, cropRaster, pasteRaster, type RasterImage } from '@/core/image/raster';
import { TesseractEngine } from '@/core/ocr/tesseractEngine';
import { chooseLanguages, HEADLINE_PROBE_LANGUAGES, MIN_HEADLINE_WORDS } from '@/core/ocr/detectLanguages';
import { cjkRegionsOfLanguages, normalizeLanguages, scriptsOfLanguages } from '@/core/ocr/languages';
import { findHeadlineWords } from '@/core/vision/headlines';
import { findHandwritingLines } from '@/core/ocr/handwritingPass';
import { applyHandwritingReadings } from '@/core/ocr/handwritingReadings';
import { prepareHandwritingLine } from '@/core/ocr/handwritingLine';
import { TrocrEngine } from '@/lib/ocr/trocr';
import * as ort from 'onnxruntime-web';
import type { FitOptions } from '@/core/typography/fit';
import { recoverMissedText } from '@/core/ocr/recovery';
import { scaleOcrResult, type OcrResult } from '@/core/ocr/types';
import { analyzeElement, clipSlotToNeighbours } from '@/core/pipeline/analyzeElement';
import { buildDocument } from '@/core/pipeline/buildDocument';
import { renderPage } from '@/core/rendering/pageRenderer';
import { ocrStrip, estimatePageSkew, estimateTextHeight, grayToRaster, normalizeIllumination, prepareOcrImage, type OcrWorkingCopy } from '@/core/vision/preprocess';
import { createNodeRasterizer, decodeImageFile, encodePng, writePng } from '@/lib/node/nodeRuntime';
import { openNodePdf } from '@/lib/node/nodePdf';

interface PlannedEdit {
  match: RegExp;
  text: string;
}

const EDITS: PlannedEdit[] = [
  { match: /^13-0\d-2024$/, text: '19-07-2026' },
  { match: /^14-0\d-2023$/, text: '21-01-2026' },
  { match: /^[A-Z]+ PIPE INDUSTRIES/, text: 'EXAMPLE TRADERS PVT. LTD.' },
  { match: /^Satisfactory/, text: 'Excellent' },
  { match: /^Hot Water Bath$/, text: 'Cold Water Tank' },
  { match: /^At Site$/, text: 'In Laboratory' },
  { match: /^CALIBRATION LOCATION$/, text: 'TEST LOCATION' },
  { match: /^15-09-2023$/, text: '01-12-2025' },
  { match: /^SCS\/\d{6}\/\d{3}$/, text: 'SCS/190726/042' },
  // Nepali letter (Devanagari print, Preeti-style font).
  { match: /^२०८०-०३-०१$/, text: '२०८१-०४-१५' },
  { match: /^चितवन$/, text: 'काठमाडौं' },
  { match: /^अजय कु.ार पाण्डेय$/, text: 'अजय कुमार शर्मा' },
  { match: /Tel\.: 078-580188$/, text: 'Bardghat, Nawalparasi, Tel.: 078-580199' },
  // Challan (printed red serial number).
  { match: /^065$/, text: '066' },
];

const SELF_CHECK_LIMIT = 25;

async function ocrWithCache(engine: TesseractEngine, bytes: Uint8Array, key: string): Promise<OcrResult> {
  const cacheFile = path.join('.scratch', 'ocr-cache', `${key}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as OcrResult;
  const result = await engine.recognize({ kind: 'bytes', bytes });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

/** Side-by-side strip: [original | edited], each crop upscaled 2x. */
function comparison(original: RasterImage, edited: RasterImage, el: TextElement): RasterImage {
  const frame = el.typography!.frame;
  const r = clampRectToBounds(expandRect(orientedBoundingRect({ ...frame, width: frame.width + frame.height * 6 }), 4), original.width, original.height);
  const a = upscale(cropRaster(original, r), 2);
  const b = upscale(cropRaster(edited, r), 2);
  const out = createRaster(a.width * 2 + 12, a.height, [255, 0, 255, 255]);
  pasteRaster(out, a, 0, 0);
  pasteRaster(out, b, a.width + 12, 0);
  return out;
}

function upscale(img: RasterImage, f: number): RasterImage {
  const out = createRaster(img.width * f, img.height * f);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / f) * img.width + Math.floor(x / f)) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

function meanAbsDiff(a: RasterImage, b: RasterImage, el: TextElement): number {
  const r = clampRectToBounds(orientedBoundingRect(el.box), a.width, a.height);
  const ca = cropRaster(a, r);
  const cb = cropRaster(b, r);
  let s = 0;
  for (let i = 0; i < ca.data.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(ca.data[i + c] - cb.data[i + c]);
  return s / Math.max(1, (ca.data.length / 4) * 3);
}

interface InputPage {
  name: string;
  original: RasterImage;
  source: { fileName: string; mimeType: string; byteSize: number; sha256: string; kind: 'image' | 'pdf'; pageCount: number };
  physical: { widthPt: number; heightPt: number };
}

/** Expand input files into page rasters: images are one page, PDFs are rendered page by page. */
async function loadInputs(file: string): Promise<InputPage[]> {
  const base = path.basename(file, path.extname(file));
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (/\.pdf$/i.test(file)) {
    const src = await openNodePdf(new Uint8Array(bytes));
    const pages: InputPage[] = [];
    try {
      for (let i = 0; i < src.pageCount; i++) {
        const t = Date.now();
        const original = await src.render(i);
        console.log(`[pdf] ${base} page ${i + 1}/${src.pageCount} rendered at ${original.width}x${original.height} in ${Date.now() - t}ms`);
        pages.push({
          name: `${base}-p${i + 1}`,
          original,
          source: { fileName: path.basename(file), mimeType: 'application/pdf', byteSize: bytes.length, sha256, kind: 'pdf', pageCount: src.pageCount },
          physical: await src.physicalSize(i),
        });
      }
    } finally {
      await src.dispose();
    }
    return pages;
  }
  const original = await decodeImageFile(file);
  return [
    {
      name: base,
      original,
      source: { fileName: path.basename(file), mimeType: 'image/jpeg', byteSize: bytes.length, sha256, kind: 'image', pageCount: 1 },
      physical: { widthPt: (original.width * 72) / 300, heightPt: (original.height * 72) / 300 },
    },
  ];
}

/** OCR models live in public/vendor (copied by postinstall), like the app serves them. */
const LANG_PATH = path.join('public', 'vendor', 'tesseract', 'lang');
const CACHE_PATH = path.join('.scratch', 'tesseract-cache');
const engines = new Map<string, TesseractEngine>();
function engineFor(languages: readonly string[]): TesseractEngine {
  const key = languages.join('+');
  let e = engines.get(key);
  if (!e) engines.set(key, (e = new TesseractEngine({ langPath: LANG_PATH, cachePath: CACHE_PATH, languages: [...languages] })));
  return e;
}

/**
 * Languages as the app chooses them: SLICE_LANGUAGES=nep,eng forces a
 * choice; otherwise "auto" runs the same detection as the browser (OSD,
 * headline words + probe, locale from SLICE_LOCALES, e.g. ne-NP).
 */
async function detectLanguages(original: RasterImage, working: OcrWorkingCopy, ocrPng: Uint8Array): Promise<string[]> {
  const { textHeight, scale } = working;
  const forced = process.env.SLICE_LANGUAGES;
  if (forced && forced !== 'auto') return normalizeLanguages(forced.split(','));
  const locales = (process.env.SLICE_LOCALES ?? 'en').split(',');
  const osd = await engineFor(['eng']).detectScript({ kind: 'bytes', bytes: ocrPng }).catch(() => undefined);
  const headlines = findHeadlineWords(original, textHeight);
  let headlineProbeText: string | undefined;
  if (headlines.words >= MIN_HEADLINE_WORDS && headlines.band) {
    // Like the app: the band gets the ideal OCR scale, whatever the page's pixel budget allowed.
    const b = headlines.band;
    const band = grayToRaster(ocrStrip(working, b.y, b.height));
    const probe = await engineFor(HEADLINE_PROBE_LANGUAGES).recognize({ kind: 'bytes', bytes: new Uint8Array(encodePng(band)) });
    headlineProbeText = probe.words.map((w) => w.text).join(' ');
    console.log(`Headline probe: ${headlineProbeText.slice(0, 120)}`);
  }
  const choice = chooseLanguages({ osd, headlineWords: headlines.words, headlineProbeText, locales });
  console.log(`Language: ${choice.languages.join('+')} via ${choice.source} (OSD ${osd ? `${osd.script} ${osd.confidence.toFixed(1)}` : 'none'}, headline words ${headlines.words}, scale ${scale})`);
  return choice.languages;
}

let trocr: TrocrEngine | undefined;

async function processImage(input: InputPage) {
  const { name, original } = input;
  const outDir = path.join('output', name);
  fs.mkdirSync(outDir, { recursive: true });
  const rasterizer = createNodeRasterizer();

  let t = Date.now();
  const skew = estimatePageSkew(original);
  // SLICE_OCR_PIXELS simulates a device budget (lib/browser/deviceProfile.ts), e.g. 10000000 for low-end phones.
  const working = prepareOcrImage(original, process.env.SLICE_OCR_PIXELS ? Number(process.env.SLICE_OCR_PIXELS) : undefined);
  const ocrInput = encodePng(grayToRaster(working.image));
  console.log(`\n=== ${name} (${original.width}x${original.height}) skew=${((skew.angle * 180) / Math.PI).toFixed(2)}° text≈${working.textHeight}px ocrScale=${working.scale} prep ${Date.now() - t}ms`);

  const languages = await detectLanguages(original, working, new Uint8Array(ocrInput));
  const engine = engineFor(languages);
  const fitContext: FitOptions = { contextScripts: scriptsOfLanguages(languages), cjkRegions: cjkRegionsOfLanguages(languages) };

  t = Date.now();
  const pageOcr = scaleOcrResult(
    await ocrWithCache(engine, new Uint8Array(ocrInput), `${createHash('sha256').update(original.data).digest('hex').slice(0, 16)}-x${working.scale}-${languages.join('+')}`),
    1 / working.scale,
  );
  const tRec = Date.now();
  const recovery = await recoverMissedText(original, normalizeIllumination(original), pageOcr, estimateTextHeight(original), (crop) =>
    engine.recognizeLine({ kind: 'bytes', bytes: new Uint8Array(encodePng(crop.image)) }),
  );
  const ocr = recovery.result;
  console.log(`OCR recovery: ${recovery.regions} regions, ${recovery.replaced} words re-read, ${recovery.added} words added (${Date.now() - tRec}ms)`);
  console.log(`OCR: ${ocr.words.length} words, conf ${ocr.confidence.toFixed(0)} in ${Date.now() - t}ms`);

  let doc: IntellidocDocument = buildDocument(input.source, [
    { sourceRef: 'page-0', physical: input.physical, width: original.width, height: original.height, skew: skew.angle, ocr, raster: original },
  ]);
  const page0 = (): Page => doc.pages[0];
  // Handwriting: re-read low-confidence fragments with the on-device handwriting model.
  const hwDir = path.join('public', 'vendor', 'models', 'trocr-small-handwritten');
  if (fs.existsSync(path.join(hwDir, 'vocab.json'))) {
    const th = Date.now();
    const groups = findHandwritingLines(original, page0().textElements);
    trocr ??= new TrocrEngine(ort, { bytes: async (f) => new Uint8Array(fs.readFileSync(path.join(hwDir, f))), json: async (f) => JSON.parse(fs.readFileSync(path.join(hwDir, f), 'utf8')) });
    const readings = [];
    for (const [i, g] of groups.entries()) {
      const line = prepareHandwritingLine(g.image);
      const r = await trocr.recognize(line);
      readings.push(r);
      writePng(path.join(outDir, `hw-${i}.png`), line);
      console.log(`  hw-${i} ${JSON.stringify(r.text)} ${r.confidence.toFixed(2)}`);
    }
    const content = applyHandwritingReadings({ textElements: page0().textElements, layout: page0().layout }, groups, readings, skew.angle, page0().id);
    doc = { ...doc, pages: [{ ...page0(), ...content }] };
    const read = page0().textElements.filter((e) => e.recognizer === 'handwriting');
    console.log(`Handwriting: ${groups.length} suspect lines, ${read.length} read in ${Date.now() - th}ms: ${read.map((e) => JSON.stringify(e.sourceText)).join(' ')}`);
  }
  fs.writeFileSync(path.join(outDir, 'elements.txt'), page0().textElements.map((e) => `${e.id}\t${e.ocrConfidence.toFixed(0)}\t${e.sourceText}`).join('\n'));
  console.log(`Document model: ${page0().textElements.length} text elements on ${page0().layout.lines.length} lines`);

  const analyse = (el: TextElement) => {
    const t0 = Date.now();
    const est = analyzeElement(original, el, rasterizer, fitContext);
    if (!est) return { ms: Date.now() - t0, ok: false };
    doc = applyCommand(doc, { type: 'setTypography', elementId: el.id, typography: clipSlotToNeighbours(est, page0(), el) });
    return { ms: Date.now() - t0, ok: true };
  };

  // 1) Planned edits.
  const edited: TextElement[] = [];
  for (const edit of EDITS) {
    const el = page0().textElements.find((e) => edit.match.test(e.sourceText) && !edited.some((x) => x.id === e.id));
    if (!el) {
      console.log(`  (no element matching ${edit.match})`);
      continue;
    }
    const { ms, ok } = analyse(el);
    if (!ok) {
      console.log(`  analysis failed for "${el.sourceText}"`);
      continue;
    }
    doc = applyCommand(doc, { type: 'setText', elementId: el.id, text: edit.text });
    const now = page0().textElements.find((e) => e.id === el.id)!;
    edited.push(now);
    const ty = now.typography!;
    const p = ty.params;
    console.log(
      `  "${el.sourceText}" -> "${edit.text}"  [${ms}ms] font=${p.fontId}/${p.weight} size=${p.fontSize.toFixed(1)} sx=${p.scaleX.toFixed(2)} ls=${p.letterSpacing.toFixed(2)} emb=${p.embolden.toFixed(2)} blur=${p.blur.toFixed(2)} skewX=${p.skewX.toFixed(2)} color=${p.color.map(Math.round).join(',')} align=${now.alignment} | err=${ty.fidelity.photometricError.toFixed(1)} IoU=${ty.fidelity.silhouetteIoU.toFixed(2)} score=${ty.fidelity.score.toFixed(2)}`,
    );
  }

  t = Date.now();
  const result = renderPage(original, page0(), rasterizer);
  console.log(`Render: ${Date.now() - t}ms, pending=${result.pending.length}, overflowing=${result.overflowing.length}`);
  writePng(path.join(outDir, 'edited.png'), result.image);
  for (const el of edited) {
    const now = page0().textElements.find((e) => e.id === el.id)!;
    writePng(path.join(outDir, `compare-${el.id}.png`), comparison(original, result.image, now));
  }

  // 2) Self-reconstruction fidelity check on confidently recognised elements.
  let selfDoc = doc;
  const candidates = page0()
    .textElements.filter((e) => e.ocrConfidence >= 85 && e.sourceText.length >= 2 && !edited.some((x) => x.id === e.id))
    .slice(0, SELF_CHECK_LIMIT);
  const errors: number[] = [];
  const scores: number[] = [];
  let totalMs = 0;
  for (const el of candidates) {
    const t0 = Date.now();
    const est = analyzeElement(original, el, rasterizer, fitContext);
    totalMs += Date.now() - t0;
    if (!est) continue;
    selfDoc = applyCommand(selfDoc, { type: 'setTypography', elementId: el.id, typography: est });
    // Same style as detected, but set explicitly: forces a full re-render (an edit that keeps the text would keep the scan's pixels).
    selfDoc = applyCommand(selfDoc, { type: 'setStyleOverrides', elementId: el.id, overrides: { color: est.params.color } });
    scores.push(est.fidelity.score);
  }
  const selfPage = selfDoc.pages[0];
  const selfRender = renderPage(original, { ...selfPage, textElements: selfPage.textElements.filter((e) => candidates.some((c) => c.id === e.id)) }, rasterizer);
  for (const el of candidates) errors.push(meanAbsDiff(original, selfRender.image, el));
  const worst = candidates.map((el, i) => ({ el, e: errors[i] })).sort((a, b) => b.e - a.e).slice(0, 3);
  for (const { el, e } of worst) {
    const ty = selfPage.textElements.find((x) => x.id === el.id)?.typography;
    console.log(`  worst: |Δ|=${e.toFixed(1)} "${el.sourceText}" font=${ty?.params.fontId}/${ty?.params.weight} size=${ty?.params.fontSize.toFixed(1)} IoU=${ty?.fidelity.silhouetteIoU.toFixed(2)}`);
  }
  writePng(path.join(outDir, 'self-reconstruction.png'), selfRender.image);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  console.log(
    `Self-reconstruction on ${candidates.length} elements: mean |Δ| = ${avg(errors).toFixed(2)} /255, mean fit score ${avg(scores).toFixed(3)}, ${(totalMs / Math.max(1, candidates.length)).toFixed(0)}ms/element`,
  );
  return { name, selfError: avg(errors), selfScore: avg(scores) };
}

async function main() {
  const args = process.argv.slice(2);
  const samples = 'test files';
  const files = args.length ? args : fs.existsSync(samples) ? fs.readdirSync(samples).filter((f) => /\.(jpe?g|png|pdf)$/i.test(f)).map((f) => path.join(samples, f)) : [];
  if (files.length === 0) {
    console.error('No inputs. Pass files (npm run slice -- scan.pdf) or put samples in the git-ignored "test files/" folder.');
    console.error('Tip: npm run fixtures builds a synthetic scanned PDF in output/fixtures/.');
    process.exit(1);
  }
  const summary = [];
  try {
    for (const f of files) for (const input of await loadInputs(f)) summary.push(await processImage(input));
  } finally {
    for (const e of engines.values()) await e.dispose();
  }
  fs.writeFileSync(path.join('output', 'benchmark.json'), JSON.stringify({ at: new Date().toISOString(), summary }, null, 2));
  console.log('\nSummary:', summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
