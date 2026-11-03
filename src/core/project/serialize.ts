import { defaultRenderSettings } from './defaults';
import { SCHEMA_VERSION, type Project } from './types';

/** Migrates any stored project JSON to the current schema. Throws on unknown future versions. */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new Error('Файл проекта повреждён.');
  const p = raw as Partial<Project> & { schemaVersion?: number };
  if (typeof p.schemaVersion !== 'number') throw new Error('В проекте нет schemaVersion.');
  if (p.schemaVersion > SCHEMA_VERSION) throw new Error(`Проект создан более новой версией (schema ${p.schemaVersion}).`);
  // schema 1 is current; fill optional fields defensively.
  return {
    ...(p as Project),
    render: { ...defaultRenderSettings(), ...(p.render ?? {}) },
    cameras: p.cameras ?? [],
    assignments: p.assignments ?? [],
    materials: p.materials ?? [],
  };
}

/** Collects every asset id referenced by the project (for export/GC). */
export function referencedAssetIds(p: Project): string[] {
  const ids = new Set<string>();
  if (p.plan) {
    ids.add(p.plan.sourceAssetId);
    ids.add(p.plan.rasterAssetId);
  }
  p.materials.forEach((m) => ids.add(m.assetId));
  return [...ids];
}

/** JSON without any runtime-only data; asserts no blob:/absolute file paths leaked in. */
export function serializeProject(p: Project): string {
  const json = JSON.stringify(p);
  if (/"blob:|"file:\/\//.test(json)) throw new Error('Проект содержит временные URL — сериализация запрещена.');
  return json;
}
