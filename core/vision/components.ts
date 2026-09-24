import { createMask, type Mask } from '../image/filters';

export interface Component {
  /** Label value in the label image (1-based). */
  label: number;
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  /** Exclusive. */
  y1: number;
  area: number;
}

export interface ComponentLabels {
  readonly width: number;
  readonly height: number;
  /** 0 = background, otherwise component label. */
  readonly labels: Int32Array;
  readonly components: Component[];
}

/** 8-connected component labelling with an explicit stack (no recursion). */
export function labelComponents(mask: Mask): ComponentLabels {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const components: Component[] = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!data[start] || labels[start]) continue;
    const label = next++;
    const comp: Component = { label, x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      comp.area++;
      if (x < comp.x0) comp.x0 = x;
      if (y < comp.y0) comp.y0 = y;
      if (x + 1 > comp.x1) comp.x1 = x + 1;
      if (y + 1 > comp.y1) comp.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (data[q] && !labels[q]) {
            labels[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
    components.push(comp);
  }
  return { width: w, height: h, labels, components };
}

/** Build a mask containing only the listed component labels. */
export function maskFromLabels(cl: ComponentLabels, keep: ReadonlySet<number>): Mask {
  const out = createMask(cl.width, cl.height);
  for (let i = 0; i < cl.labels.length; i++) {
    if (keep.has(cl.labels[i])) out.data[i] = 1;
  }
  return out;
}
