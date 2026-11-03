import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { simplifyPath, tidyRing, worldToSurface } from './zoneDraw';
import { syncWalls } from '../../core/geometry/room';
import type { Room } from '../../core/project/types';
import type { Vec2 } from '../../core/geometry/polygon';

function room(): Room {
  const polygonMm: Vec2[] = [
    [1000, 1000],
    [3000, 1000],
    [3000, 4000],
    [1000, 4000],
  ];
  return { id: 'kitchen', name: 'Кухня', heightMm: 2400, polygonMm, walls: syncWalls([], [], polygonMm).walls, openings: [], zones: [], confirmed: true } as unknown as Room;
}

describe('drawing zones in 3D', () => {
  it('maps a hit on the floor to floor-local mm, snapping to the edges', () => {
    const r = room();
    expect(worldToSurface(r, 'floor', new THREE.Vector3(1.5, 0, 3.5))).toEqual([500, 500]);
    expect(worldToSurface(r, 'floor', new THREE.Vector3(1.02, 0, 3.99))).toEqual([0, 0]);
  });

  it('maps a hit on a wall to (u along the wall, v height) and snaps to floor and corners', () => {
    const r = room();
    const wallId = r.walls[0].id;
    const a = worldToSurface(r, wallId, new THREE.Vector3(2.0, 1.2, 1.0))!;
    expect(a[1]).toBe(1200);
    expect(Math.min(a[0], 2000 - a[0])).toBe(1000);
    const b = worldToSurface(r, wallId, new THREE.Vector3(2.0, 0.02, 1.0))!;
    expect(b[1]).toBe(0);
    const c = worldToSurface(r, wallId, new THREE.Vector3(2.0, 2.39, 1.0))!;
    expect(c[1]).toBe(2400);
  });

  it('simplifies a dense freehand stroke but keeps corners', () => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 100; i++) pts.push([i * 10, 0]);
    for (let i = 1; i <= 100; i++) pts.push([1000, i * 10]);
    const s = simplifyPath(pts, 6);
    expect(s).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 1000],
    ]);
  });

  it('drops duplicate and closing points', () => {
    expect(
      tidyRing([
        [0, 0],
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 0.5],
      ]),
    ).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
  });
});
