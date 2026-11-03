import { describe, expect, it } from 'vitest';
import { rectRing, type MultiPolygon } from '../geometry/polygon';
import { difference } from '../geometry/boolean';
import { computeTileLayout, footprintFor, footprintToImageUV, imageUVToFootprint, type TileLayoutInput } from './layout';
import { checkTileAspect } from './material';

const rect = (w: number, h: number): MultiPolygon => [{ outer: rectRing(0, 0, w, h), holes: [] }];

function layout(partial: Partial<TileLayoutInput> & Pick<TileLayoutInput, 'region' | 'tileWidthMm' | 'tileHeightMm'>) {
  return computeTileLayout({
    rotationDeg: 0,
    groutMm: 0,
    originMm: [0, 0],
    anchor: 'origin',
    gridAngleDeg: 0,
    rowOffset: 'none',
    ...partial,
  });
}

function uvRange(uvs: number[]) {
  const us = uvs.filter((_, i) => i % 2 === 0);
  const vs = uvs.filter((_, i) => i % 2 === 1);
  return { uMin: Math.min(...us), uMax: Math.max(...us), vMin: Math.min(...vs), vMax: Math.max(...vs) };
}

describe('Example A: 2500×2500 mm, tile 500×500', () => {
  it('no grout, from corner: 5×5 = 25 full tiles', () => {
    const r = layout({ region: rect(2500, 2500), tileWidthMm: 500, tileHeightMm: 500 });
    expect(r.tiles.length).toBe(25);
    expect(r.fullCount).toBe(25);
    expect(r.cutCount).toBe(0);
    expect(new Set(r.tiles.map((t) => t.row)).size).toBe(5);
    expect(new Set(r.tiles.map((t) => t.col)).size).toBe(5);
    expect(r.tileAreaMm2).toBeCloseTo(2500 * 2500, 6);
  });

  it('2 mm grout, from corner: 5×5 positions, last row/column cut (5×500+4×2 = 2508)', () => {
    const r = layout({ region: rect(2500, 2500), tileWidthMm: 500, tileHeightMm: 500, groutMm: 2 });
    expect(r.tiles.length).toBe(25);
    expect(r.fullCount).toBe(16);
    expect(r.cutCount).toBe(9);
    const cutEdge = r.tiles.find((t) => t.row === 0 && t.col === 4)!;
    expect(cutEdge.isFull).toBe(false);
    // last column starts at 4×502 = 2008, so 492 mm remain
    expect(cutEdge.areaMm2).toBeCloseTo(492 * 500, 6);
    const corner = r.tiles.find((t) => t.row === 4 && t.col === 4)!;
    expect(corner.areaMm2).toBeCloseTo(492 * 492, 6);
    // tile size itself never changes
    expect(r.footprintMm).toEqual({ w: 500, h: 500 });
  });

  it('2 mm grout, centred: symmetric cuts on both sides, tile size unchanged', () => {
    const r = layout({ region: rect(2500, 2500), tileWidthMm: 500, tileHeightMm: 500, groutMm: 2, anchor: 'center' });
    const cols = [...new Set(r.tiles.map((t) => t.col))].sort((a, b) => a - b);
    const first = r.tiles.find((t) => t.col === cols[0])!;
    const last = r.tiles.find((t) => t.col === cols[cols.length - 1] && t.row === first.row)!;
    expect(first.areaMm2).toBeCloseTo(last.areaMm2, 6);
    expect(r.footprintMm).toEqual({ w: 500, h: 500 });
  });
});

describe('Example B: corridor 900 mm wide, tile 450×450', () => {
  it('no grout: exactly 2 full tiles per row', () => {
    const r = layout({ region: rect(900, 450), tileWidthMm: 450, tileHeightMm: 450 });
    expect(r.tiles.length).toBe(2);
    expect(r.fullCount).toBe(2);
  });

  it('2 mm grout: two tiles + grout need 902 mm, so a cut appears', () => {
    const r = layout({ region: rect(900, 450), tileWidthMm: 450, tileHeightMm: 450, groutMm: 2 });
    expect(r.tiles.length).toBe(2);
    expect(r.fullCount).toBe(1);
    expect(r.cutCount).toBe(1);
    const cut = r.tiles.find((t) => !t.isFull)!;
    expect(cut.areaMm2).toBeCloseTo(448 * 450, 6);
  });
});

describe('450.png: whole checker pattern belongs to ONE physical tile', () => {
  it('one 450×450 region = one tile instance, not 9', () => {
    const r = layout({ region: rect(450, 450), tileWidthMm: 450, tileHeightMm: 450, groutMm: 2 });
    expect(r.tiles.length).toBe(1);
    expect(r.fullCount).toBe(1);
    const { uMin, uMax, vMin, vMax } = uvRange(r.tiles[0].fragment.uvs);
    expect([uMin, uMax, vMin, vMax]).toEqual([0, 1, 0, 1]);
  });

  it('grout lines only every 450+g mm', () => {
    const r = layout({ region: rect(1356, 450), tileWidthMm: 450, tileHeightMm: 450, groutMm: 3 });
    const starts = r.tiles.map((t) => t.fullCornersMm[0][0]).sort((a, b) => a - b);
    expect(starts).toEqual([0, 453, 906]);
  });
});

