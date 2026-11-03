import earcut from 'earcut';
import { intersect } from '../geometry/boolean';
import {
  bboxOfMulti,
  lineSegmentsOf,
  mapMulti,
  multiPolygonArea,
  pointInMulti,
  rectRing,
  rotatePoint,
  segmentIntersectsOpenBox,
  type MultiPolygon,
  type Vec2,
} from '../geometry/polygon';

/** Rotation of the tile image on the surface, counter-clockwise. 90 turns a portrait 85×285 image into a 285×85 footprint. */
export type TileRotation = 0 | 90 | 180 | 270;
export type RowOffset = 'none' | 'half' | 'third';
export type LayoutAnchor = 'origin' | 'center';

export interface TileLayoutInput {
  /** Zone region in surface-local mm, already clipped to the surface and with openings removed. */
  region: MultiPolygon;
  /** Physical size of ONE tile as depicted by the unrotated source image (image width ↔ widthMm). */
  tileWidthMm: number;
  tileHeightMm: number;
  rotationDeg: TileRotation;
  groutMm: number;
  /** In 'origin' mode: the corner of tile (row 0, col 0). In 'center' mode: an extra shift applied after centring. */
  originMm: Vec2;
  anchor: LayoutAnchor;
  /** Rotation of the whole tile grid on the surface, degrees CCW. */
  gridAngleDeg: number;
  rowOffset: RowOffset;
}

export interface TileFragment {
  /** Polygon(s) in surface-local mm. */
  polygons: MultiPolygon;
  /** Triangulated mesh in surface-local mm with UVs relative to the FULL source image. */
  positions: number[]; // x,y pairs
  uvs: number[]; // u,v pairs, 0..1 over the whole image (v up)
  indices: number[];
}

export interface TileInstance {
  id: string;
  row: number;
  col: number;
  /** Corners of the full (uncut) physical tile in surface-local mm, CCW starting at its local (0,0). */
  fullCornersMm: [Vec2, Vec2, Vec2, Vec2];
  /** Footprint size on the surface after rotation. */
  footprintMm: { w: number; h: number };
  isFull: boolean;
  areaMm2: number;
  fullAreaMm2: number;
  fragment: TileFragment;
}

export interface TileLayoutResult {
  tiles: TileInstance[];
  fullCount: number;
  cutCount: number;
  /** Area of the region covered by tile faces (excludes grout). */
  tileAreaMm2: number;
  regionAreaMm2: number;
  footprintMm: { w: number; h: number };
  pitchMm: { x: number; y: number };
  /** Effective grid origin in grid space (after centring). */
  effectiveOriginMm: Vec2;
}

const MIN_FRAGMENT_AREA_MM2 = 0.01;
const FULL_TOLERANCE = 1e-6;

export function footprintFor(widthMm: number, heightMm: number, rotation: TileRotation): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: heightMm, h: widthMm } : { w: widthMm, h: heightMm };
}

/** Maps normalised footprint coordinates (s along footprint width, t along height) to image UV. */
export function footprintToImageUV(s: number, t: number, rotation: TileRotation): Vec2 {
  switch (rotation) {
    case 0:
      return [s, t];
    case 90:
      return [t, 1 - s];
    case 180:
      return [1 - s, 1 - t];
    case 270:
      return [1 - t, s];
  }
}

/** Inverse of footprintToImageUV. */
export function imageUVToFootprint(u: number, v: number, rotation: TileRotation): Vec2 {
  switch (rotation) {
    case 0:
      return [u, v];
    case 90:
      return [1 - v, u];
    case 180:
      return [1 - u, 1 - v];
    case 270:
      return [v, 1 - u];
  }
}

function rowShiftFraction(row: number, rowOffset: RowOffset): number {
  if (rowOffset === 'none') return 0;
  const n = rowOffset === 'half' ? 2 : 3;
  return (((row % n) + n) % n) / n;
}

export function validateTileInput(input: Pick<TileLayoutInput, 'tileWidthMm' | 'tileHeightMm' | 'groutMm'>): string | null {
  const { tileWidthMm: w, tileHeightMm: h, groutMm: g } = input;
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return 'У плитки не задан физический размер (мм).';
  if (!(g >= 0) || !Number.isFinite(g)) return 'Ширина шва должна быть ≥ 0 мм.';
  if (g > Math.min(w, h)) return 'Шов больше размера плитки.';
  return null;
}

/**
 * Lays out physical tiles over a zone region.
 * The grid is defined in "grid space": surface space rotated by -gridAngle around the origin point.
 * Every tile is a full physical rectangle of footprint w×h; tiles are spaced by w+g / h+g; each tile
 * is clipped geometrically against the region and UVs are computed against the full tile rectangle.
 */
