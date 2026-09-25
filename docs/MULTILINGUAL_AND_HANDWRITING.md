# Languages, scripts, glyph variants and handwriting

## Languages and scripts

| Script | OCR languages | Candidate fonts |
|---|---|---|
| Latin (incl. extended: ą ő ş ž …) | English, French, German, Spanish, Portuguese, Italian, Dutch, Polish, Turkish | 22 print families + Poppins, Kalam, Caveat, Patrick Hand |
| Devanagari | Nepali, Hindi, Marathi | Noto Sans / Noto Serif Devanagari, Mukta, Hind, Yantramanav, Poppins, Tiro Devanagari Hindi, Martel, Laila, Karma, Khand, Kalam |
| Cyrillic | Russian, Ukrainian | 17 of the print families + Caveat |
| Greek | Greek | 12 of the print families |

- **Choosing languages.** The start screen has a "Document language" picker (up to 3, e.g. Nepali + English for a bilingual form). The choice is remembered in the browser. Tesseract needs the right model before it reads the page: a Nepali page read with the English model is noise, and Tesseract.js has no script detection in its LSTM-only build.
- **Models** are Tesseract `best_int` (`@tesseract.js-data/<code>`), copied to `public/vendor/tesseract/lang` by `postinstall` and served same-origin (Nepali 1.6 MB, Hindi 1.4 MB). The browser downloads only the languages picked.
- **Adding a language:** add the npm package and an entry in `core/ocr/languages.ts`. A new *script* also needs its unicode ranges in `core/text/script.ts` and fonts with that subset in `core/typography/fontCatalog.ts`.

### Fonts per script (`core/typography/fontCatalog.ts`, `core/text/script.ts`)
- Every font subset (latin, latin-ext, cyrillic, greek, devanagari) is registered as **its own CSS family** (`"IDF Mukta"`, `"IDF Mukta devanagari"`, …). A canvas font string lists them all, followed by same-style fallbacks for scripts the family lacks (`fontStack`). The canvas then picks a face per character, in the browser and in Node (@napi-rs/canvas) alike. A Devanagari word typed into an Arimo line renders in Noto Sans Devanagari instead of empty boxes.
- **Loading on demand:** a Latin-only document downloads only the Latin faces, as before. Devanagari, Cyrillic, Greek and extended-Latin faces load the first time the worker analyses or renders such text (`loadFontsForText`). A Devanagari document also loads its families for numbers, because amounts in a Nepali document are often set in the Devanagari font's digits.
- **Fitting candidates** (`candidateFonts`) are the fonts that draw every character of the text, and are meant for its scripts or the document's scripts. Devanagari families are candidates for Latin text only in Devanagari-language documents.

### Complex-script shaping
- Text is placed per **cluster** (`clusters()`: grapheme clusters, and Indic conjuncts like क्ष or त्रि kept whole), not per code point. Drawing a vowel sign or virama on its own shows a dotted circle.
- **No tracking for connected scripts.** Devanagari letters hang from a continuous headline (शिरोरेखा), and extra letter spacing would cut it. The fitter doesn't optimise `letterSpacing` for such text, and replacement layout skips the "tighten tracking" step and compresses horizontally instead.
- **Headlines aren't table rules.** A headline is a long horizontal stroke, so rule detection took it for a table line. The analysis then lost it and, worse, text removal *kept* it on the page. `keepHeadlines` (in `regionAnalysis.ts`) recognises a stroke in the upper half of the text box, within the text's extent, with glyph stems hanging from at least 20% of its length. Measured on a deleted Mukta line, the strongest leftover row darkening is 0.2 grey levels (25.7 without the check). Latin is unchanged (0.8 in both cases).
- **OCR recovery** counts combining marks (`\p{M}`, i.e. vowel signs and viramas) as text. Before, most Devanagari words failed the 60% alphanumeric plausibility test and recovered words were discarded.
- RTL scripts (Arabic, Hebrew) and CJK are not supported yet. They need bidi-aware layout and caret handling, and in CJK's case much larger fonts.

## Glyph variants (`core/typography/glyphVariants.ts`)

**Problem.** Similar fonts disagree on details. The case that triggered this work: **Arimo**, the metric-compatible stand-in for Arial and Helvetica, draws `1` with a flat foot. Arial and Helvetica don't. An Arial invoice number such as 17652 therefore came back as 17653 with a line under the 1. Carlito, Lato, Source Sans 3, PT Sans, Libre Franklin and all the serif candidates also have footed 1s. Other characters vary the same way: one- or two-storey `a` and `g`, an open or closed `4`, `l` with or without a tail.

