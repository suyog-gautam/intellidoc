# IntelliDoc — working notes for Claude

Client-side scanned-document editor: change text in a scan while preserving its visual appearance.
Full product brief: `reuirement.txt` (treat as the PRD). Architecture: `docs/ARCHITECTURE.md`.

## Commands
- `npm run dev` / `npm run build` / `npm start` — Next.js app (Turbopack)
- `npm test` — Vitest unit + ground-truth tests (Node, uses @napi-rs/canvas)
- `npm run fixtures` — builds `output/fixtures/scanned-2page.pdf` from the test images
- `npm run build:pages` — static export for GitHub Pages (deployed by `.github/workflows/deploy-pages.yml` on push to main; base path from `NEXT_PUBLIC_BASE_PATH`). All asset URLs must go through `vendorUrl()` in `lib/browser/paths.ts`.
- `npm run slice [-- file.pdf|file.jpg]` — vertical-slice benchmark on the git-ignored `test files/*` (never commit real documents) (images and PDFs, every page); writes `output/<name>/` (compare-*.png, edited.png, self-reconstruction.png) and `output/benchmark.json`. Run it before/after any change to vision/typography/reconstruction and compare the self-reconstruction error.
- `npm run typecheck`
- Node is 20.16 on this machine: Vitest is pinned to v3 (v4+ needs Node 22). pdf.js 6 runs in Node via its legacy build plus `lib/node/polyfills.ts` (`Promise.withResolvers`).

## UI rules
- Visual design follows `docs/Design.md` (Focus Utility tokens), mapped onto shadcn/ui variables in `app/globals.css`. Use shadcn components (`components/ui/*`, Radix-based) and theme classes (`bg-canvas`, `text-brand`, `bg-ok-light`…), not raw hex values.
- Design.md fonts (Inter, JetBrains Mono for numbers via `type-num`) are for the app's own UI only. Never use them for document content; replacement text uses the matched candidate fonts (`core/typography/fontCatalog.ts`).
- Web-first responsive: desktop = thumbnail rail + canvas + right panel; `md` = canvas + panel; phones = canvas + non-modal bottom sheet. The toolbar must never scroll horizontally (the page canvas may).
- Keep the start page light: editor, session (OCR/PDF) and worker are loaded on demand (`components/IntelliDocApp.tsx`). Editor-only libraries (tooltips etc.) belong inside the editor tree.

## Rules
- `core/` is environment-neutral TypeScript: no DOM, no React, no Node APIs. It works on `RasterImage` (RGBA8) and receives canvases through `CanvasFactory` / `TextRasterizer`.
- The document model (`core/document/model.ts`) is the source of truth. All user edits go through `EditCommand`s (`core/document/history.ts`); analysis results use `replacePresent` so they are not undo steps.
- Never mutate the original raster. Rendering is `renderPage(original, page)` → new raster; preview and export share it.
- Heavy work runs in `workers/reconstruction.worker.ts`; OCR runs in Tesseract.js's own worker. Don't add heavy work to React components.
- Never hard-code coordinates or tune for one sample document. Validate on both test images plus the synthetic ground-truth tests.
- Measure, don't eyeball: any fidelity change should report the `npm run slice` numbers.
- Assets (fonts, OCR model, WASM) are copied to `public/vendor` by `postinstall`; never load them from a CDN (privacy).
