import { describe, expect, it } from 'vitest';
import { validateContour, wallFrames, wallPointToPlan } from '../../core/geometry/room';
import { pilotCalibrationPoints, pilotMmPerPx, pilotRooms } from './pilotGeometry';

describe('measured pilot rooms', () => {
  const rooms = pilotRooms();

  it('builds three valid contours with the kitchen at 2240 × 2480', () => {
    expect(rooms.map((r) => r.id)).toEqual(['kitchen', 'wc', 'corridor']);
    for (const r of rooms) expect(validateContour(r.polygonMm)).toBeNull();
    const k = rooms[0].polygonMm;
    expect(k[1][0] - k[0][0]).toBe(2240);
    expect(k[3][1] - k[0][1]).toBe(2480);
  });

  it('puts every opening on its wall without running past the ends', () => {
    for (const r of rooms) {
      const frames = wallFrames({ polygonMm: r.polygonMm, walls: r.polygonMm.map((_, i) => ({ id: `w${i}`, name: '' })) });
      for (const o of r.openings) {
        const f = frames[o.edge];
        expect(o.offsetMm).toBeGreaterThanOrEqual(-1);
        expect(o.offsetMm + o.widthMm).toBeLessThanOrEqual(f.lengthMm + 1);
      }
    }
  });

  it('gives the kitchen its window and keeps door openings without leaves', () => {
    const k = rooms[0];
    const win = k.openings.find((o) => o.kind === 'window')!;
    expect(win.edge).toBe(3);
    expect(win.widthMm).toBe(1233);
    expect(win.bottomMm).toBe(1000);
    expect(k.openings.filter((o) => o.kind === 'door')).toHaveLength(1);
    expect(rooms.find((r) => r.id === 'wc')!.openings.filter((o) => o.kind === 'door')).toHaveLength(1);
    expect(rooms.find((r) => r.id === 'corridor')!.openings.filter((o) => o.kind === 'door').length).toBeGreaterThan(0);
    for (const o of rooms.flatMap((r) => r.openings).filter((o) => o.kind === 'door')) {
      expect(o.bottomMm).toBe(0);
      expect(o.heightMm).toBe(2100);
    }
  });

  it('cuts the toilet door through the corridor face of the same wall', () => {
    const spanX = (poly: (typeof rooms)[number]['polygonMm'], edge: number, offset: number, width: number) => {
      const f = wallFrames({ polygonMm: poly, walls: poly.map((_, i) => ({ id: `w${i}`, name: '' })) })[edge];
      const xs = [offset, offset + width].map((u) => wallPointToPlan(f, u)[0]);
      return [Math.min(...xs), Math.max(...xs)] as const;
    };
    const wc = rooms.find((r) => r.id === 'wc')!;
    const cor = rooms.find((r) => r.id === 'corridor')!;
    const toiletDoor = wc.openings.find((o) => o.kind === 'door')!;
    const toiletX = spanX(wc.polygonMm, toiletDoor.edge, toiletDoor.offsetMm, toiletDoor.widthMm);
    const match = cor.openings.find((o) => {
      const x = spanX(cor.polygonMm, o.edge, o.offsetMm, o.widthMm);
      return Math.abs(x[0] - toiletX[0]) < 2 && Math.abs(x[1] - toiletX[1]) < 2;
    });
    expect(match?.widthMm).toBe(toiletDoor.widthMm);
  });

  it('calibrates the 2240 mm line onto the raster', () => {
    const c = pilotCalibrationPoints(3572);
    const px = Math.hypot(c.p2[0] - c.p1[0], c.p2[1] - c.p1[1]);
    expect(c.lengthMm / px).toBeCloseTo(pilotMmPerPx(3572), 6);
  });
});
