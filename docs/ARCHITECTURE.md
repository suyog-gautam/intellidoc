# Architecture

```
original file ──► validate ──► PageSource (image | pdf.js) ──► RasterImage per page (immutable original)
                                           │
                    ┌──────────────────────┴───────────────────────┐
             reconstruction worker                              main thread
   preprocess (illumination, skew) ──► OCR image ──► Tesseract.js (own worker)
                                                                  │
                                           segmentWords ──► buildDocument ──► Document model
                                                                                 │ EditCommands (undo/redo)
   analyzeElement (region analysis + typography fit) ◄──── on select / on edit ──┤
   renderPage(original, page) ──► output raster ──► canvas preview / PNG / JPEG export
```

## Modules

| Path | Responsibility | Replaceable by |
|---|---|---|
| `core/document` | Model types, pure edit commands, history | – (source of truth) |
| `core/ocr` | `OcrEngine` interface; `TesseractEngine` adapter (incl. OSD script detection); 40-language catalogue; Auto language choice (`detectLanguages.ts`) | Any browser OCR engine |
| `core/ocr/recovery.ts` | Second OCR pass: re-reads low-confidence words and finds text the page pass missed (e.g. values in table cells) as clean single-line crops; merges only credible improvements | – |
| `core/layout` | Pixel-measured word styles (tight boxes, stroke weight, ink colour, glyph height); word → line → run grouping; style-aware run splitting; noise filtering; reading order | ML layout model |
| `core/vision` | Sauvola binarization, components, rule detection, skew, rotated sampling, illumination | OpenCV.js / WASM kernels |
| `core/text` | Scripts (17 writing systems), direction, cluster segmentation (Indic conjuncts, Thai marks) | – |
| `core/typography` | Ink metrics, region analysis, candidate fitting, glyph variants, writer-glyph harvesting, replacement layout, font catalogue (85 open families across 17 scripts incl. metric-compatible stand-ins for Arial, Times, Courier, Calibri, Cambria, Georgia, and 11 handwriting styles) and the generated font manifest (`fontFaces.json`) | ML font matcher |
| `core/reconstruction` | Push-pull inpainting, noise model, text removal | Patch-based / learned inpainting |
| `core/rendering` | `TextRasterizer` (canvas), compositor, `renderPage` | WebGL renderer |
| `core/pipeline` | Orchestration of the above per element/document | – |
| `workers/` | Reconstruction worker + message protocol | – |
| `core/export` | Dependency-free PDF writer (JPEG pages, original page sizes) | Full PDF engine (text layer) |
| `lib/pdf` | `PageSource` abstraction; pdf.js input with native-resolution detection | Other PDF renderers |
| `lib/session` | `DocumentSession`: page 1 first, remaining pages rendered + OCR'd in the background | – |
| `workers/pageStore.ts` | Memory-bounded store of original rasters (LRU pages packed losslessly to PNG) | IndexedDB-backed store |
| `lib/` (other) | Browser/Node adapters: upload validation, fonts, export, worker client | – |
| `components/` | React UI (upload, editor, toolbar, properties) | – |

`core/` never touches the DOM or Node. Canvas access goes through `CanvasFactory`, so the same code runs in the worker (OffscreenCanvas), on the main thread, and in Node tests (@napi-rs/canvas).

## UI and load strategy
- **Design system:** `docs/Design.md` tokens are mapped to the shadcn/ui contract (`app/globals.css`), with Radix-based components in `components/ui`. The UI fonts, Inter and JetBrains Mono, are self-hosted via `next/font/local` (no third-party requests).
- **Layouts:** thumbnail rail (lazy JPEG thumbnails from the worker) + canvas + properties panel on `lg`; canvas + panel on `md`; canvas + non-modal bottom sheet on phones.
- **Start page:** only the start screen code ships up front. The first visit transfers about 245 KB, and repeat visits about 1 KB.
- **Deferred until needed:** the editor UI, the document session (tesseract.js, pdf.js) and the processing worker load on demand. They're prefetched when the user hovers or focuses the upload card, or drags a file over it.
- **Candidate fonts:** 85 families, cut into ~2,500 file slices by unicode range (one CSS family per slice, listed in `core/typography/fontFaces.json`). The worker loads only the slices of the candidate fonts and characters at hand, e.g. a few of a CJK font's ~100 slices. `/vendor/*` is served with long cache lifetimes. See `docs/MULTILINGUAL_AND_HANDWRITING.md`.
- **OCR languages:** Auto-detect by default (OSD script detection + headline detection + browser locale), or up to 3 picked on the start screen. Only the needed Tesseract models download.
- **Static site size:** `public/vendor` is ~165 MB (fonts ~62 MB, OCR models and engines ~96 MB); a visitor downloads only what their document needs.

## Rendering layers

1. The original raster, which is never mutated.
2. Removal and reconstruction of edited elements (pass 1 over all edits).
3. Replacement text (pass 2, so one reconstruction can't erase another element's new text).
4. The editor-only DOM overlay (boxes, inline editor, confidence colours). This is not part of the raster, so it can't reach an export.

## PDF input
- pdf.js parses in its own worker. Scripting and XFA are disabled, system fonts are not used, and all resources (CMaps, standard fonts, WASM decoders for JBIG2/JPX, ICC profiles) are served from `public/vendor/pdfjs`.
- The render scale per page comes from the page's drawing operations: the largest image covering at least 25% of the page sets pixels per point. Output is clamped to 150–600 DPI and 16 MP per page. Pages without images use 300 DPI.
- Limits: 50 pages and 50 MB. Password-protected or damaged files get a clear message.
- Each page keeps its physical size in points, so PDF export reproduces the original page sizes.

## Privacy and security
- No network traffic carries document content. The OCR model, WASM and fonts are same-origin (`public/vendor`), and the CSP in `next.config.ts` restricts connections to `'self'`.
- Uploads are validated by magic bytes and size, and decoding is bounded to 60 MP. Metadata is never rendered as HTML.
