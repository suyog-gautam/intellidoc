# Document model

Defined in `core/document/model.ts`. Serializable (plain JSON) so it can be stored in IndexedDB and sent to workers.

- `IntellidocDocument`: schema version, `source` (file name, MIME type, size, SHA-256), `processing` (pipeline version, OCR engine, languages, timestamp) and `pages`.
- `Page`: its own pixel coordinate system (`width`, `height`), `physical` size in points (for export), `status` (`pending | processing | ready | failed`, since pages are processed progressively), page `skew`, `sourceRef` (key of the immutable original raster in the worker's page store), `textElements`, and `layout.lines`.
- `TextElement`: one editable run.
  - `sourceText` is what the scan says (OCR output, correctable by the user).
  - `text` is the desired text.
  - `state` is `original | edited | deleted`.
  - Geometry: `bbox` (axis-aligned) and `box` (oriented).
  - Also: `words`, `ocrConfidence`, `readingOrder`, `lineId`, `alignment` (+ `alignmentLocked` once the user chooses), `styleOverrides`, and `typography`.
- `TypographyEstimate`: upright analysis `frame`, `textBox`, `slot`, `inferredAlignment`, fitted `RenderParams`, ranked font `candidates`, `measured` pixel statistics, `fidelity` metrics, `confidence` and `analyzerVersion`.
- `RenderParams` may carry `glyphFonts` (per-character glyph variants matched to the scan, e.g. a footless `1`) and `jitter` (natural variation for handwriting, 0–1). Both are optional, so older models stay valid. See `docs/MULTILINGUAL_AND_HANDWRITING.md`.

## Style and user text
- `TextElement.origin` is `'ocr'` (recognised, the default) or `'added'` (a user text box). Added boxes are never "removed" from the scan; they are rendered on top, in a style copied from a recognised element (`core/document/addedText.ts`).
- `styleOverrides` holds user-chosen style (font, weight, size, ink colour…) on top of the detected `typography.params`. An absent key means "Auto: as detected". `styleSourceId` records which element a copied or matched style came from.
- `TypographyEstimate.polarity` is `'dark'` (dark ink on light paper) or `'light'` (light text on a dark background, e.g. banner headings).
- Switching font without choosing a size keeps the cap height (`resolveParams` in `core/typography/styleTransfer.ts`).

## Edits
All user changes are `EditCommand`s (including `applyStyle`, `addElement` and `moveElement`) applied by the pure `applyCommand`, with undo/redo via `History`. Correcting `sourceText` clears the typography, because the fit used the wrong glyphs. Analysis results (`setTypography`) and background page processing (`updatePage`) are applied with `replacePresent`, so they don't create undo steps, and they're propagated into past and future states.

## Invariants
- The original raster is never stored in or mutated through the model.
- The output is a pure function: `renderPage(original, page)`.
