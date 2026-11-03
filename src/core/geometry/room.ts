import { difference, intersect } from './boolean';
import {
  bboxOfRing,
  cleanRing,
  dist,
  pointInRing,
  rectRing,
  ringArea,
  ringSelfIntersects,
  type MultiPolygon,
  type Ring,
  type Vec2,
} from './polygon';
import type { Opening, Room, SurfaceId, Wall, Zone } from '../project/types';
import { newId } from '../project/ids';

/** The single mm → Three.js world conversion (1 world unit = 1 metre). */
export const mmToM = (mm: number): number => mm / 1000;

/** Plan (x right, y down in mm) + height (mm) → world metres [x, y(up), z]. */
export function planToWorld(p: Vec2, heightMm: number): [number, number, number] {
  return [mmToM(p[0]), mmToM(heightMm), mmToM(p[1])];
}

export interface WallFrame {
  wallId: string;
  index: number;
  name: string;
  /** Plan point where local u = 0. Seen from inside the room, u grows to the right. */
  start: Vec2;
  end: Vec2;
  lengthMm: number;
  /** Unit direction of +u in plan. */
  dir: Vec2;
  /** Unit normal pointing into the room, in plan. */
  inward: Vec2;
}

export function validateContour(ring: Ring): string | null {
  const r = cleanRing(ring);
  if (r.length < 3) return 'Контур должен иметь минимум 3 вершины.';
  if (ringArea(r) < 1e4) return 'Площадь контура слишком мала (< 0,01 м²).';
  if (ringSelfIntersects(r)) return 'Контур самопересекается.';
  for (let i = 0; i < r.length; i++) if (dist(r[i], r[(i + 1) % r.length]) < 1) return 'Есть ребро короче 1 мм.';
  return null;
}

export function wallFrames(room: Pick<Room, 'polygonMm' | 'walls'>): WallFrame[] {
  const poly = room.polygonMm;
  const n = poly.length;
  if (n < 3) return [];
  const frames: WallFrame[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let inward: Vec2 = [-d[1], d[0]];
    const probe: Vec2 = [mid[0] + inward[0] * 1, mid[1] + inward[1] * 1];
    if (!pointInRing(probe, poly)) inward = [d[1], -d[0]];
    // Viewer inside faces -inward; their right-hand direction in plan is (inward.y, -inward.x).
    const right: Vec2 = [inward[1], -inward[0]];
    const flip = d[0] * right[0] + d[1] * right[1] < 0;
    const wall = room.walls[i];
    frames.push({
      wallId: wall?.id ?? `edge${i}`,
      index: i,
      name: wall?.name ?? `Стена ${i + 1}`,
      start: flip ? b : a,
      end: flip ? a : b,
      lengthMm: len,
      dir: flip ? [-d[0], -d[1]] : d,
      inward,
    });
  }
  return frames;
}

export function wallPointToPlan(frame: WallFrame, u: number): Vec2 {
  return [frame.start[0] + frame.dir[0] * u, frame.start[1] + frame.dir[1] * u];
}

/** Floor local frame: u = x − minX, v = maxY − y (so the floor seen from above is not mirrored). */
export function floorFrame(room: Pick<Room, 'polygonMm'>) {
  const bb = bboxOfRing(room.polygonMm);
  return {
    minX: bb.minX,
    maxY: bb.maxY,
    toLocal: (p: Vec2): Vec2 => [p[0] - bb.minX, bb.maxY - p[1]],
    toPlan: (p: Vec2): Vec2 => [p[0] + bb.minX, bb.maxY - p[1]],
  };
}

export function surfaceOutline(room: Room, surfaceId: SurfaceId): MultiPolygon {
  if (room.polygonMm.length < 3) return [];
  if (surfaceId === 'floor') {
    const f = floorFrame(room);
    return [{ outer: room.polygonMm.map(f.toLocal), holes: [] }];
  }
  const fr = wallFrames(room).find((w) => w.wallId === surfaceId);
  if (!fr) return [];
  return [{ outer: rectRing(0, 0, fr.lengthMm, room.heightMm), holes: [] }];
}

