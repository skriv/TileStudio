import { create } from 'zustand';
import type { Vec2 } from '../core/geometry/polygon';
import { dist } from '../core/geometry/polygon';
import { surfaceOutline, syncWalls, validateContour } from '../core/geometry/room';
import { createEmptyProject, defaultAssignment } from '../core/project/defaults';
import { newId } from '../core/project/ids';
import type {
  Assignment,
  CameraPreset,
  Material,
  Opening,
  Project,
  RenderSettings,
  Room,
  RoomId,
  SurfaceId,
  Zone,
} from '../core/project/types';
import { getAsset, loadLastProject, loadProject, putAsset, saveProject, type StoredAsset } from '../storage/db';
import { exportProjectZip, importProjectZip } from '../storage/archive';
import { imageSize, rasterizePdfPage } from '../features/plan-editor/pdf';
import { pilotCalibrationPoints, pilotMmPerPx, pilotRooms } from '../features/plan-editor/pilotGeometry';

export type ViewMode = 'plan' | 'surface' | '3d' | 'render';
export type PlanTool = 'select' | 'calibrate' | 'trace' | 'measure';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface Selection {
  roomId: RoomId | null;
  surfaceId: SurfaceId | null;
  zoneId: string | null;
  materialId: string | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

interface State {
  project: Project;
  assetUrls: Record<string, string>;
  selection: Selection;
  view: ViewMode;
  planTool: PlanTool;
  zoneEditMode: boolean;
  saveState: SaveState;
  past: Project[];
  future: Project[];
  toasts: Toast[];
  busy: string | null;
  ready: boolean;
}

const HISTORY_LIMIT = 100;

export const useStore = create<State>(() => ({
  project: createEmptyProject(),
  assetUrls: {},
  selection: { roomId: 'kitchen', surfaceId: null, zoneId: null, materialId: null },
  view: 'plan',
  planTool: 'select',
  zoneEditMode: false,
  saveState: 'saved',
  past: [],
  future: [],
  toasts: [],
  busy: null,
  ready: false,
}));

const set = useStore.setState;
const get = useStore.getState;

// ---------- helpers ----------

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: ++toastSeq, kind, text };
  set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === 'error' ? 7000 : 3500);
}

function commit(fn: (p: Project) => Project, history = true) {
  const prev = get().project;
  const next = { ...fn(prev), updatedAt: Date.now() };
  set((s) => ({
    project: next,
    past: history ? [...s.past, prev].slice(-HISTORY_LIMIT) : s.past,
    future: history ? [] : s.future,
    saveState: 'dirty',
  }));
}

/** True when two openings on one wall cover the same span. */
function sameHole(a: { offsetMm: number; widthMm: number }, b: { offsetMm: number; widthMm: number }): boolean {
  return Math.abs(a.offsetMm - b.offsetMm) < 30 && Math.abs(a.widthMm - b.widthMm) < 30;
}

/**
 * Measured door holes are empty openings, one on each face of a shared wall.
 * A saved project can be missing a face (the toilet door was cut only from the toilet side).
 * Add any plan opening that is not already on that wall. Nothing here builds a door leaf.
 */
function withDoorOpenings(p: Project): Project {
  const spec = pilotRooms();
  let changed = false;
  const rooms = p.rooms.map((room) => {
    const g = spec.find((s) => s.id === room.id);
    if (!g || room.walls.length !== g.polygonMm.length) return room;
    const extra = g.openings
      .filter((o) => o.kind === 'door' && room.walls[o.edge])
      .filter((o) => !room.openings.some((e) => e.wallId === room.walls[o.edge].id && sameHole(e, o)))
      .map((o) => ({
        id: newId('op'),
        wallId: room.walls[o.edge].id,
        kind: 'door' as const,
        offsetMm: o.offsetMm,
        widthMm: o.widthMm,
        bottomMm: o.bottomMm,
        heightMm: o.heightMm,
        heightAssumed: o.heightAssumed,
      }));
    if (!extra.length) return room;
    changed = true;
    return { ...room, openings: [...room.openings, ...extra] };
  });
  return changed ? { ...p, rooms } : p;
}

function mapRoom(p: Project, roomId: RoomId, fn: (r: Room) => Room): Project {
  return { ...p, rooms: p.rooms.map((r) => (r.id === roomId ? fn(r) : r)) };
}

export function getRoom(p: Project, roomId: RoomId | null): Room | undefined {
  return roomId ? p.rooms.find((r) => r.id === roomId) : undefined;
}

