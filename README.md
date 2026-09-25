# IntelliDoc

Edit the text inside scanned documents while keeping the original look: font, size, weight, ink colour, blur, rotation, paper texture.
Everything runs in the browser: the document never leaves the device.

## Quick start

```bash
npm install        # also copies OCR model, WASM and fonts into public/vendor
npm run dev        # http://localhost:3000
npm test           # unit + ground-truth tests
npm run fixtures   # build a 2-page scanned PDF (synthetic, or from "test files/") -> output/fixtures/
npm run slice -- output/fixtures/scanned-2page.pdf   # benchmark any image/PDF -> output/
```

Leave the document language on Auto-detect (or pick up to 3 of 40 languages: English, Chinese, Hindi, Spanish, Arabic, Bengali, Nepali, Japanese…), then upload a scanned PDF (multi-page) or a PNG/JPEG/WebP scan. Click a text box, then double-click (or press Enter) to edit it in place. Export the whole document as a PDF, or the current page as PNG or JPEG.

Multi-page PDFs open as soon as page 1 is ready; the remaining pages are read in the background.

## Deployment (GitHub Pages)

Every push to `main` runs `.github/workflows/deploy-pages.yml`: install → type-check → unit tests → static build → deploy to GitHub Pages. The site is fully static, since all processing happens in the visitor's browser.

```bash
npm run build:pages                                   # static site in out/ (served at the domain root)
NEXT_PUBLIC_BASE_PATH=/intellidoc npm run build:pages # as served under https://<user>.github.io/intellidoc/
```

Sample documents belong in the git-ignored `test files/` folder and are never committed. Tests use generated scans.

## How it works (short)

1. **Validate and decode.** Check magic bytes and size limits, and hash the file for provenance. PDFs are rendered with pdf.js at the *native resolution of the embedded scan*, so no resampling blur is introduced.
2. **Preprocess a working copy:** flatten the illumination and estimate page skew. The original is never modified.
3. **OCR** with Tesseract.js in a worker. Low-DPI pages (text under 12 px) are upscaled for OCR only. Each word's box is then tightened to its real ink and its style measured (stroke weight, colour, size). Words are regrouped into lines and editable runs, and a run is split wherever the style changes, so a bold label and a regular value on one line become separate elements with their own typography.
4. **Analyse typography by synthesis** for each edited element: candidate fonts for the text's script are rendered, the scan is predicted as `paper·(1−α) + ink·α`, and size, scale, position, spacing, weight, slant and blur are optimized against the real pixels. Characters whose design differs between fonts (a `1` with or without a foot, one- or two-storey `g`) are then matched individually, and handwriting gets its measured natural variation.
5. **Reconstruct:** glyph pixels are removed (ruling lines are kept), the paper is inpainted with push-pull interpolation, and the scan's grain is restored.
6. **Render** the replacement with the fitted parameters, rotated back into place.

See `docs/` for details (`docs/MULTILINGUAL_AND_HANDWRITING.md` for scripts, glyph variants and handwriting) and `docs/ROADMAP.md` for current status and known limitations.
