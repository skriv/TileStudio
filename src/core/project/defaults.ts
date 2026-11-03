import { newId } from './ids';
import { DEFAULT_CEILING_MM, PILOT_ROOMS, SCHEMA_VERSION, type Assignment, type Project, type RenderSettings } from './types';

export function defaultRenderSettings(): RenderSettings {
  return {
    exposure: 1,
    sunIntensity: 2.5,
    sunAzimuthDeg: 250,
    sunElevationDeg: 35,
    ceilingLightIntensity: 1,
    ambientIntensity: 0.35,
    wallColor: '#ece9e4',
    ceilingColor: '#f6f5f2',
    floorBaseColor: '#bdb7ae',
    showCeiling: true,
    hiddenWallIds: [],
    outputWidth: 1920,
    outputHeight: 1080,
    maxSamples: 256,
  };
}

export function createEmptyProject(name = 'Кухня / Туалет / Коридор'): Project {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('prj'),
    name,
    unit: 'mm',
    ceilingHeightMm: DEFAULT_CEILING_MM,
    plan: null,
    rooms: PILOT_ROOMS.map((r) => ({
      id: r.id,
      name: r.name,
      polygonMm: [],
      confirmed: false,
      heightMm: DEFAULT_CEILING_MM,
      walls: [],
      openings: [],
      zones: [],
    })),
    materials: [],
    assignments: [],
    cameras: [],
    render: defaultRenderSettings(),
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultAssignment(zoneId: string, materialId: string, rotationDeg: Assignment['rotationDeg']): Assignment {
  return {
    zoneId,
    materialId,
    rotationDeg,
    groutMm: 2,
    groutColor: '#9a9893',
    originMm: [0, 0],
    anchor: 'origin',
    gridAngleDeg: 0,
    rowOffset: 'none',
  };
}