export function computeTileLayout(input: TileLayoutInput): TileLayoutResult {
  const err = validateTileInput(input);
  if (err) throw new Error(err);
  const { region, rotationDeg, groutMm: g, rowOffset } = input;
  const fp = footprintFor(input.tileWidthMm, input.tileHeightMm, rotationDeg);
  const pitchX = fp.w + g;
  const pitchY = fp.h + g;
  const angle = (input.gridAngleDeg * Math.PI) / 180;
  const pivot: Vec2 = [input.originMm[0], input.originMm[1]];

  const toGrid = (p: Vec2) => rotatePoint(p, -angle, pivot);
  const toSurface = (p: Vec2) => rotatePoint(p, angle, pivot);

  const regionGrid = angle === 0 ? region : mapMulti(region, toGrid);
  const regionAreaMm2 = multiPolygonArea(region);
  const empty: TileLayoutResult = {
    tiles: [],
    fullCount: 0,
    cutCount: 0,
    tileAreaMm2: 0,
    regionAreaMm2,
    footprintMm: fp,
    pitchMm: { x: pitchX, y: pitchY },
    effectiveOriginMm: pivot,
  };
  if (!regionGrid.length) return empty;
  const bb = bboxOfMulti(regionGrid);

  let ox = pivot[0];
  let oy = pivot[1];
  if (input.anchor === 'center') {
    ox = (bb.minX + bb.maxX) / 2 - fp.w / 2 + input.originMm[0];
    oy = (bb.minY + bb.maxY) / 2 - fp.h / 2 + input.originMm[1];
  }
  empty.effectiveOriginMm = [ox, oy];

  const segs = lineSegmentsOf(regionGrid);
  const tiles: TileInstance[] = [];
  let fullCount = 0;
  let cutCount = 0;
  let tileArea = 0;

  const rowMin = Math.floor((bb.minY - oy) / pitchY) - 1;
  const rowMax = Math.ceil((bb.maxY - oy) / pitchY) + 1;

  for (let row = rowMin; row <= rowMax; row++) {
    const y0 = oy + row * pitchY;
    const y1 = y0 + fp.h;
    if (y1 <= bb.minY || y0 >= bb.maxY) continue;
    const shift = rowShiftFraction(row, rowOffset) * pitchX;
    const colMin = Math.floor((bb.minX - ox - shift) / pitchX) - 1;
    const colMax = Math.ceil((bb.maxX - ox - shift) / pitchX) + 1;
    for (let col = colMin; col <= colMax; col++) {
      const x0 = ox + shift + col * pitchX;
      const x1 = x0 + fp.w;
      if (x1 <= bb.minX || x0 >= bb.maxX) continue;

      const crosses = segs.some(([a, b]) => segmentIntersectsOpenBox(a, b, x0, y0, x1, y1));
      let pieces: MultiPolygon;
      let isFull = false;
      if (!crosses) {
        if (!pointInMulti([(x0 + x1) / 2, (y0 + y1) / 2], regionGrid)) continue;
        pieces = [{ outer: rectRing(x0, y0, x1, y1), holes: [] }];
        isFull = true;
      } else {
        pieces = intersect([{ outer: rectRing(x0, y0, x1, y1), holes: [] }], regionGrid);
      }
      const area = multiPolygonArea(pieces);
      if (area < MIN_FRAGMENT_AREA_MM2) continue;
      const fullArea = fp.w * fp.h;
      if (!isFull && Math.abs(area - fullArea) <= FULL_TOLERANCE * fullArea) isFull = true;

      const fragment = triangulateWithUV(pieces, x0, y0, fp.w, fp.h, rotationDeg, angle === 0 ? null : toSurface);
      const corners: [Vec2, Vec2, Vec2, Vec2] = [
        toSurface([x0, y0]),
        toSurface([x1, y0]),
        toSurface([x1, y1]),
        toSurface([x0, y1]),
      ];
      tiles.push({
        id: `r${row}c${col}`,
        row,
        col,
        fullCornersMm: corners,
        footprintMm: fp,
        isFull,
        areaMm2: area,
        fullAreaMm2: fullArea,
        fragment,
      });
      if (isFull) fullCount++;
      else cutCount++;
      tileArea += area;
    }
  }

  return { ...empty, tiles, fullCount, cutCount, tileAreaMm2: tileArea };
}

function triangulateWithUV(
  piecesGrid: MultiPolygon,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rotation: TileRotation,
  toSurface: ((p: Vec2) => Vec2) | null,
): TileFragment {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const poly of piecesGrid) {
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: Vec2[] = [];
    for (const p of poly.outer) {
      flat.push(p[0], p[1]);
      pts.push(p);
    }
    for (const hole of poly.holes) {
      holeIdx.push(pts.length);
      for (const p of hole) {
        flat.push(p[0], p[1]);
        pts.push(p);
      }
    }
    const tri = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    const base = positions.length / 2;
    for (const p of pts) {
      const s = (p[0] - x0) / w;
      const t = (p[1] - y0) / h;
      const [u, v] = footprintToImageUV(s, t, rotation);
      const sp = toSurface ? toSurface(p) : p;
      positions.push(sp[0], sp[1]);
      uvs.push(u, v);
    }
    for (const i of tri) indices.push(base + i);
  }
  const polygons = toSurface ? mapMulti(piecesGrid, toSurface) : piecesGrid;
  return { polygons, positions, uvs, indices };
}