**Mechanism.** `RenderParams.glyphFonts` maps a character to another candidate font that draws it. The rasterizer scales the donor glyph to the main font's ink height *of the same character* and centres it in the main font's advance. Fonts centre glyphs in their advance by design, while the ink box moves with the very details that differ. Layout and measurement are unchanged.

**Choice, from the scan** (after the font fit):
1. For every variant-prone character in the analysed text (digits and `agltyIJQGR`), the donors are the best-ranked other fonts of the same category.
2. A donor is considered only if its glyph is **structurally** different: more than 5% of either glyph's ink lies farther than 5.5% of the glyph size from the other's ink. Measured at 64 px: `1` with vs without foot scores 0.14–0.26, and `g` one- vs two-storey 0.06–0.10. Same-structure pairs (Roboto/Lato `2`, Carlito/Lato `1`, Tinos/PT Serif `1`) score 0.00–0.04. Without this gate, donors "won" by soaking up the fit's leftover size or weight error.
3. The native glyph and each donor get the same small local alignment (offset, size), and are compared on the pixels of that character only. A foot is a small part of a line, but a large part of a `1`. A donor must lower that error by at least 12%.
4. **No evidence in the scan** (the character isn't in the analysed text): the fitted font's `glyphDefaults` apply. Arimo's `1` defaults to a footless design, so a 1 typed into an Arial number stays footless. If the scan *shows* a footed 1 (a genuine Liberation Sans document), the evidence wins and Arimo's own glyph is kept.

The properties panel lists matched variants ("Matched to the scan: "1" from Roboto"). Choosing another font resets them to that font's defaults.

**Measured (synthetic, `tests/typography/glyphVariants.test.ts`):** Arial-style "Invoice 17652" → Arimo with a footless `1` (local error 5.29 → 2.93). A genuine Arimo scan keeps Arimo's footed `1`. Carlito, Roboto, Tinos and Lato texts get no substitutions.

## Handwriting

### What works now
- **Handwriting candidates:** Kalam (Latin + Devanagari print-style hand), Caveat (cursive, Latin + Cyrillic) and Patrick Hand (block capitals style). The fitter tries them like any other font. On synthetic handwriting they win clearly, and print never picked them in the tests.
- **Natural variation** (`RenderParams.jitter`, 0–1): per character, a small baseline offset (≤ 4.5% of the size), rotation (≤ 4°) and size change (≤ 6%). It's seeded by position and character, so preview and export match, and editing one character leaves the others exactly where they were.
- **Measured, not guessed.** When a handwriting font wins, the variation comes from the scan's **baseline wobble**: the median deviation of full-height glyph bottoms, relative to text height. Print measures ≈0.00–0.01, handwriting 0.04–0.10. Calibrated on synthetic handwriting, the recovered jitter is within ~0.05 of the drawn one for Latin hands. The panel offers Off / Subtle / Natural / Strong.
- **Ink colour** is fitted as for print, so blue ballpoint stays blue.

### Honest limits and the path forward
Handwritten invoices are two problems: *reading* them, and *writing* convincingly into them.

1. **Reading (OCR).** Tesseract is trained on print. It misreads cursive and is only moderate on neat block handwriting. Today the user corrects the text in "Original says", which feeds straight into fitting. Options, all runnable in the browser behind the existing `OcrEngine` interface:
   - **TrOCR** (Microsoft; `trocr-small-handwritten`, tens of MB as a quantised ONNX model) via transformers.js / onnxruntime-web. It reads one *line* at a time, so Tesseract's line boxes can feed it. It's English-only; Devanagari handwriting has no comparable open model yet.
   - Route only low-confidence or handwritten-looking lines to it, using OCR confidence plus the baseline wobble above as the signal, so the big model downloads only when a document needs it. The model must be vendored (no CDN) to keep the privacy guarantee. Its size means it should be an optional download with a clear prompt.
2. **Writing (replacement).** Handwriting fonts plus variation look handwritten, but not like *this writer*. The highest-fidelity approach is **glyph reuse from the same document**: cut each character the writer already wrote (connected components aligned to the OCR character boxes) and compose new text from their own strokes, falling back to the font for missing characters. This works well for digits on invoices, where most characters recur. The prerequisites are per-character OCR boxes (Tesseract symbol level) and a per-document glyph store.
3. **Cursive joins.** Connected script like Caveat gets its joins from the font. Per-character variation can open small gaps at high settings, so "Subtle" is the better choice for cursive.

A note on responsibility: tools that make edits indistinguishable from the original can be misused on invoices and official papers. IntelliDoc keeps edits reversible, and the original is never modified. A natural next step is an optional visible or metadata "edited" marker on export.
