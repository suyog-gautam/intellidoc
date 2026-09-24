/** Axis-aligned rectangle in page pixel coordinates (origin top-left, y down). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rotated rectangle. `angle` is in radians, measured clockwise in image space
 * (because y points down), and describes the direction of the text baseline.
 */
export interface OrientedBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

export interface Point {
  x: number;
  y: number;
}

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function expandRect(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy };
}

/** Clamp a rect to integer pixel bounds inside a `width` x `height` surface. */
export function clampRectToBounds(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export function verticalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

export function orientedCorners(box: OrientedBox): Point[] {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const hw = box.width / 2;
  const hh = box.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([u, v]) => ({ x: box.cx + u * c - v * s, y: box.cy + u * s + v * c }));
}

export function orientedBoundingRect(box: OrientedBox): Rect {
  const pts = orientedCorners(box);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Map a page point into the box's local upright frame (origin at the box's top-left corner). */
export function toLocal(box: OrientedBox, p: Point): Point {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const dx = p.x - box.cx;
  const dy = p.y - box.cy;
  return { x: dx * c + dy * s + box.width / 2, y: -dx * s + dy * c + box.height / 2 };
}

/** Inverse of {@link toLocal}. */
export function toPage(box: OrientedBox, p: Point): Point {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const u = p.x - box.width / 2;
  const v = p.y - box.height / 2;
  return { x: box.cx + u * c - v * s, y: box.cy + u * s + v * c };
}

/**
 * Recover the upright size of a rotated rectangle from its axis-aligned bounds.
 * Falls back to the AABB size when the system is ill-conditioned (near 45°).
 */
export function orientedFromAxisAligned(r: Rect, angle: number): OrientedBox {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const det = c * c - s * s;
  let width = r.width;
  let height = r.height;
  if (det > 0.3) {
    width = (r.width * c - r.height * s) / det;
    height = (r.height * c - r.width * s) / det;
    if (width <= 0 || height <= 0) {
      width = r.width;
      height = r.height;
    }
  }
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, width, height, angle };
}