export function openingRing(o: Opening): Ring {
  return rectRing(o.offsetMm, o.bottomMm, o.offsetMm + o.widthMm, o.bottomMm + o.heightMm);
}

export function surfaceOpenings(room: Room, surfaceId: SurfaceId): MultiPolygon {
  if (surfaceId === 'floor') return [];
  return room.openings.filter((o) => o.wallId === surfaceId).map((o) => ({ outer: openingRing(o), holes: [] }));
}

/** Surface outline minus openings. */
export function surfaceAvailableRegion(room: Room, surfaceId: SurfaceId): MultiPolygon {
  return difference(surfaceOutline(room, surfaceId), surfaceOpenings(room, surfaceId));
}

export function surfaceZones(room: Room, surfaceId: SurfaceId): Zone[] {
  return room.zones.filter((z) => z.surfaceId === surfaceId);
}

/**
 * Effective region of a zone: its user-defined outline ∩ surface − openings − zones created later on the
 * same surface (later zones lie on top). It never depends on the assigned material.
 */
export function zoneRegion(room: Room, zone: Zone): MultiPolygon {
  const avail = surfaceAvailableRegion(room, zone.surfaceId);
  const own = intersect([{ outer: cleanRing(zone.polygonMm), holes: [] }], avail);
  const zones = surfaceZones(room, zone.surfaceId);
  const idx = zones.findIndex((z) => z.id === zone.id);
  const above = zones.slice(idx + 1).map((z) => [{ outer: cleanRing(z.polygonMm), holes: [] }] as MultiPolygon);
  return difference(own, ...above);
}

/** Part of the surface not covered by any zone (rendered as neutral paint / base). */
export function uncoveredRegion(room: Room, surfaceId: SurfaceId): MultiPolygon {
  const avail = surfaceAvailableRegion(room, surfaceId);
  const zs = surfaceZones(room, surfaceId).map((z) => [{ outer: cleanRing(z.polygonMm), holes: [] }] as MultiPolygon);
  return difference(avail, ...zs);
}

export function surfaceName(room: Room, surfaceId: SurfaceId): string {
  if (surfaceId === 'floor') return 'Пол';
  return room.walls.find((w) => w.id === surfaceId)?.name ?? 'Стена';
}

/**
 * Keeps wall ids stable when the contour is edited: an edge keeps its id if both endpoints are unchanged.
 * Returns new walls plus ids that disappeared (their openings/zones must be removed).
 */
export function syncWalls(oldPoly: Vec2[], oldWalls: Wall[], newPoly: Vec2[]): { walls: Wall[]; removedIds: string[] } {
  const key = (a: Vec2, b: Vec2) => {
    const k1 = `${a[0].toFixed(3)},${a[1].toFixed(3)}`;
    const k2 = `${b[0].toFixed(3)},${b[1].toFixed(3)}`;
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  };
  if (oldPoly.length >= 3 && newPoly.length === oldPoly.length && oldWalls.length === oldPoly.length) {
    // Same topology (vertices moved): edges keep their ids by index.
    return { walls: oldWalls.map((w) => ({ ...w })), removedIds: [] };
  }
  const oldMap = new Map<string, Wall>();
  for (let i = 0; i < oldPoly.length && oldPoly.length >= 3; i++) {
    const w = oldWalls[i];
    if (w) oldMap.set(key(oldPoly[i], oldPoly[(i + 1) % oldPoly.length]), w);
  }
  const used = new Set<string>();
  const walls: Wall[] = [];
  const n = newPoly.length;
  for (let i = 0; i < n; i++) {
    const k = key(newPoly[i], newPoly[(i + 1) % n]);
    const prev = oldMap.get(k);
    if (prev && !used.has(prev.id)) {
      used.add(prev.id);
      walls.push(prev);
    } else walls.push({ id: newId('wall'), name: '' });
  }
  const named = walls.map((w, i) => (!w.name || /^Стена \d+$/.test(w.name) ? { ...w, name: `Стена ${i + 1}` } : w));
  const removedIds = oldWalls.filter((w) => !used.has(w.id)).map((w) => w.id);
  return { walls: named, removedIds };
}
