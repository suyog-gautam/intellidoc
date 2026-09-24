import type { RasterImage } from '@/core/image/raster';

/**
 * Holds the immutable original rasters of all pages inside the worker.
 *
 * A 300-DPI A4 page is ~35 MB as raw RGBA, so a long PDF cannot stay fully
 * decoded. Pages beyond the memory budget are compressed losslessly to PNG
 * (least recently used first) and decoded again on access. PNG keeps the
 * originals bit-exact, which the reconstruction relies on.
 */
export interface RasterCodec {
  encode(img: RasterImage): Promise<Blob>;
  decode(blob: Blob): Promise<RasterImage>;
}

interface Entry {
  raw?: RasterImage;
  packed?: Blob;
  lastUsed: number;
}

export class PageStore {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;

  constructor(
    private readonly codec: RasterCodec,
    private readonly budgetBytes = 600 * 1024 * 1024,
  ) {}

  private rawBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) if (e.raw) total += e.raw.data.byteLength;
    return total;
  }

  /** Compress least-recently-used pages until `incoming` more bytes fit, never touching `keep`. */
  private async makeRoom(incoming: number, keep: string): Promise<void> {
    while (this.rawBytes() + incoming > this.budgetBytes) {
      let victimKey: string | undefined;
      let victim: Entry | undefined;
      for (const [key, e] of this.entries) {
        if (!e.raw || key === keep) continue;
        if (!victim || e.lastUsed < victim.lastUsed) {
          victim = e;
          victimKey = key;
        }
      }
      if (!victim || !victimKey) return; // Only the kept page is raw; allow exceeding.
      victim.packed ??= await this.codec.encode(victim.raw!);
      victim.raw = undefined;
    }
  }

  async put(key: string, img: RasterImage): Promise<void> {
    await this.makeRoom(img.data.byteLength, key);
    this.entries.set(key, { raw: img, lastUsed: ++this.clock });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async get(key: string): Promise<RasterImage> {
    const e = this.entries.get(key);
    if (!e) throw new Error(`Page ${key} is not loaded`);
    e.lastUsed = ++this.clock;
    if (e.raw) return e.raw;
    const raw = await this.codec.decode(e.packed!);
    await this.makeRoom(raw.data.byteLength, key);
    e.raw = raw;
    return raw;
  }
}
