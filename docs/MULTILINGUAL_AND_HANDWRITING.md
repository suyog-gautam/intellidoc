# Languages, scripts, glyph variants and handwriting

## Languages: 40, detected automatically

OCR covers 40 languages, which together include the world's most spoken ones:
- English, Chinese (Simplified and Traditional), Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian, Urdu
- Indonesian, German, Japanese, Marathi, Telugu, Turkish, Tamil, Vietnamese, Korean, Italian
- Persian, Thai, Gujarati, Punjabi, Kannada, Malayalam, Nepali, Polish, Ukrainian, Malay
- Swahili, Filipino, Dutch, Romanian, Greek, Czech, Hungarian, Swedish, Hebrew

The models are Tesseract `best_int` (`@tesseract.js-data/<code>`), served same-origin from `public/vendor/tesseract/lang`. A browser downloads only the ones a document needs.

### "Auto-detect" (the default)
The start screen's language picker defaults to **Auto-detect**. It works out the original document's script, then its language, on page 1 (`core/ocr/detectLanguages.ts`):

1. **Script detection (OSD).** Tesseract's orientation and script detection runs on its legacy engine with the `osd` model, in a separate worker. That's about 9 MB, downloaded once and only in Auto mode. Measured on synthetic pages, OSD named the script correctly for Latin (confidence 13), Cyrillic (8), Arabic (73), Thai (30), Chinese (1.4), Japanese (1.6) and Korean (1.6), with no wrong answers.
2. **Headline scripts.** OSD counts separate characters, but Devanagari, Bengali and Gurmukhi words are joined by a headline into one blob, so it gives up ("too few characters"). `core/vision/headlines.ts` finds such words geometrically instead: a thin stroke across the top of a word with glyph stems hanging from it. It found 8–13 on each headline page and 0 on Latin, Chinese, Arabic, Thai and table pages. A band of those lines is then read with the Hindi + Bengali + Punjabi models at once, and the script of the returned characters decides.
3. **Language within the script** comes from the browser's languages. For example, Devanagari is read as Nepali for an `ne` locale and as Hindi otherwise; Han is read as Traditional Chinese for `zh-TW`/`zh-HK`. English is added as a second language for non-Latin documents, which almost always contain names, codes and amounts in Latin.
4. **Unsure detection** falls back to the browser's language plus English.

The editor header shows what was chosen ("Detected: नेपाली + English"). Picking languages by hand (up to 3) skips detection.

**Measured end to end in Chromium**, uploading with Auto: a Nepali/English invoice was read as नेपाली + English, a Chinese VAT invoice as 简体中文 + English, an Arabic invoice as العربية + English, and a Bengali invoice as বাংলা + English. The editor opened in about 4 s each.

### Reading order and spacing
- **Right-to-left lines** (Arabic, Urdu, Persian, Hebrew) are assembled from the rightmost word. For example, "رقم الفاتورة 17652", not "17652 الفاتورة رقم".
- **Chinese, Japanese and Thai** don't separate words with spaces, so Tesseract's word breaks in them aren't turned into spaces ("开票日期2024年9月14日").
- Tesseract's CJK boxes overlap and nest. The box for "增值" can span the whole heading and contain "税". Line grouping therefore compares box centres and accepts nested boxes. Style splitting also ignores CJK characters, whose ink density depends on the character (月 vs 票), not the weight.

## Fonts: 85 families, downloaded per character range

| Script | Candidate families |
|---|---|
| Latin, Cyrillic, Greek | 22 print families (metric-compatible stand-ins for Arial, Times, Courier, Calibri, Cambria, Georgia…), Poppins, Rubik |
| Devanagari | Noto Sans/Serif Devanagari, Mukta, Hind, Yantramanav, Poppins, Tiro Devanagari Hindi, Martel, Laila, Karma, Khand |
| Arabic, Urdu, Persian | Noto Naskh Arabic, Noto Sans Arabic, Amiri, Cairo, Vazirmatn, Noto Nastaliq Urdu |
| Hebrew | Noto Sans/Serif Hebrew, Frank Ruhl Libre, Rubik; plus Arimo, Tinos and Cousine |
| Bengali, Gurmukhi, Gujarati, Tamil, Telugu, Kannada, Malayalam | Noto Sans + Noto Serif for each, plus Hind Siliguri, Mukta Mahee, Hind Vadodara, Mukta Malar, Hind Guntur, Baloo Tamma 2, Manjari |
| Thai | Noto Sans/Serif Thai, Sarabun (Thai government standard), Kanit |
| Chinese, Japanese, Korean | Noto Sans/Serif SC, Noto Sans TC, Noto Sans/Serif JP, Noto Sans/Serif KR |
| Handwriting | Caveat, Patrick Hand, Indie Flower, Reenie Beanie (Latin); Kalam (Latin + Devanagari); Aref Ruqaa (Arabic Ruqʿah, the everyday hand); Sriracha (Thai); Ma Shan Zheng (Chinese); Klee One (Japanese); Nanum Pen Script (Korean) |

