import type { Vec2 } from '../../core/geometry/polygon';
import { wallFrames } from '../../core/geometry/room';
import type { Opening, RoomId } from '../../core/project/types';

/**
 * Inner faces of the three pilot rooms, measured from the wall lines of room_scheme.pdf.
 * The scale is fixed by the printed 2240 mm kitchen width (page x 275 → 433.7).
 * Wall thickness on the drawing is 100 mm. Door heights are not on the plan.
 */
const S = 2240 / (433.7 - 275);
const PAGE_H = 841.8898;
const PAGE_W = 1190.5511;

const ox = Math.round(275 * S);
const oy = Math.round((PAGE_H - 712.9) * S);
const wall = 100;

const kitchen: Vec2[] = [
  [ox, oy],
  [ox + 2240, oy],
  [ox + 2240, oy + 2480],
  [ox, oy + 2480],
];

/** Toilet: 1670 × 1520, with the 850 × 300 chase in the north-east corner excluded. */
const tw = ox + 2240 + wall;
const toilet: Vec2[] = [
  [tw, oy],
  [tw + 820, oy],
  [tw + 820, oy + 300],
  [tw + 1670, oy + 300],
  [tw + 1670, oy + 1520],
  [tw, oy + 1520],
];

const shaftW = Math.round(566.2 * S);
const stepY = Math.round((PAGE_H - 598.1) * S);
const eastX = Math.round(663.3 * S);
const corridor: Vec2[] = [
  [tw, oy + 2480],
  [eastX, oy + 2480],
  [eastX, oy],
  [shaftW, oy],
  [shaftW, stepY],
  [tw, stepY],
];

export interface PilotRoomGeometry {
  id: RoomId;
  polygonMm: Vec2[];
  openings: (Omit<Opening, 'id' | 'wallId'> & { edge: number })[];
}

function edgeOffset(poly: Vec2[], edge: number, point: Vec2): number {
  const frames = wallFrames({ polygonMm: poly, walls: poly.map((_, i) => ({ id: `w${i}`, name: '' })) });
  const f = frames[edge];
  return (point[0] - f.start[0]) * f.dir[0] + (point[1] - f.start[1]) * f.dir[1];
}

/** Offset of a segment lying on an edge, measured from the wall's u = 0. */
function segmentOffset(poly: Vec2[], edge: number, a: Vec2, b: Vec2): number {
  return Math.round(Math.min(edgeOffset(poly, edge, a), edgeOffset(poly, edge, b)));
}

const kw = kitchen;
const windowSouth = kw[3][1] - 552;
const kitchenOpenings: PilotRoomGeometry['openings'] = [
  {
    edge: 3,
    kind: 'window',
    offsetMm: segmentOffset(kw, 3, [kw[0][0], windowSouth], [kw[0][0], windowSouth - 1233]),
    widthMm: 1233,
    bottomMm: 1000,
    heightMm: 1000,
    heightAssumed: false,
  },
  {
    edge: 1,
    kind: 'door',
    offsetMm: segmentOffset(kw, 1, [kw[1][0], oy + 1620], [kw[1][0], oy + 2480]),
    widthMm: 860,
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
];

const toiletOpenings: PilotRoomGeometry['openings'] = [
  {
    edge: 4,
    kind: 'door',
    offsetMm: segmentOffset(toilet, 4, [tw + 784, oy + 1520], [tw + 1670, oy + 1520]),
    widthMm: 886,
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
];

const corridorOpenings: PilotRoomGeometry['openings'] = [
  {
    edge: 2,
    kind: 'door',
    offsetMm: segmentOffset(corridor, 2, [Math.round(585.7 * S), oy], [Math.round(648.7 * S), oy]),
    widthMm: 889,
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
  {
    edge: 0,
    kind: 'door',
    offsetMm: segmentOffset(corridor, 0, [Math.round(587.5 * S), oy + 2480], [eastX, oy + 2480]),
    widthMm: Math.round((663.3 - 587.5) * S),
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
  {
    edge: 5,
    kind: 'door',
    offsetMm: 0,
    widthMm: Math.abs(oy + 2480 - stepY),
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
  {
    // Same hole as the toilet's south door, on the corridor face of that wall.
    edge: 4,
    kind: 'door',
    offsetMm: segmentOffset(corridor, 4, [tw + 784, stepY], [tw + 1670, stepY]),
    widthMm: 886,
    bottomMm: 0,
    heightMm: 2100,
    heightAssumed: true,
  },
];

export function pilotRooms(): PilotRoomGeometry[] {
  return [
    { id: 'kitchen', polygonMm: kitchen, openings: kitchenOpenings },
    { id: 'wc', polygonMm: toilet, openings: toiletOpenings },
    { id: 'corridor', polygonMm: corridor, openings: corridorOpenings.filter((o) => o.widthMm > 100) },
  ];
}

/** mm per raster pixel so these polygons sit on a rendering of the PDF page. */
export function pilotMmPerPx(rasterWidthPx: number): number {
  return (S * PAGE_W) / rasterWidthPx;
}

/** Ends of the 2240 mm kitchen dimension, in raster pixels. */
export function pilotCalibrationPoints(rasterWidthPx: number): { p1: Vec2; p2: Vec2; lengthMm: number } {
  const k = rasterWidthPx / PAGE_W;
  const y = (PAGE_H - 712.9) * k;
  return { p1: [275 * k, y], p2: [433.7 * k, y], lengthMm: 2240 };
}
