import { toLocal, toPage, orientedBoundingRect, clampRectToBounds, type OrientedBox } from '../geometry';
import { createRaster, sampleBilinear, sampleGrayBilinear, type GrayImage, type RasterImage } from '../image/raster';

/**
 * Resample the (possibly rotated) region `box` of `img` into an upright raster
 * of size round(width) x round(height). Local pixel (u, v) corresponds to the
 * page point toPage(box, u + 0.5, v + 0.5).
 */
export function extractUpright(img: RasterImage, box: OrientedBox): RasterImage {
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const exact: OrientedBox = { ...box, width: w, height: h };
  const out = createRaster(w, h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const p = toPage(exact, { x: u + 0.5, y: v + 0.5 });
      const o = (v * w + u) * 4;
      out.data[o] = sampleBilinear(img, p.x, p.y, 0);
      out.data[o + 1] = sampleBilinear(img, p.x, p.y, 1);
      out.data[o + 2] = sampleBilinear(img, p.x, p.y, 2);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Composite an upright ink layer onto the page, rotated back into place:
 *   out = page * (1 - a) + color * a
 * where `a` is `coverage` (0..1) sampled bilinearly at the local position.
 * `color` may vary per pixel (e.g. to carry ink texture) via `colorAt`.
 */
export function compositeUprightInk(
  page: RasterImage,
  box: OrientedBox,
  coverage: GrayImage,
  colorAt: (u: number, v: number) => [number, number, number],
): void {
  const exact: OrientedBox = { ...box, width: coverage.width, height: coverage.height };
  const bounds = clampRectToBounds(orientedBoundingRect(exact), page.width, page.height);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const local = toLocal(exact, { x: x + 0.5, y: y + 0.5 });
      if (local.x < 0 || local.y < 0 || local.x > coverage.width || local.y > coverage.height) continue;
      const a = sampleGrayBilinear(coverage, local.x, local.y);
      if (a <= 0.002) continue;
      const [r, g, b] = colorAt(Math.floor(local.x), Math.floor(local.y));
      const o = (y * page.width + x) * 4;
      page.data[o] = page.data[o] * (1 - a) + r * a;
      page.data[o + 1] = page.data[o + 1] * (1 - a) + g * a;
      page.data[o + 2] = page.data[o + 2] * (1 - a) + b * a;
    }
  }
}