- **Manifest.** `scripts/build-font-manifest.mjs` (`npm run fonts:manifest`) reads each fontsource package's `unicode.json` and writes `core/typography/fontFaces.json`. It lists every file slice (e.g. "latin", "arabic", or about 100 numbered slices for each CJK font) with its unicode ranges. `postinstall` copies exactly those files.
- **One family per slice.** For a given text, the font string lists only the slices it needs, followed by same-style fallbacks for characters the family lacks (`fontStack`, `facesFor`). The browser downloads just those files, so a page of Chinese loads a few of Noto Sans SC's ~100 slices (≈35 KB each). Node tests register the same files on demand, because @napi-rs/canvas can't choose between files that share a family name, and render identically.
- **Candidates** (`candidateFonts`) are fonts that draw every character and are meant for the text's scripts or the document's. Han characters also follow the document's region (骨 is drawn differently in Chinese and Japanese).
- **Measured** (synthetic, 34 px, one line per script): the fitter identified the exact font for **18 of 18 scripts**: Arabic, Urdu Nastaliq, Persian, Chinese sans/serif, Japanese, Korean, Thai, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam, Hebrew, Vietnamese and Russian. Silhouette IoU was 0.65–0.89. The Latin benchmark is unchanged by the 63 new fonts: 97.3% top-1, fidelity 0.883, size error 3.28%.

### Script-specific rendering rules
- **Clusters, not code points.** Glyphs are placed per grapheme cluster and Indic conjunct (क्ष, त्रि), and Thai marks stay on their consonant.
- **Joined and right-to-left text is drawn as one shaped run.** This covers Arabic (cursive joins) and any RTL line (visual order ≠ logical order). The canvas does bidi and shaping; letter spacing and per-glyph substitution are not applied.
- **No tracking for connected scripts** (Devanagari, Bengali, Gurmukhi headlines, Arabic joins). The fitter doesn't optimise letter spacing, and long replacements are compressed horizontally instead.
- **Headlines aren't table rules.** A Devanagari/Bengali headline looks like a rule. The check in `regionAnalysis.ts` keeps it with the text, so it's removed with it. Leftover row darkening after deleting a Mukta line is 0.2 levels, against 25.7 without the check.
- **Tall scripts.** Nastaliq climbs about 2 em above the baseline, and its ink "baseline" sits below the font's. The fitter's reference render has room for that and carries a substantial baseline offset into the starting point, so Urdu goes from IoU 0.00 to 0.83. The compositor reserves the same headroom.
- **Faint hairlines** of high-contrast designs (Song/Ming and Mincho serifs) are erased along with the text. Removal adds faint ink near confirmed strokes. After deleting 中华人民共和国 in Noto Serif SC, the worst leftover column darkening drops from 4.5 to 1.3 levels.
- **OCR recovery** counts combining marks (vowel signs, viramas) as text.

## Minimal edits: unchanged characters keep the scan (`core/rendering/partialEdit.ts`)

The best rendering of a character that didn't change is the scan itself. An edit is planned before anything is erased:
- The common prefix and suffix (in clusters) are kept as original pixels when they stay in the same place. That means the same origin, no refitting of size or spacing, and no user style change.
- Only the changed middle is erased and rendered. The erase is cut at the thinnest ink column near each boundary, and the kept glyphs' strokes are protected.
- A cut never splits a joined word (Devanagari headline, Arabic joins). Digits and punctuation stand alone even in Devanagari, so "२०८०-०३-०१" → "२०८१-०४-१५" keeps "२०८" as scanned.

This matters most where no stand-in font matches. On a real Nepali letter set in a Preeti-style font (the best open design reaches silhouette IoU ≈ 0.6–0.7), changing "078-580188" to "078-580199" redraws two digits, and "अजय कुमार पाण्डेय" → "अजय कुमार शर्मा" leaves the first word untouched. It also makes the footed-"1" problem moot whenever the 1 itself isn't edited.

