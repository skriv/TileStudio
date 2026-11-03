import { zoneRegion } from '../../core/geometry/room';
import type { MultiPolygon } from '../../core/geometry/polygon';
import { computeTileLayout, validateTileInput, type TileLayoutResult } from '../../core/tiling/layout';
import type { Assignment, Material, Project, Room, Zone } from '../../core/project/types';

export interface ZoneLayout {
  region: MultiPolygon;
  assignment: Assignment | null;
  material: Material | null;
  layout: TileLayoutResult | null;
  error: string | null;
}

const cache = new Map<string, ZoneLayout>();

/** Computes (and memoises) the exact tile layout for one zone. Grout colour is not part of the key: it never affects geometry. */
export function resolveZoneLayout(project: Project, room: Room, zone: Zone): ZoneLayout {
  const assignment = project.assignments.find((a) => a.zoneId === zone.id) ?? null;
  const material = assignment ? (project.materials.find((m) => m.id === assignment.materialId) ?? null) : null;
  const sameSurface = room.zones.filter((z) => z.surfaceId === zone.surfaceId);
  const key = JSON.stringify([
    room.polygonMm,
    room.heightMm,
    room.walls.map((w) => w.id),
    room.openings.filter((o) => o.wallId === zone.surfaceId),
    sameSurface.map((z) => [z.id, z.polygonMm]),
    zone.id,
    assignment && { ...assignment, groutColor: undefined },
    material && [material.widthMm, material.heightMm],
  ]);
  const hit = cache.get(key);
  if (hit) return { ...hit, assignment, material };

  const region = zoneRegion(room, zone);
  let layout: TileLayoutResult | null = null;
  let error: string | null = null;
  if (assignment && !material) error = 'Материал назначения удалён.';
  if (assignment && material) {
    const input = {
      region,
      tileWidthMm: material.widthMm,
      tileHeightMm: material.heightMm,
      rotationDeg: assignment.rotationDeg,
      groutMm: assignment.groutMm,
      originMm: assignment.originMm,
      anchor: assignment.anchor,
      gridAngleDeg: assignment.gridAngleDeg,
      rowOffset: assignment.rowOffset,
    };
    error = validateTileInput(input);
    if (!error) {
      try {
        layout = computeTileLayout(input);
      } catch (e) {
        error = (e as Error).message;
      }
    }
  }
  const res: ZoneLayout = { region, assignment, material, layout, error };
  if (cache.size > 500) cache.clear();
  cache.set(key, res);
  return res;
}
