/** All coordinates in this module are millimetres unless stated otherwise. */
export type Vec2 = [number, number];
export type Ring = Vec2[];

/** A polygon with an outer ring and optional holes. Rings are not closed (first point is not repeated). */
export interface PolygonWithHoles {
  outer: Ring;
  holes: Ring[];
}

export type MultiPolygon = PolygonWithHoles[];

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const EPS = 1e-7;

export function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function ringArea(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

export function polygonArea(p: PolygonWithHoles): number {
  return ringArea(p.outer) - p.holes.reduce((a, h) => a + ringArea(h), 0);
}

export function multiPolygonArea(mp: MultiPolygon): number {
  return mp.reduce((a, p) => a + polygonArea(p), 0);
}

export function ringPerimeter(ring: Ring): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) s += dist(ring[i], ring[(i + 1) % n]);
  return s;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function bboxOfRing(ring: Ring): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOfMulti(mp: MultiPolygon): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of mp) {
    const r = bboxOfRing(p.outer);
    b.minX = Math.min(b.minX, r.minX);
    b.minY = Math.min(b.minY, r.minY);
    b.maxX = Math.max(b.maxX, r.maxX);
    b.maxY = Math.max(b.maxY, r.maxY);
  }
  return b;
}

/** Ray-casting point-in-ring test. Points exactly on the boundary are not reliably classified. */
export function pointInRing(pt: Vec2, ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt: Vec2, p: PolygonWithHoles): boolean {
  if (!pointInRing(pt, p.outer)) return false;
  return !p.holes.some((h) => pointInRing(pt, h));
}

export function pointInMulti(pt: Vec2, mp: MultiPolygon): boolean {
  return mp.some((p) => pointInPolygon(pt, p));
}

/** Removes consecutive duplicate points and a repeated closing point. */
export function cleanRing(ring: Ring, eps = 1e-6): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

export function rectRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

export function rotatePoint(p: Vec2, angleRad: number, about: Vec2 = [0, 0]): Vec2 {
  if (angleRad === 0) return [p[0], p[1]];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dx = p[0] - about[0];
  const dy = p[1] - about[1];
  return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c];
}

export function mapMulti(mp: MultiPolygon, f: (p: Vec2) => Vec2): MultiPolygon {
  return mp.map((p) => ({ outer: p.outer.map(f), holes: p.holes.map((h) => h.map(f)) }));
}

/** True if the segment a-b intersects the open (interior of the) axis-aligned box. Liang–Barsky. */
export function segmentIntersectsOpenBox(a: Vec2, b: Vec2, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-15) {
      if (q[i] <= 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 - t0 > 1e-12;
}

export function lineSegmentsOf(mp: MultiPolygon): [Vec2, Vec2][] {
  const segs: [Vec2, Vec2][] = [];
  const add = (r: Ring) => {
    for (let i = 0; i < r.length; i++) segs.push([r[i], r[(i + 1) % r.length]]);
  };
  for (const p of mp) {
    add(p.outer);
    p.holes.forEach(add);
  }
  return segs;
}

/** Centroid of a simple ring (area-weighted). */
export function ringCentroid(ring: Ring): Vec2 {
  const a = signedArea(ring);
  if (Math.abs(a) < EPS) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Checks for self-intersections between non-adjacent edges of a ring. */
export function ringSelfIntersects(ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsProperlyIntersect(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
