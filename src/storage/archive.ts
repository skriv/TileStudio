import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Project } from '../core/project/types';
import { migrateProject, referencedAssetIds, serializeProject } from '../core/project/serialize';
import type { StoredAsset } from './db';

interface Manifest {
  format: 'tile-studio-project';
  version: 1;
  assets: { id: string; path: string; mime: string; name: string }[];
}

/** Portable project file: ZIP with project.json, manifest.json and original binary assets. */
export async function exportProjectZip(project: Project, getAsset: (id: string) => Promise<StoredAsset | undefined>): Promise<Blob> {
  const files: Zippable = { 'project.json': strToU8(serializeProject(project)) };
  const manifest: Manifest = { format: 'tile-studio-project', version: 1, assets: [] };
  for (const id of referencedAssetIds(project)) {
    const a = await getAsset(id);
    if (!a) throw new Error(`Нет данных ресурса ${id}`);
    const path = `assets/${id}`;
    files[path] = [new Uint8Array(await a.blob.arrayBuffer()), { level: 0 }];
    manifest.assets.push({ id, path, mime: a.mime, name: a.name });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const zipped = zipSync(files);
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
}

export async function importProjectZip(file: Blob): Promise<{ project: Project; assets: StoredAsset[] }> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const pj = entries['project.json'];
  const mf = entries['manifest.json'];
  if (!pj || !mf) throw new Error('Это не файл проекта Tile Studio.');
  const manifest = JSON.parse(strFromU8(mf)) as Manifest;
  if (manifest.format !== 'tile-studio-project') throw new Error('Неизвестный формат архива.');
  const project = migrateProject(JSON.parse(strFromU8(pj)));
  const assets: StoredAsset[] = manifest.assets.map((m) => {
    const data = entries[m.path];
    if (!data) throw new Error(`В архиве отсутствует ${m.path}`);
    return { id: m.id, mime: m.mime, name: m.name, blob: new Blob([data.slice().buffer as ArrayBuffer], { type: m.mime }) };
  });
  return { project, assets };
}
