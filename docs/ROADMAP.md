# Roadmap and status

## Phase 1: fundamental pipeline ✅ (v0.1.0)
- Image upload with validation, decoding and SHA-256 provenance
- Illumination-normalized working copy for OCR, and page skew estimation
- Tesseract.js OCR (same-origin assets, own worker) behind the `OcrEngine` interface
- Geometric line and run segmentation with noise filtering
- Document model, command history, undo/redo
- Single-page editor: select, inline edit, delete/restore, OCR correction, alignment, zoom, original/edited/side-by-side views
- Typography analysis by synthesis: 8 candidate families, optimization, fidelity metrics
- Background reconstruction: push-pull inpainting, noise resynthesis, rule preservation
- Rotation-aware rendering, PNG/JPEG export through the same renderer as the preview
- Tests: segmentation, history, inpainting, ground-truth typography, reconstruction locality and immutability
- Benchmark: `npm run slice`

## Known limitations (honest status)
- **Font choice on digit-only runs is ambiguous.** On test-2, "13-09-2024" fitted Tinos (serif) at 63%, with Arimo a close second. Short strings carry little shape evidence. A planned fix is a per-document font prior: the most likely family across many elements.
- **Faint dashed vertical rules are not always detected**, so some table cells stay left-anchored (e.g. "Hot Water Bath"). The user can set alignment manually.
- **Emboldening is used instead of the real weight** in some fits. It looks close, but it's a stand-in.
- **Analysis is lazy (~1–3 s per element in the worker).** It runs only for selected or edited elements.
- **Main-thread pauses up to ~330 ms happen during upload** (decode/copy). The plan is to move decoding into the worker.
- **Scripts not yet covered:** Odia, Sinhala, Myanmar, Khmer, Ethiopic, Georgian, Armenian (need OCR models + fonts in the catalogue). 17 writing systems are supported.
- **Vertical CJK text** (top-to-bottom columns) is not supported; horizontal CJK is.
- **Handwriting OCR relies on Tesseract**, which is weak on cursive. Correct the text in "Original says". See `docs/MULTILINGUAL_AND_HANDWRITING.md` for the TrOCR plan.
- **PDF export re-encodes each page as JPEG (quality 0.95).** This is visually lossless but not byte-identical, and a PDF's own text layer is not kept.
- **Pages rotated by 90°** (scanned sideways without a /Rotate entry) are not auto-oriented yet.
- **Very low-DPI scans (~90 DPI, 9 px text) render replacement text slightly softer than the crisp printed original.** Average darkness matches (measured: 226 vs 227 mean luminance), but the pixel-difference objective prefers soft, sub-pixel-spread glyphs over crisp stems. A coverage-contrast parameter was tried and not selected by the optimizer. Next step: an edge/structure-aware objective, or hinted rendering for small sizes.
- **OCR tokens that fuse two styles** (e.g. "No.:SCS/000000" read as one word) can't be split by style yet. That needs per-character boxes.
- **Different JPEG decoders can flip borderline OCR reads.** For example, the same scan read "13-09-2024" when decoded directly but "13-08-2024" via pdf.js. Use "Original says" to correct it.

## PDF input ✅ (v0.2.0, pulled forward from phase 3)
- Scanned and multi-page PDFs via pdf.js, rendered at the scan's native resolution
- Progressive processing: the editor opens on page 1, and other pages are read in the background
- Page navigation; per-page status (queued, reading, failed)
- PDF export of all pages with original page sizes (plus per-page PNG/JPEG)
- Memory-bounded page store in the worker
- Tests: writer round-trip, native-resolution rendering, damaged-PDF handling, upload sniffing, page store

## Editing tools ✅
- Light-on-dark text (white headings on coloured banners) detected and reconstructed with the correct polarity
- Per-element style controls: font (Auto = detected, or any of 36 bundled fonts), weight, size, ink colour; "Reset to detected"
- Add text boxes anywhere; style defaults to the nearest recognised text; drag or arrow-key to move
- Copy/Paste style (across pages) and "Match style" eyedropper
- In-context progress: tags on the text itself, a panel status line, and a floating "Updating preview…" pill

## Languages, glyph variants, handwriting ✅
- OCR in 40 languages covering the most spoken ones; Auto-detect (OSD + headline detection + locale) by default
- 17 writing systems incl. Arabic/Urdu/Persian (RTL, Nastaliq), Hebrew, Chinese, Japanese, Korean, Thai and the major Indic scripts; 85 font families loaded per character range
- Handwriting: the writer's own glyphs reused (varied instances), research-based per-instance variation, handwriting fonts for 7 scripts
- Devanagari rendering: 11 candidate families, cluster-based placement (conjuncts), no tracking across the headline, headline kept out of rule detection so it's removed with the text
- Per-script font subsets loaded on demand; same-style fallbacks for scripts a family lacks
- Glyph variants matched per character from the scan (e.g. Arial's footless `1` instead of Arimo's footed one)
- Handwriting candidate fonts and measured natural variation

## Phase 2: fidelity
- Per-document font prior; more families (Liberation, DejaVu, Noto, Georgia-like, Verdana-like); per-glyph alignment
- Edge-softness and JPEG-artefact modelling; texture-aware (patch-based) inpainting for patterned backgrounds
- Multi-scale fitting for speed; caching of candidate renders
- Visual-regression suite: store benchmark crops and fail on self-reconstruction regressions

## Phase 3: document capabilities
- PDF export that keeps unedited pages byte-identical and preserves any text layer
- IndexedDB project storage and autosave
- Tables, forms, add-new-text, move/resize elements, difference view

## Phase 4
- Alternative OCR engines (TrOCR for handwriting), ML layout, ML font matching, more scripts (Bengali, Arabic, CJK…)
- Handwriting glyph reuse: compose edits from the writer's own characters
