import * as THREE from 'three';
import type { Vec2 } from '../../core/geometry/polygon';
import { bboxOfRing } from '../../core/geometry/polygon';
import { floorFrame, wallFrames } from '../../core/geometry/room';
import type { Room, SurfaceId } from '../../core/project/types';
import { floorMap, wallMap, type SurfaceMap } from './sceneBuilder';

const EDGE_SNAP_MM = 40;

/** Surface-local (u, v) mm of a world hit point, snapped to the surface edges and clamped inside it. */
export function worldToSurface(room: Room, surfaceId: SurfaceId, p: THREE.Vector3): Vec2 | null {
  const x = p.x * 1000;
  const y = p.z * 1000;
  let u: number;
  let v: number;
  let maxU: number;
  let maxV: number;
  if (surfaceId === 'floor') {
    const fr = floorFrame(room);
    [u, v] = fr.toLocal([x, y]);
    const bb = bboxOfRing(room.polygonMm.map(fr.toLocal));
    maxU = bb.maxX;
    maxV = bb.maxY;
  } else {
    const f = wallFrames(room).find((w) => w.wallId === surfaceId);
    if (!f) return null;
    u = (x - f.start[0]) * f.dir[0] + (y - f.start[1]) * f.dir[1];
    v = p.y * 1000;
    maxU = f.lengthMm;
    maxV = room.heightMm;
  }
  const snap = (t: number, max: number) => {
    if (t < EDGE_SNAP_MM) return 0;
    if (t > max - EDGE_SNAP_MM) return max;
    return Math.round(t);
  };
  return [snap(u, maxU), snap(v, maxV)];
}

export function surfaceMapFor(room: Room, surfaceId: SurfaceId): SurfaceMap | null {
  if (surfaceId === 'floor') return floorMap(room);
  const f = wallFrames(room).find((w) => w.wallId === surfaceId);
  return f ? wallMap(f) : null;
}

/** Douglas–Peucker simplification of an open polyline (mm). */
export function simplifyPath(pts: Vec2[], tolMm: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1;
    let bestD = tolMm;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Removes repeated points and a closing point equal to the first one. */
export function tidyRing(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1) out.pop();
  return out;
}
