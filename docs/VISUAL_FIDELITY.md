# Visual fidelity engine

## Principle: analysis by synthesis
A scan contains pixels, not fonts. We don't try to *name* the font. We look for rendering parameters whose output is closest to the real pixels, and every step is measured.

## Layout-time style measurement (`core/layout/wordStyle.ts`)
Before typography fitting, every OCR word is measured from pixels:
- **Tight box.** Ink components within the word's span, with ruling lines and flat fragments outside the cap-line/baseline band removed. OCR boxes often swallow table rules.
- **Stroke weight** = 2·Σcoverage / Σ|∇coverage|. This is sub-pixel accurate, so it works on anti-aliased, low-DPI text where thresholded strokes are only 1–2 px.
- **Ink colour and glyph height.**

Weight classes are learned per page: stroke is normalised by body-text height, then split in two with Otsu. This is used only if the distribution is clearly bimodal, and words near the threshold stay unclassified. A run is split when a word is confidently in the other class *and* its stroke differs visibly from the group, when glyph size changes by ≥1.6×, or when ink colour changes. On test-3, bold words measure 1.8–2.2 px and regular ones 1.4–1.5 px.

## Region analysis (`core/typography/regionAnalysis.ts`)
- **Rotation.** The element is resampled into an upright frame (page skew, refined locally by projection profiles for long runs).
- **Ink detection.** Sauvola adaptive thresholding handles uneven lighting. Solid ruling lines are removed with long-run detection.
- **Component selection.** Components mostly inside the OCR box are kept. A two-pass *band filter* then drops flat fragments above or below the cap/baseline band (dashed table rules) while keeping hyphens and punctuation.
- **Paper estimate.** Push-pull inpainting of every non-ink pixel gives the paper colour and gradient *under* the glyphs, plus a residual noise model.
- **Slot.** Vertical rules left and right bound how far replacement text may grow and let us infer centred or right-aligned table cells.

## Fitting (`core/typography/fit.ts`)
1. **Initial parameters.** For each candidate face (8 families × regular/bold), the OCR text is rendered at 100 px and measured with *the same* `measureInk` as the scan. Size, horizontal scale, origin and emboldening are then solved from the ratios, so measurement biases cancel.
2. **Scoring.** The scan is predicted as `P = B·(1−α) + I·α`: B is the paper estimate, α is the blurred coverage, and the ink colour I is solved in closed form by least squares. Cost is the mean |O − P| with a mild penalty for distortion.
3. **Refinement.** The top 3 candidates go through coordinate descent over origin, baseline, size, scaleX, letter spacing, emboldening, blur and slant, with step halving.
4. **Reported metrics.** Photometric error, silhouette IoU, width/height/stroke ratios, and a combined score and confidence.

## Replacement layout (`layoutReplacement.ts`)
The replacement keeps the anchor (left, centre or right). If it doesn't fit the slot, the least visible adjustment is tried first: tracking (up to −3% em), then width (up to −12%), then size (up to −20%). Shorter text is never stretched.

## Reconstruction (`core/reconstruction`)
- Only glyph pixels plus an anti-aliasing halo are replaced. Rules and neighbouring content stay original.
- Fill: push-pull pyramid interpolation from clean paper, excluding all ink so neighbouring text doesn't bleed into the fill.
- Texture: residuals sampled from the same paper are re-applied (deterministic seed), and the ink gets matching grain.

## Measuring
`npm run slice` reports per-edit fit parameters and scores, and a **self-reconstruction** error: each element is re-rendered with its own text, and the mean |Δ| over its box is measured against the scan. Lower is better. Track it whenever the algorithms change.

Baseline (v0.1.0, first 25 confident elements per page):

| Image | Self-reconstruction mean abs. error (0–255) | Mean fit score |
|---|---|---|
| test-1 | 12.3 | 0.68 |
| test-2 (rotated −2.75°) | 10.3 | 0.68 |

Synthetic ground truth (`tests/typography/fit.test.ts`): font category, size within 8%, ink colour within 25 levels, and self-reconstruction error < 6 on synthetic paper.