export function findZone(p: Project, zoneId: string | null): { room: Room; zone: Zone } | undefined {
  if (!zoneId) return undefined;
  for (const room of p.rooms) {
    const zone = room.zones.find((z) => z.id === zoneId);
    if (zone) return { room, zone };
  }
  return undefined;
}

async function registerAsset(a: StoredAsset) {
  await putAsset(a);
  const url = URL.createObjectURL(a.blob);
  set((s) => ({ assetUrls: { ...s.assetUrls, [a.id]: url } }));
}

async function hydrateAssets(p: Project) {
  const ids = new Set<string>();
  if (p.plan) {
    ids.add(p.plan.rasterAssetId);
    ids.add(p.plan.sourceAssetId);
  }
  p.materials.forEach((m) => ids.add(m.assetId));
  const urls: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const a = await getAsset(id);
    if (a) urls[id] = URL.createObjectURL(a.blob);
    else missing.push(id);
  }
  Object.values(get().assetUrls).forEach((u) => URL.revokeObjectURL(u));
  set({ assetUrls: urls });
  if (missing.length) toast(`Не найдены ${missing.length} файл(ов) проекта в хранилище браузера.`, 'error');
}

// ---------- autosave ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (!s.ready || s.project === prev.project) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    set({ saveState: 'saving' });
    try {
      await saveProject(get().project);
      set({ saveState: 'saved' });
    } catch (e) {
      console.error(e);
      set({ saveState: 'error' });
      toast(`Ошибка сохранения: ${(e as Error).message}`, 'error');
    }
  }, 700);
});

export async function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  set({ saveState: 'saving' });
  try {
    await saveProject(get().project);
    set({ saveState: 'saved' });
    toast('Проект сохранён', 'ok');
  } catch (e) {
    set({ saveState: 'error' });
    toast(`Ошибка сохранения: ${(e as Error).message}`, 'error');
  }
}

// ---------- lifecycle ----------

let booted = false;
export async function bootstrap() {
  if (booted) return;
  booted = true;
  try {
    const p = await loadLastProject();
    if (p) {
      await hydrateAssets(p);
      const project = withDoorOpenings(p);
      set({ project, ready: true, saveState: 'saved', view: '3d' });
      if (project !== p) void saveProject(project);
      await ensurePilotModel();
      return;
    }
  } catch (e) {
    console.error(e);
    toast(`Не удалось восстановить проект: ${(e as Error).message}`, 'error');
  }
  set({ ready: true });
  await newProject();
}

export async function openStoredProject(id: string) {
  if (saveTimer) await saveProject(get().project);
  const p = await loadProject(id);
  if (!p) return toast('Проект не найден', 'error');
  await hydrateAssets(p);
  const project = withDoorOpenings(p);
  set({
    project,
    past: [],
    future: [],
    saveState: 'saved',
    selection: { roomId: 'kitchen', surfaceId: null, zoneId: null, materialId: null },
    view: '3d',
  });
  await ensurePilotModel();
}

export async function newProject() {
  const p = createEmptyProject();
  set({ project: p, past: [], future: [], selection: { roomId: 'kitchen', surfaceId: null, zoneId: null, materialId: null }, view: 'plan', zoneEditMode: false });
  await saveProject(p);
  try {
    await addPilotMaterials();
  } catch (e) {
    toast(`Пилотные плитки не загружены: ${(e as Error).message}. Положите 280.png и 450.png в public/samples/.`, 'error');
  }
  await ensurePilotModel();
}

/** Adds the original 280.png and 450.png to the library (NOT assigned to any zone). */
export async function addPilotMaterials() {
  const defs = [
    { file: '280.png', name: 'Розовая плитка 285×85', widthMm: 85, heightMm: 285, rot: 90 as const, finish: 'gloss' as const },
    { file: '450.png', name: 'Шахматная плитка 450×450', widthMm: 450, heightMm: 450, rot: 0 as const, finish: 'satin' as const },
  ];
  for (const d of defs) {
    if (get().project.materials.some((m) => m.fileName === d.file)) continue;
    const res = await fetch(`/samples/${d.file}`);
    if (!res.ok) throw new Error(`/samples/${d.file}: HTTP ${res.status}`);
    const blob = await res.blob();
    await addMaterial(blob, d.file, { name: d.name, widthMm: d.widthMm, heightMm: d.heightMm, defaultRotationDeg: d.rot, finish: d.finish }, false);
  }
}

