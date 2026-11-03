import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project } from '../core/project/types';
import { migrateProject, serializeProject } from '../core/project/serialize';

export interface StoredAsset {
  id: string;
  blob: Blob;
  mime: string;
  name: string;
}

interface TileStudioDB extends DBSchema {
  projects: { key: string; value: { id: string; name: string; updatedAt: number; json: string } };
  assets: { key: string; value: StoredAsset };
  meta: { key: string; value: string };
}

let dbPromise: Promise<IDBPDatabase<TileStudioDB>> | null = null;

function db() {
  dbPromise ??= openDB<TileStudioDB>('tile-studio', 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('assets', { keyPath: 'id' });
      d.createObjectStore('meta');
    },
  });
  return dbPromise;
}

export async function saveProject(p: Project): Promise<void> {
  const d = await db();
  const tx = d.transaction(['projects', 'meta'], 'readwrite');
  await tx.objectStore('projects').put({ id: p.id, name: p.name, updatedAt: p.updatedAt, json: serializeProject(p) });
  await tx.objectStore('meta').put(p.id, 'lastProjectId');
  await tx.done;
}

export async function loadProject(id: string): Promise<Project | null> {
  const rec = await (await db()).get('projects', id);
  return rec ? migrateProject(JSON.parse(rec.json)) : null;
}

export async function loadLastProject(): Promise<Project | null> {
  const id = await (await db()).get('meta', 'lastProjectId');
  return id ? loadProject(id) : null;
}

export async function listProjects() {
  const all = await (await db()).getAll('projects');
  return all.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string) {
  await (await db()).delete('projects', id);
}

export async function putAsset(a: StoredAsset): Promise<void> {
  await (await db()).put('assets', a);
}

export async function getAsset(id: string): Promise<StoredAsset | undefined> {
  return (await db()).get('assets', id);
}
