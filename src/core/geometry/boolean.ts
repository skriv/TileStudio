import polygonClipping from 'polygon-clipping';
import type { MultiPolygon as PCMulti, Polygon as PCPolygon, Ring as PCRing } from 'polygon-clipping';
import { cleanRing, ringArea, type MultiPolygon, type PolygonWithHoles, type Ring } from './polygon';

const MIN_AREA_MM2 = 1e-4;

function toPCRing(r: Ring): PCRing {
  const pts = r.map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length) pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

function toPC(mp: MultiPolygon): PCMulti {
  return mp
    .filter((p) => p.outer.length >= 3)
    .map((p) => [toPCRing(p.outer), ...p.holes.filter((h) => h.length >= 3).map(toPCRing)] as PCPolygon);
}

function fromPC(mp: PCMulti): MultiPolygon {
  const out: MultiPolygon = [];
  for (const poly of mp) {
    const [outerRaw, ...holesRaw] = poly;
    const outer = cleanRing(outerRaw.map((p) => [p[0], p[1]]));
    if (outer.length < 3 || ringArea(outer) < MIN_AREA_MM2) continue;
    const holes = holesRaw
      .map((h) => cleanRing(h.map((p) => [p[0], p[1]])))
      .filter((h) => h.length >= 3 && ringArea(h) >= MIN_AREA_MM2);
    out.push({ outer, holes });
  }
  return out;
}

export function polygonFromRing(ring: Ring): PolygonWithHoles {
  return { outer: cleanRing(ring), holes: [] };
}

export function intersect(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (!a.length || !b.length) return [];
  return fromPC(polygonClipping.intersection(toPC(a), toPC(b)));
}

export function difference(a: MultiPolygon, ...subtract: MultiPolygon[]): MultiPolygon {
  const subs = subtract.filter((s) => s.length).map(toPC);
  if (!a.length) return [];
  if (!subs.length) return a;
  return fromPC(polygonClipping.difference(toPC(a), ...subs));
}

export function union(...parts: MultiPolygon[]): MultiPolygon {
  const ps = parts.filter((p) => p.length).map(toPC);
  if (!ps.length) return [];
  const [first, ...rest] = ps;
  return fromPC(polygonClipping.union(first, ...rest));
}
