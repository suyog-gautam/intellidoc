import { createRaster, type RasterImage } from '../image/raster';
import { normalizeIllumination } from '../vision/preprocess';

/**
 * Prepare a handwritten line crop for a recogniser trained on clean scans
 * (TrOCR, IAM): flatten uneven phone lighting, stretch paper to white and
 * ink to black, drop the paper tint, and add a white margin around the line
 * (training lines have one). On real phone photos this is the difference
 * between "familiar enough - that" and "Rival Bag House".
 */
export function prepareHandwritingLine(crop: RasterImage): RasterImage {
  const flat = normalizeIllumination(crop).data;
  // Contrast: darkest 2% → black, paper → white.
  const sorted = Float32Array.from(flat).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.6)];
  const span = Math.max(20, hi - lo);
  const padY = Math.round(crop.height * 0.25);
  const padX = Math.round(crop.height * 0.3);
  const out = createRaster(crop.width + 2 * padX, crop.height + 2 * padY, [255, 255, 255, 255]);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const v = Math.max(0, Math.min(255, ((flat[y * crop.width + x] - lo) / span) * 255));
      const o = ((y + padY) * out.width + x + padX) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
    }
  }
  return out;
}