describe('280.png: 170×570 px = portrait 85×285 mm', () => {
  it('image aspect matches physical portrait size', () => {
    expect(checkTileAspect(170, 570, 85, 285).ok).toBe(true);
    expect(checkTileAspect(170, 570, 285, 85).ok).toBe(false);
  });

  it('rotation 90° gives a 285×85 footprint without crop or stretch', () => {
    expect(footprintFor(85, 285, 90)).toEqual({ w: 285, h: 85 });
    const r = layout({ region: rect(285, 85), tileWidthMm: 85, tileHeightMm: 285, rotationDeg: 90 });
    expect(r.tiles.length).toBe(1);
    expect(r.tiles[0].isFull).toBe(true);
    const f = r.tiles[0].fragment;
    // whole image is used (0..1 both axes)
    const { uMin, uMax, vMin, vMax } = uvRange(f.uvs);
    expect([uMin, uMax, vMin, vMax]).toEqual([0, 1, 0, 1]);
    // image u (its 85 mm width) runs along the surface's vertical axis
    for (let i = 0; i < f.positions.length / 2; i++) {
      const y = f.positions[2 * i + 1];
      expect(f.uvs[2 * i]).toBeCloseTo(y / 85, 9);
    }
  });
});

describe('rotation UV mapping', () => {
  it('imageUVToFootprint is the inverse of footprintToImageUV for every rotation', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      for (const [s, t] of [[0.1, 0.7], [0.9, 0.2], [0, 1]] as const) {
        const [u, v] = footprintToImageUV(s, t, rot);
        const [s2, t2] = imageUVToFootprint(u, v, rot);
        expect(s2).toBeCloseTo(s, 12);
        expect(t2).toBeCloseTo(t, 12);
      }
    }
  });
});

describe('UV of cut tiles uses the matching fragment of the source image', () => {
  it('a half-cut tile maps to half of the image, not the whole image squeezed', () => {
    const r = layout({ region: rect(225, 450), tileWidthMm: 450, tileHeightMm: 450 });
    expect(r.tiles.length).toBe(1);
    const { uMin, uMax, vMin, vMax } = uvRange(r.tiles[0].fragment.uvs);
    expect(uMin).toBeCloseTo(0);
    expect(uMax).toBeCloseTo(0.5);
    expect(vMin).toBeCloseTo(0);
    expect(vMax).toBeCloseTo(1);
  });

  it('origin offset shifts which part of the image is visible on the edge tile', () => {
    const r = layout({ region: rect(450, 450), tileWidthMm: 450, tileHeightMm: 450, originMm: [-100, 0] });
    const left = r.tiles.find((t) => t.col === 0)!;
    const { uMin, uMax } = uvRange(left.fragment.uvs);
    expect(uMin).toBeCloseTo(100 / 450);
    expect(uMax).toBeCloseTo(1);
  });
});

describe('Example D: wall with a window opening', () => {
  it('tiles around the opening are cut, area is conserved', () => {
    const wall = rect(2000, 2400);
    const region = difference(wall, [{ outer: rectRing(500, 1000, 1500, 2000), holes: [] }]);
    const r = layout({ region, tileWidthMm: 200, tileHeightMm: 200 });
    const regionArea = 2000 * 2400 - 1000 * 1000;
    expect(r.regionAreaMm2).toBeCloseTo(regionArea, 3);
    expect(r.tileAreaMm2).toBeCloseTo(regionArea, 3);
    // no tile fragment inside the opening
    for (const t of r.tiles) {
      for (let i = 0; i < t.fragment.positions.length; i += 2) {
        const x = t.fragment.positions[i];
        const y = t.fragment.positions[i + 1];
        expect(x > 500 + 1e-6 && x < 1500 - 1e-6 && y > 1000 + 1e-6 && y < 2000 - 1e-6).toBe(false);
      }
    }
  });

  it('window not aligned to the grid produces cut tiles with partial UVs', () => {
    const region = difference(rect(1000, 1000), [{ outer: rectRing(250, 250, 750, 750), holes: [] }]);
    const r = layout({ region, tileWidthMm: 200, tileHeightMm: 200 });
    const cut = r.tiles.filter((t) => !t.isFull);
    expect(cut.length).toBeGreaterThan(0);
    const t = r.tiles.find((x) => x.row === 1 && x.col === 1)!; // tile 200..400 overlapping hole from 250
    expect(t.isFull).toBe(false);
    expect(t.areaMm2).toBeCloseTo(200 * 200 - 150 * 150, 6);
  });
});

describe('Offsets and grid rotation', () => {
  it('half offset shifts every other row by half a pitch', () => {
    const r = layout({ region: rect(2000, 400), tileWidthMm: 400, tileHeightMm: 200, groutMm: 0, rowOffset: 'half' });
    const row1 = r.tiles.filter((t) => t.row === 1).map((t) => t.fullCornersMm[0][0]).sort((a, b) => a - b);
    expect(row1).toContain(200);
  });

  it('rotated grid keeps total tile area equal to region area (no grout)', () => {
    const r = layout({ region: rect(1000, 1000), tileWidthMm: 300, tileHeightMm: 300, gridAngleDeg: 45 });
    expect(r.tileAreaMm2).toBeCloseTo(1_000_000, 2);
  });

  it('layout is deterministic: same input gives the same tile IDs', () => {
    const a = layout({ region: rect(1200, 1200), tileWidthMm: 450, tileHeightMm: 450, groutMm: 2 });
    const b = layout({ region: rect(1200, 1200), tileWidthMm: 450, tileHeightMm: 450, groutMm: 2 });
    expect(a.tiles.map((t) => t.id)).toEqual(b.tiles.map((t) => t.id));
  });

  it('rejects tiles without physical size', () => {
    expect(() => layout({ region: rect(100, 100), tileWidthMm: 0, tileHeightMm: 100 })).toThrow();
  });
});
