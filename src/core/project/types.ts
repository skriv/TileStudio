import type { Vec2 } from '../geometry/polygon';
import type { LayoutAnchor, RowOffset, TileRotation } from '../tiling/layout';

export const SCHEMA_VERSION = 1 as const;
export const DEFAULT_CEILING_MM = 2400;

export type RoomId = 'kitchen' | 'wc' | 'corridor';
export const PILOT_ROOMS: { id: RoomId; name: string }[] = [
  { id: 'kitchen', name: 'Кухня' },
  { id: 'wc', name: 'Туалет' },
  { id: 'corridor', name: 'Коридор' },
];

export interface Calibration {
  /** Two points on the plan raster, in raster pixels. */
  p1: Vec2;
  p2: Vec2;
  lengthMm: number;
  mmPerPx: number;
}

export interface PlanSource {
  kind: 'pdf' | 'image';
  fileName: string;
  /** Original uploaded file (PDF or image). */
  sourceAssetId: string;
  /** Raster of the selected page used as underlay. */
  rasterAssetId: string;
  page: number;
  pageCount: number;
  rasterWidthPx: number;
  rasterHeightPx: number;
  calibration: Calibration | null;
  opacity: number;
  visible: boolean;
}

export interface Wall {
  /** Stable id; walls are aligned with polygon edges: walls[i] is edge polygon[i] → polygon[i+1]. */
  id: string;
  name: string;
}

export interface Opening {
  id: string;
  wallId: string;
  kind: 'door' | 'window';
  /** Distance from the wall's local u=0 (left end seen from inside the room), mm. */
  offsetMm: number;
  widthMm: number;
  bottomMm: number;
  heightMm: number;
  /** True while the height is an editable assumption not confirmed by the drawing. */
  heightAssumed: boolean;
}

export type SurfaceId = 'floor' | string; // 'floor' or a wall id

export interface Zone {
  id: string;
  name: string;
  surfaceId: SurfaceId;
  kind: 'full' | 'rect' | 'polygon';
  /** Zone outline in surface-local mm (u, v). For 'full' this is the surface outline at creation time. */
  polygonMm: Vec2[];
  createdAt: number;
}

export interface Room {
  id: RoomId;
  name: string;
  /** Plan contour in mm (x right, y down as on the drawing). Empty until traced by the user. */
  polygonMm: Vec2[];
  /** Contour confirmed by the user → 3D is built. */
  confirmed: boolean;
  heightMm: number;
  walls: Wall[];
  openings: Opening[];
  zones: Zone[];
}

export type Finish = 'matte' | 'satin' | 'gloss';

export interface Material {
  id: string;
  name: string;
  assetId: string;
  fileName: string;
  imageWidthPx: number;
  imageHeightPx: number;
  /** Physical size of one tile as the unrotated image shows it. */
  widthMm: number;
  heightMm: number;
  defaultRotationDeg: TileRotation;
  finish: Finish;
  roughness: number;
}

export interface Assignment {
  zoneId: string;
  materialId: string;
  rotationDeg: TileRotation;
  groutMm: number;
  groutColor: string;
  originMm: Vec2;
  anchor: LayoutAnchor;
  gridAngleDeg: number;
  rowOffset: RowOffset;
}

export interface CameraPreset {
  id: string;
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface RenderSettings {
  exposure: number;
  sunIntensity: number;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  ceilingLightIntensity: number;
  ambientIntensity: number;
  wallColor: string;
  ceilingColor: string;
  floorBaseColor: string;
  showCeiling: boolean;
  hiddenWallIds: string[];
  outputWidth: number;
  outputHeight: number;
  maxSamples: number;
}

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  unit: 'mm';
  ceilingHeightMm: number;
  plan: PlanSource | null;
  rooms: Room[];
  materials: Material[];
  assignments: Assignment[];
  cameras: CameraPreset[];
  render: RenderSettings;
  createdAt: number;
  updatedAt: number;
}