export async function loadPilotPlan() {
  const res = await fetch('/samples/room_scheme.pdf');
  if (!res.ok) {
    toast('room_scheme.pdf не найден в public/samples/', 'error');
    return;
  }
  const blob = await res.blob();
  await importPlan(new File([blob], 'room_scheme.pdf', { type: 'application/pdf' }));
}

// ---------- plan ----------

export async function importPlan(file: File, page = 1) {
  set({ busy: 'Импорт плана…' });
  try {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const sourceId = newId('asset');
    await registerAsset({ id: sourceId, blob: file, mime: file.type || (isPdf ? 'application/pdf' : 'image/png'), name: file.name });
    let raster: Blob;
    let w: number;
    let h: number;
    let pageCount = 1;
    if (isPdf) {
      const r = await rasterizePdfPage(await file.arrayBuffer(), page);
      raster = r.blob;
      w = r.width;
      h = r.height;
      pageCount = r.pageCount;
    } else {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      raster = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
      w = c.width;
      h = c.height;
    }
    const rasterId = newId('asset');
    await registerAsset({ id: rasterId, blob: raster, mime: 'image/png', name: `${file.name}#page${page}.png` });
    const hadGeometry = get().project.rooms.some((r) => r.polygonMm.length);
    commit((p) => ({
      ...p,
      plan: {
        kind: isPdf ? 'pdf' : 'image',
        fileName: file.name,
        sourceAssetId: sourceId,
        rasterAssetId: rasterId,
        page,
        pageCount,
        rasterWidthPx: w,
        rasterHeightPx: h,
        calibration: null,
        opacity: 0.85,
        visible: true,
      },
    }));
    set({ view: 'plan', planTool: 'calibrate' });
    toast(hadGeometry ? 'План заменён. Существующие контуры сохранены в mm — проверьте их положение после калибровки.' : 'План загружен. Укажите известный размер: два клика по концам размерной линии.');
  } catch (e) {
    console.error(e);
    toast(`Ошибка импорта плана: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

export async function setPlanPage(page: number) {
  const plan = get().project.plan;
  if (!plan || plan.kind !== 'pdf') return;
  const src = await getAsset(plan.sourceAssetId);
  if (!src) return;
  await importPlan(new File([src.blob], plan.fileName, { type: 'application/pdf' }), page);
}

export function updatePlan(patch: Partial<NonNullable<Project['plan']>>) {
  commit((p) => (p.plan ? { ...p, plan: { ...p.plan, ...patch } } : p), false);
}

export function setCalibration(p1: Vec2, p2: Vec2, lengthMm: number) {
  const px = dist(p1, p2);
  if (!(px > 2) || !(lengthMm > 0)) {
    toast('Калибровка: отрезок слишком короткий или длина не задана.', 'error');
    return;
  }
  const mmPerPx = lengthMm / px;
  commit((p) => {
    if (!p.plan) return p;
    const old = p.plan.calibration?.mmPerPx;
    const k = old ? mmPerPx / old : 1;
    const rooms =
      old && k !== 1
        ? p.rooms.map((r) => ({ ...r, polygonMm: r.polygonMm.map(([x, y]) => [x * k, y * k] as Vec2) }))
        : p.rooms;
    return { ...p, rooms, plan: { ...p.plan, calibration: { p1, p2, lengthMm, mmPerPx } } };
  });
  toast(`Масштаб: ${mmPerPx.toFixed(4)} мм/пикс`, 'ok');
  set({ planTool: 'select' });
}

// ---------- rooms ----------

export function setRoomPolygon(roomId: RoomId, poly: Vec2[], history = true) {
  commit((p) => {
    const room = getRoom(p, roomId);
    if (!room) return p;
    const { walls, removedIds } = syncWalls(room.polygonMm, room.walls, poly);
    const removed = new Set(removedIds);
    const keptZones = room.zones.filter((z) => z.surfaceId === 'floor' || !removed.has(z.surfaceId));
    const droppedZoneIds = new Set(room.zones.filter((z) => !keptZones.includes(z)).map((z) => z.id));
    if (droppedZoneIds.size) toast(`Удалено зон на изменённых стенах: ${droppedZoneIds.size}`, 'info');
    return {
      ...mapRoom(p, roomId, (r) => ({
        ...r,
        polygonMm: poly,
        walls,
        openings: r.openings.filter((o) => !removed.has(o.wallId)),
        zones: keptZones,
      })),
      assignments: p.assignments.filter((a) => !droppedZoneIds.has(a.zoneId)),
    };
  }, history);
}

/** Builds Kitchen, Toilet and Corridor from the measured plan. Keeps zones whose wall still exists. */
export function installPilotRooms() {
  const spec = pilotRooms();
  commit((p) => {
    let project = p;
    for (const g of spec) {
      const room = getRoom(project, g.id);
      if (!room) continue;
      const { walls, removedIds } = syncWalls(room.polygonMm, room.walls, g.polygonMm);
      const removed = new Set(removedIds);
      const zones = room.zones.filter((z) => z.surfaceId === 'floor' || !removed.has(z.surfaceId));
      const dropped = new Set(room.zones.filter((z) => !zones.includes(z)).map((z) => z.id));
      const openings: Opening[] = g.openings.map((o) => ({
        id: newId('op'),
        wallId: walls[o.edge]?.id ?? '',
        kind: o.kind,
        offsetMm: o.offsetMm,
        widthMm: o.widthMm,
        bottomMm: o.bottomMm,
        heightMm: o.heightMm,
        heightAssumed: o.heightAssumed,
      }));
      project = {
        ...mapRoom(project, g.id, (r) => ({ ...r, polygonMm: g.polygonMm, walls, openings, zones, confirmed: true, heightMm: r.heightMm || 2400 })),
        assignments: project.assignments.filter((a) => !dropped.has(a.zoneId)),
      };
    }
    if (project.plan && project.plan.rasterWidthPx > 0) {
      const cal = pilotCalibrationPoints(project.plan.rasterWidthPx);
      project = { ...project, plan: { ...project.plan, visible: true, calibration: { ...cal, mmPerPx: pilotMmPerPx(project.plan.rasterWidthPx) } } };
    }
    return project;
  }, false);
  set((s) => ({ view: '3d', selection: { ...s.selection, roomId: s.selection.roomId ?? 'kitchen', surfaceId: null, zoneId: null } }));
}

/** Loads the sample plan if needed and builds the three rooms unless they are already confirmed. */
export async function ensurePilotModel() {
  if (!get().project.plan) await loadPilotPlan();
  const missing = get().project.rooms.some((r) => !r.confirmed || r.polygonMm.length < 3);
  if (missing) {
    installPilotRooms();
    toast('Кухня, туалет и коридор построены по линиям плана.', 'ok');
  } else {
    set({ view: '3d' });
  }
}

export function confirmRoom(roomId: RoomId, confirmed: boolean) {
  const room = getRoom(get().project, roomId);
  if (!room) return;
  if (confirmed) {
    const err = validateContour(room.polygonMm);
    if (err) {
      toast(`${room.name}: ${err}`, 'error');
      return;
    }
  }
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, confirmed })));
  if (confirmed) toast(`${room.name}: контур подтверждён, 3D построено (высота ${room.heightMm} мм).`, 'ok');
}

export function clearRoom(roomId: RoomId) {
  commit((p) => {
    const room = getRoom(p, roomId);
    const zoneIds = new Set(room?.zones.map((z) => z.id));
    return {
      ...mapRoom(p, roomId, (r) => ({ ...r, polygonMm: [], walls: [], openings: [], zones: [], confirmed: false })),
      assignments: p.assignments.filter((a) => !zoneIds.has(a.zoneId)),
    };
  });
}

export function setRoomHeight(roomId: RoomId, heightMm: number) {
  if (!(heightMm > 0)) return;
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, heightMm })));
}

export function renameWall(roomId: RoomId, wallId: string, name: string) {
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, walls: r.walls.map((w) => (w.id === wallId ? { ...w, name } : w)) })));
}

// ---------- openings ----------

export function addOpening(roomId: RoomId, wallId: string, kind: Opening['kind']) {
  const o: Opening =
    kind === 'window'
      ? { id: newId('op'), wallId, kind, offsetMm: 300, widthMm: 1000, bottomMm: 1000, heightMm: 1000, heightAssumed: false }
      : { id: newId('op'), wallId, kind, offsetMm: 100, widthMm: 800, bottomMm: 0, heightMm: 2100, heightAssumed: true };
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, openings: [...r.openings, o] })));
  return o.id;
}

export function updateOpening(roomId: RoomId, id: string, patch: Partial<Opening>) {
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, openings: r.openings.map((o) => (o.id === id ? { ...o, ...patch } : o)) })));
}

export function removeOpening(roomId: RoomId, id: string) {
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, openings: r.openings.filter((o) => o.id !== id) })));
}

// ---------- zones ----------

export function createZone(roomId: RoomId, surfaceId: SurfaceId, kind: Zone['kind'], polygonMm: Vec2[], name?: string): string | null {
  const room = getRoom(get().project, roomId);
  if (!room) return null;
  let poly = polygonMm;
  if (kind === 'full') poly = surfaceOutline(room, surfaceId)[0]?.outer ?? [];
  const err = validateContour(poly);
  if (err) {
    toast(`Зона: ${err}`, 'error');
    return null;
  }
  const z: Zone = {
    id: newId('zone'),
    name: name || `Зона ${room.zones.length + 1}`,
    surfaceId,
    kind,
    polygonMm: poly.map(([x, y]) => [x, y] as Vec2),
    createdAt: Date.now(),
  };
  commit((p) => mapRoom(p, roomId, (r) => ({ ...r, zones: [...r.zones, z] })));
  set((s) => ({ selection: { ...s.selection, roomId, surfaceId, zoneId: z.id } }));
  return z.id;
}

function requireZoneEdit(): boolean {
  if (!get().zoneEditMode) {
    toast('Границы зон зафиксированы. Включите «Редактировать зоны».', 'error');
    return false;
  }
  return true;
}

export function updateZoneGeometry(zoneId: string, polygonMm: Vec2[]) {
  if (!requireZoneEdit()) return;
  const err = validateContour(polygonMm);
  if (err) {
    toast(`Зона: ${err}`, 'error');
    return;
  }
  commit((p) => ({
    ...p,
    rooms: p.rooms.map((r) => ({ ...r, zones: r.zones.map((z) => (z.id === zoneId ? { ...z, polygonMm, kind: z.kind === 'full' ? 'polygon' : z.kind } : z)) })),
  }));
}

export function renameZone(zoneId: string, name: string) {
  commit((p) => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, zones: r.zones.map((z) => (z.id === zoneId ? { ...z, name } : z)) })) }));
}

export function deleteZone(zoneId: string) {
  if (!requireZoneEdit()) return;
  commit((p) => ({
    ...p,
    rooms: p.rooms.map((r) => ({ ...r, zones: r.zones.filter((z) => z.id !== zoneId) })),
    assignments: p.assignments.filter((a) => a.zoneId !== zoneId),
  }));
  set((s) => ({ selection: { ...s.selection, zoneId: null } }));
}

export function moveZoneOrder(zoneId: string, delta: -1 | 1) {
  if (!requireZoneEdit()) return;
  commit((p) => ({
    ...p,
    rooms: p.rooms.map((r) => {
      const i = r.zones.findIndex((z) => z.id === zoneId);
      if (i < 0) return r;
      const zs = [...r.zones];
      const surf = zs[i].surfaceId;
      let j = i + delta;
      while (j >= 0 && j < zs.length && zs[j].surfaceId !== surf) j += delta;
      if (j < 0 || j >= zs.length) return r;
      [zs[i], zs[j]] = [zs[j], zs[i]];
      return { ...r, zones: zs };
    }),
  }));
}

// ---------- materials & assignments ----------

export async function addMaterial(
  blob: Blob,
  fileName: string,
  opts: Pick<Material, 'name' | 'widthMm' | 'heightMm' | 'defaultRotationDeg'> & Partial<Pick<Material, 'finish'>>,
  history = true,
): Promise<string> {
  const { width, height } = await imageSize(blob);
  const assetId = newId('asset');
  await registerAsset({ id: assetId, blob, mime: blob.type || 'image/png', name: fileName });
  const finish = opts.finish ?? 'satin';
  const m: Material = {
    id: newId('mat'),
    name: opts.name,
    assetId,
    fileName,
    imageWidthPx: width,
    imageHeightPx: height,
    widthMm: opts.widthMm,
    heightMm: opts.heightMm,
    defaultRotationDeg: opts.defaultRotationDeg,
    finish,
    roughness: finishRoughness(finish),
  };
  commit((p) => ({ ...p, materials: [...p.materials, m] }), history);
  return m.id;
}

export function finishRoughness(f: Material['finish']): number {
  return f === 'gloss' ? 0.08 : f === 'satin' ? 0.32 : 0.65;
}

export function updateMaterial(id: string, patch: Partial<Material>) {
  commit((p) => ({ ...p, materials: p.materials.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
}

export function removeMaterial(id: string) {
  commit((p) => ({ ...p, materials: p.materials.filter((m) => m.id !== id), assignments: p.assignments.filter((a) => a.materialId !== id) }));
  set((s) => ({ selection: { ...s.selection, materialId: s.selection.materialId === id ? null : s.selection.materialId } }));
}

export function assignMaterial(zoneId: string, materialId: string) {
  const p = get().project;
  const m = p.materials.find((x) => x.id === materialId);
  if (!m) return;
  if (!(m.widthMm > 0 && m.heightMm > 0)) {
    toast('У плитки не задан физический размер — назначение невозможно.', 'error');
    return;
  }
  commit((pr) => {
    const existing = pr.assignments.find((a) => a.zoneId === zoneId);
    const next: Assignment = existing
      ? { ...existing, materialId, rotationDeg: m.defaultRotationDeg }
      : defaultAssignment(zoneId, materialId, m.defaultRotationDeg);
    return { ...pr, assignments: [...pr.assignments.filter((a) => a.zoneId !== zoneId), next] };
  });
}

export function updateAssignment(zoneId: string, patch: Partial<Assignment>) {
  commit((p) => ({ ...p, assignments: p.assignments.map((a) => (a.zoneId === zoneId ? { ...a, ...patch } : a)) }));
}

/** Rotates every zone that already uses this tile, and remembers the angle for the next assignment. */
export function setMaterialRotation(materialId: string, rotationDeg: Assignment['rotationDeg']) {
  commit((p) => ({
    ...p,
    materials: p.materials.map((m) => (m.id === materialId ? { ...m, defaultRotationDeg: rotationDeg } : m)),
    assignments: p.assignments.map((a) => (a.materialId === materialId ? { ...a, rotationDeg } : a)),
  }));
  set({ view: '3d' });
}

export function clearAssignment(zoneId: string) {
  commit((p) => ({ ...p, assignments: p.assignments.filter((a) => a.zoneId !== zoneId) }));
}

// ---------- render / camera ----------

export function updateRender(patch: Partial<RenderSettings>) {
  commit((p) => ({ ...p, render: { ...p.render, ...patch } }), false);
}

export function saveCameraPreset(c: Omit<CameraPreset, 'id' | 'name'>, name?: string) {
  commit((p) => ({ ...p, cameras: [...p.cameras, { ...c, id: newId('cam'), name: name ?? `Ракурс ${p.cameras.length + 1}` }] }), false);
}

export function removeCameraPreset(id: string) {
  commit((p) => ({ ...p, cameras: p.cameras.filter((c) => c.id !== id) }), false);
}

// ---------- selection / ui ----------

export function select(patch: Partial<Selection>) {
  set((s) => ({ selection: { ...s.selection, ...patch } }));
}

export function selectZone(zoneId: string | null) {
  const f = findZone(get().project, zoneId);
  if (f) set((s) => ({ selection: { ...s.selection, roomId: f.room.id, surfaceId: f.zone.surfaceId, zoneId } }));
  else select({ zoneId: null });
}

export function setView(view: ViewMode) {
  set({ view });
}

export function setPlanTool(planTool: PlanTool) {
  set({ planTool });
}

export function setZoneEditMode(on: boolean) {
  set({ zoneEditMode: on });
}

export function undo() {
  const { past, project, future } = get();
  const prev = past[past.length - 1];
  if (!prev) return;
  set({ project: prev, past: past.slice(0, -1), future: [project, ...future], saveState: 'dirty' });
}

export function redo() {
  const { past, project, future } = get();
  const next = future[0];
  if (!next) return;
  set({ project: next, past: [...past, project], future: future.slice(1), saveState: 'dirty' });
}

// ---------- import/export ----------

export async function exportProjectFile() {
  const p = get().project;
  const blob = await exportProjectZip(p, getAsset);
  downloadBlob(blob, `${p.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.tilestudio.zip`);
}

export async function importProjectFile(file: File) {
  set({ busy: 'Открытие проекта…' });
  try {
    const { project, assets } = await importProjectZip(file);
    for (const a of assets) await putAsset(a);
    await saveProject(project);
    await hydrateAssets(project);
    set({ project, past: [], future: [], saveState: 'saved', selection: { roomId: 'kitchen', surfaceId: null, zoneId: null, materialId: null } });
    toast('Проект открыт', 'ok');
  } catch (e) {
    toast(`Не удалось открыть проект: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
