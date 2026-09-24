/**
 * Node-only runtime adapter for tests, benchmarks and scripts. The browser
 * app never imports this file (it uses OffscreenCanvas + FontFace instead).
 */
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import type { RasterImage } from '@/core/image/raster';
import { CanvasTextRasterizer, type CanvasFactory } from '@/core/rendering/textRasterizer';
import { FONT_CATALOG } from '@/core/typography/fontCatalog';

const root = process.cwd();
let fontsRegistered = false;

export function registerCandidateFonts(): void {
  if (fontsRegistered) return;
  for (const font of FONT_CATALOG) {
    const pkg = font.faces[0].file.split('-latin-')[0];
    for (const face of font.faces) {
      const file = path.join(root, 'node_modules', '@fontsource', pkg, 'files', face.file);
      if (fs.existsSync(file)) GlobalFonts.registerFromPath(file, font.family);
    }
  }
  fontsRegistered = true;
}

export const nodeCanvasFactory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as ReturnType<CanvasFactory>;

export function createNodeRasterizer(): CanvasTextRasterizer {
  registerCandidateFonts();
  return new CanvasTextRasterizer(nodeCanvasFactory);
}

export async function decodeImageFile(file: string): Promise<RasterImage> {
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(data.data) };
}

export function encodePng(img: RasterImage): Buffer {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  return canvas.toBuffer('image/png');
}

export function writePng(file: string, img: RasterImage): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
}
