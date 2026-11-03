import { describe, expect, it } from 'vitest';
import { multiPolygonArea, type Vec2 } from './polygon';
import { floorFrame, mmToM, surfaceAvailableRegion, syncWalls, uncoveredRegion, validateContour, wallFrames, zoneRegion } from './room';
import type { Room } from '../project/types';

function room(poly: Vec2[]): Room {
  const { walls } = syncWalls([], [], poly);
  return { id: 'kitchen', name: 'Кухня', polygonMm: poly, confirmed: true, heightMm: 2400, walls, openings: [], zones: [] };
}

const square: Vec2[] = [
  [0, 0],
  [3000, 0],
  [3000, 2000],
  [0, 2000],
];

describe('units', () => {
  it('mm → metres is a single /1000 conversion', () => {
    expect(mmToM(2400)).toBe(2.4);
  });
});

describe('contour validation', () => {
  it('accepts a rectangle and rejects a bow-tie', () => {
    expect(validateContour(square)).toBeNull();
    expect(validateContour([[0, 0], [1000, 1000], [1000, 0], [0, 1000]])).not.toBeNull();
  });
});

describe('wall frames', () => {
  it('inward normals point into the room and u goes to the right seen from inside, regardless of winding', () => {
    for (const poly of [square, [...square].reverse()]) {
      const r = room(poly);
      const frames = wallFrames(r);
      expect(frames).toHaveLength(4);
      for (const f of frames) {
        // right-hand direction of a viewer facing the wall (looking along -inward) is (inward.y, -inward.x)
        const right: Vec2 = [f.inward[1], -f.inward[0]];
        expect(f.dir[0] * right[0] + f.dir[1] * right[1]).toBeCloseTo(1);
        const mid: Vec2 = [(f.start[0] + f.end[0]) / 2 + f.inward[0] * 10, (f.start[1] + f.end[1]) / 2 + f.inward[1] * 10];
        expect(mid[0] > 0 && mid[0] < 3000 && mid[1] > 0 && mid[1] < 2000).toBe(true);
      }
    }
  });

  it('works for an L-shaped room (inner corner)', () => {
    const L: Vec2[] = [
      [0, 0],
      [4000, 0],
      [4000, 1500],
      [1500, 1500],
      [1500, 3000],
      [0, 3000],
    ];
    const frames = wallFrames(room(L));
    expect(frames).toHaveLength(6);
    const inner = frames.find((f) => f.index === 2)!; // edge (4000,1500)->(1500,1500): room is above (smaller y)
    expect(inner.inward[1]).toBeCloseTo(-1);
  });
});

describe('floor frame', () => {
  it('maps plan to non-mirrored local coordinates', () => {
    const f = floorFrame({ polygonMm: square });
    expect(f.toLocal([0, 2000])).toEqual([0, 0]);
    expect(f.toLocal([3000, 0])).toEqual([3000, 2000]);
    expect(f.toPlan(f.toLocal([1234, 567]))).toEqual([1234, 567]);
  });
});

describe('zones and openings', () => {
  it('openings are subtracted from the wall and from zones', () => {
    const r = room(square);
    const w = r.walls[0];
    r.openings.push({ id: 'o1', wallId: w.id, kind: 'window', offsetMm: 1000, widthMm: 1000, bottomMm: 1000, heightMm: 1000, heightAssumed: false });
    expect(multiPolygonArea(surfaceAvailableRegion(r, w.id))).toBeCloseTo(3000 * 2400 - 1000 * 1000);
    r.zones.push({ id: 'z1', name: 'Фартук', surfaceId: w.id, kind: 'rect', polygonMm: [[0, 0], [3000, 0], [3000, 1500], [0, 1500]], createdAt: 0 });
    expect(multiPolygonArea(zoneRegion(r, r.zones[0]))).toBeCloseTo(3000 * 1500 - 1000 * 500);
  });

  it('a later zone lies on top of an earlier one; the uncovered part remains base', () => {
    const r = room(square);
    r.zones.push({ id: 'a', name: 'Весь пол', surfaceId: 'floor', kind: 'full', polygonMm: [[0, 0], [3000, 0], [3000, 2000], [0, 2000]], createdAt: 0 });
    r.zones.push({ id: 'b', name: 'Ковёр', surfaceId: 'floor', kind: 'rect', polygonMm: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], createdAt: 1 });
    expect(multiPolygonArea(zoneRegion(r, r.zones[0]))).toBeCloseTo(6e6 - 1e6);
    expect(multiPolygonArea(zoneRegion(r, r.zones[1]))).toBeCloseTo(1e6);
    expect(multiPolygonArea(uncoveredRegion(r, 'floor'))).toBeCloseTo(0);
  });
});

describe('syncWalls', () => {
  it('keeps ids of unchanged edges when a vertex is inserted', () => {
    const a = syncWalls([], [], square);
    const inserted: Vec2[] = [square[0], [1500, 0], square[1], square[2], square[3]];
    const b = syncWalls(square, a.walls, inserted);
    expect(b.walls[2].id).toBe(a.walls[1].id);
    expect(b.walls[3].id).toBe(a.walls[2].id);
    expect(b.removedIds).toEqual([a.walls[0].id]);
  });

  it('keeps all ids when vertices are only moved', () => {
    const a = syncWalls([], [], square);
    const moved: Vec2[] = square.map(([x, y]) => [x + 10, y]);
    const b = syncWalls(square, a.walls, moved);
    expect(b.walls.map((w) => w.id)).toEqual(a.walls.map((w) => w.id));
    expect(b.removedIds).toEqual([]);
  });
});