## Real documents (test files)

Measured with `npm run slice`, `SLICE_LOCALES=ne-NP`, on three phone photos and scans of Nepali business papers:

| Document | Auto language | OCR | Notes |
|---|---|---|---|
| Printed letter (Devanagari, Preeti-style + Latin footer) | नेपाली + English (headline, 44 words) | 82 words, conf 88 | Body text read almost perfectly; edits of date, place, name, phone rendered with minimal changes |
| Challan (printed form, handwritten entries, photo) | नेपाली + English (headline probe + locale) | printed labels by Tesseract; **handwritten entries by TrOCR** | Red serial "065" → "066" matches the ink. Handwriting model read "Rival Bag House", "Panda No 3", "208310610", "90001", "201", "45" (Tesseract: fragments like "Va m .") |
| Ledger (printed form, handwritten entries, photo) | नेपाली + English (headline, 8 words) | printed headers by Tesseract; 20 of 99 suspect lines read by TrOCR | Amounts read well ("100 000", "428151", "5283"); cursive words partly wrong ("I Are Change care"), so they are flagged for checking |

The challan photo gave a noisy headline probe (a mix of Devanagari, Bengali and Gurmukhi characters). When no headline script clearly wins (< 60%), the browser's language decides between the plausible ones.

## Glyph variants (the "1" with a foot)

**Problem.** Arimo, the metric-compatible stand-in for Arial and Helvetica, draws `1` with a flat foot, which Arial and Helvetica don't have. So an Arial "17652" edited to "17653" grew a line under the 1.

**Fix.** `RenderParams.glyphFonts` draws chosen characters from another candidate font, scaled to the same ink height and centred in the same advance. The fitter (`glyphVariants.ts`) compares each variant-prone character (digits and `agltyIJQGR`) against *structurally* different designs. "Structurally different" means one design has parts the other lacks, like a foot or a second storey (0.14–0.26 vs ≤ 0.04 for same-structure pairs). Each contender gets a local alignment, and the comparison uses only that character's pixels. If the character isn't in the scanned text, the stand-in's `glyphDefaults` apply: Arimo's `1` → footless.

**Result (synthetic).** An Arial-style scan keeps its footless `1`. A genuine Arimo/Liberation scan keeps the footed one. Carlito, Roboto, Tinos and Lato texts get no substitutions.

## Handwriting

Handwriting is never consistent: the same person writes the same letter differently every time. The handwriting-synthesis literature models this in two parts, and IntelliDoc implements both (see *Style-preserving English handwriting synthesis*, Lin & Wan 2007; *Generating synthetic handwriting using n-gram letter glyphs*, Dey et al.; *Handwriting synthesis from public fonts*, Balreira & Walter 2017):

### 1. Reuse the writer's own characters (`writerGlyphs.ts`)
The best way to write "in someone's hand" is to reuse glyphs they wrote.
- **Harvesting.** When a handwriting font wins the fit, each character the writer wrote is cut out of the scan as an ink-coverage bitmap. The bitmap is solved against the reconstructed paper and the fitted ink colour, so it carries their pen, pressure and the scanner's optics.
- **Segmentation follows the ink, not a font.** Components become glyph blobs: parts of one letter merge ("i" and its dot, "="), and specks attach to their neighbour. Blobs are assigned to words.
  - Touching letters ("25" written in one stroke) are split at their thinnest column, using projection-profile segmentation.
  - Broken strokes are merged.
  - A word is used only when its blob count matches its letter count. Joined cursive and joined scripts (Devanagari, Arabic) are therefore skipped rather than cut wrongly.
- **Rendering.** Edited text draws each character from these samples when available, choosing among up to 4 real instances. It never uses the same instance twice in a row, so repeated letters don't look stamped. Characters the writer hasn't written yet fall back to the matched handwriting font.
- The samples travel with the style, so an added text box that matches this handwriting writes with the same hand.

### 2. Per-instance variation (`core/rendering/handwriting.ts`)
Font glyphs (and the fallback characters above) get a smooth deformation that combines the effects the research identifies:
- baseline drift over several letters;
- local slant and size changes about one letter long;
- elastic shape distortion below letter scale (Simard-style displacement fields), so two "a"s are two different shapes;
- pen pressure: strokes thicken and thin, ink gets darker and lighter.

It is applied as one continuous field over the rendered coverage rather than per letter. Joined Arabic and Devanagari therefore stay joined, right-to-left needs no special case, and it works for every script. It's deterministic and anchored to the element, so preview equals export and editing one character leaves the others exactly as they were (tested).

**Amount.** The amount is measured from the scan's baseline wobble and calibrated per script: 0.055 per unit of variation for Latin hands, 0.10 for headline scripts, whose words are single components. Recovery is within about 0.05 of the drawn value, and automatic values are capped at 0.85. The panel offers Off / Subtle / Natural / Strong.

### 3. Reading handwriting: TrOCR on-device (`lib/ocr/trocr.ts`, `core/ocr/handwritingPass.ts`)
Tesseract is trained on print and breaks handwriting into fragments. After a page is read, a background pass re-reads the handwritten lines with Microsoft's TrOCR (small, trained on handwritten English lines; Xenova's quantized ONNX export) on ONNX Runtime Web (WASM, one thread, its own worker).

- **Finding the lines** (reconstruction worker). Handwriting is found from the ink, not from Tesseract's boxes. The page is flattened and binarized (Sauvola). Components are filtered:
  - dots, filled blobs (stamps, logos) and table rules are dropped;
  - ink that Tesseract read confidently is dropped;
  - Devanagari-style headline words are dropped.

  The rest is grouped into lines, and a table rule between two components keeps table cells apart. Lines on dark background (photo edges), thick ornaments and lines mostly covered by confident text are skipped.
- **Crops.** Each crop holds only the line's own ink on white: neighbouring print and form rules are removed. It is contrast-stretched and padded as the model saw its training lines (IAM).
- **Decoding.** Greedy decoding, plus a second pass limited to digits and number punctuation. The English model prefers words ("good" for a handwritten "9000"), while forms are mostly edited for amounts and dates. The digit reading wins when the model finds it at least half as likely as the free reading. That held for every handwritten number measured; for words the ratio was ≤ 0.07.
- **Acceptance.** Recognisers hallucinate on junk. A reading is used only if all of these hold:
  - it is plausible: no word repeated three times, not one repeated letter, and no more characters than the line's width can hold;
  - it is confident enough: numbers ≥ 0.25, words ≥ 0.45, short words ≥ 0.6;
  - it is not one or two letters;
  - it would not replace text the page OCR read in a non-Latin script.

  Accepted readings replace the line's fragments with one element, or add an element for text Tesseract missed (e.g. a phone number on the Nepali letter). The element is marked "Read by the handwriting model. Please check it.", and its confidence is capped at 75% so it shows as "check".
- **No undo step, no overwriting.** The readings arrive as a `readHandwriting` command applied with `replacePresent`. Lines the user edited in the meantime are left alone.
- **Manual.** For any doubtful element (< 85%), the panel offers *Read as handwriting*. The reading goes through `setSourceText`, which can be undone.
- **Cost.** 64 MB of model plus 14 MB of runtime, served same-origin from `public/vendor` and fetched at install time from Hugging Face. The model is pinned to a revision and checked by SHA-256 (`scripts/fetch-handwriting-model.mjs`). They are downloaded only when a Latin-script document is opened. Reading takes about 1 s per line on one CPU thread and runs only after the page is editable; at most 40 lines per page are read.
- **Licence.** TrOCR's code is MIT (microsoft/unilm). The model card states no licence, so check it before commercial use. Offline installs skip the model, and the app then simply doesn't offer handwriting reading.

### Limits
- **Handwriting in other scripts.** TrOCR here reads English (Latin letters and digits). No open, browser-sized handwriting model for Devanagari or most other scripts exists yet, so Tesseract's reading stays and "Original says" is the fix. The pass is designed so a per-script model can slot in (`TrocrEngine` takes any VisionEncoderDecoder export with the same inputs).
- **Cursive words** are read less reliably than numbers and block letters (see the ledger). Readings are flagged for checking, never silently trusted.
- **Cursive** words can't be cut into letters reliably, so they use the font plus variation. Glyph reuse works best on digits and printed handwriting, which is what forms and invoices mostly contain.

A note on responsibility: making edits indistinguishable from the original can be misused on invoices and official papers. IntelliDoc keeps edits reversible and never modifies the original. A visible or metadata "edited" marker on export would be a sensible addition.
