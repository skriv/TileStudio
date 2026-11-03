import * as THREE from 'three';
import earcut from 'earcut';
import { bboxOfRing, type MultiPolygon, type Vec2 } from '../../core/geometry/polygon';
import { floorFrame, mmToM, uncoveredRegion, wallFrames, type WallFrame } from '../../core/geometry/room';
import type { Project, Room, SurfaceId } from '../../core/project/types';
import { resolveZoneLayout } from './zoneLayout';

export interface PickInfo {
  roomId: Room['id'];
  surfaceId: SurfaceId | 'ceiling';
  zoneId: string | null;
}

export interface BuildOptions {
  /** Loaded tile textures by asset id. Zones whose texture is not ready are drawn without tiles. */
  textures: Map<string, THREE.Texture>;
  highlightZoneId: string | null;
  highlightSurface: { roomId: Room['id']; surfaceId: SurfaceId } | null;
  mode: 'preview' | 'pathtrace';
  /**
   * Camera position (world, metres). Walls and ceilings seen from their outer side are omitted,
   * matching what back-face culling shows in the preview while the path tracer uses double-sided walls.
   */
  cutawayFrom?: THREE.Vector3;
}

export interface BuiltScene {
  group: THREE.Group;
  bounds: THREE.Box3;
  stats: { tiles: number; full: number; cut: number };
  dispose: () => void;
}

/** Offsets along the surface normal (mm), so layers never z-fight and never move tiles in-plane. */
const OFFSET_ZONE_BASE = 0.6;
const OFFSET_TILE = 1.6;
const OFFSET_HIGHLIGHT = 3;
const REVEAL_DEPTH_MM = 160;

export type SurfaceMap = (u: number, v: number, offsetMm: number) => THREE.Vector3;

export function wallMap(f: WallFrame): SurfaceMap {
  return (u, v, off) => {
    const x = f.start[0] + f.dir[0] * u + f.inward[0] * off;
    const y = f.start[1] + f.dir[1] * u + f.inward[1] * off;
    return new THREE.Vector3(mmToM(x), mmToM(v), mmToM(y));
  };
}

export function floorMap(room: Room): SurfaceMap {
  const fr = floorFrame(room);
  return (u, v, off) => {
    const [x, y] = fr.toPlan([u, v]);
    return new THREE.Vector3(mmToM(x), mmToM(off), mmToM(y));
  };
}

/** Triangulated surface mesh; every triangle is oriented so its face normal matches `normal`. */
function polygonsGeometry(
  mp: MultiPolygon,
  map: SurfaceMap,
  normal: THREE.Vector3,
  offsetMm: number,
  uvFor?: (p: Vec2) => Vec2,
): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const poly of mp) {
    const flat: number[] = [];
    const holes: number[] = [];
    const pts: Vec2[] = [];
    poly.outer.forEach((p) => {
      flat.push(p[0], p[1]);
      pts.push(p);
    });
    poly.holes.forEach((h) => {
      holes.push(pts.length);
      h.forEach((p) => {
        flat.push(p[0], p[1]);
        pts.push(p);
      });
    });
    const tri = earcut(flat, holes.length ? holes : undefined, 2);
    const base = pos.length / 3;
    for (const p of pts) {
      const w = map(p[0], p[1], offsetMm);
      pos.push(w.x, w.y, w.z);
      const t = uvFor ? uvFor(p) : ([p[0] / 1000, p[1] / 1000] as Vec2);
      uv.push(t[0], t[1]);
    }
    for (let i = 0; i < tri.length; i += 3) idx.push(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
  }
  return finishGeometry(pos, uv, idx, normal);
}

function finishGeometry(pos: number[], uv: number[], idx: number[], normal: THREE.Vector3): THREE.BufferGeometry | null {
  if (!idx.length) return null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromArray(pos, idx[i] * 3);
    b.fromArray(pos, idx[i + 1] * 3);
    c.fromArray(pos, idx[i + 2] * 3);
    const n = b.sub(a).cross(c.sub(a));
    if (n.dot(normal) < 0) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const normals = new Float32Array(pos.length);
  for (let i = 0; i < normals.length; i += 3) {
    normals[i] = normal.x;
    normals[i + 1] = normal.y;
    normals[i + 2] = normal.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(idx);
  return g;
}

function outlineGeometry(mp: MultiPolygon, map: SurfaceMap, offsetMm: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const addRing = (r: Vec2[]) => {
    for (let i = 0; i < r.length; i++) {
      const a = map(r[i][0], r[i][1], offsetMm);
      const b = map(r[(i + 1) % r.length][0], r[(i + 1) % r.length][1], offsetMm);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  mp.forEach((p) => {
    addRing(p.outer);
    p.holes.forEach(addRing);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

export function buildScene(project: Project, opts: BuildOptions): BuiltScene {
  const group = new THREE.Group();
  group.name = 'tile-studio-rooms';
  const disposables: { dispose: () => void }[] = [];
  const stats = { tiles: 0, full: 0, cut: 0 };
  const r = project.render;
  const hidden = new Set(r.hiddenWallIds);
  const pt = opts.mode === 'pathtrace';

  const mat = <T extends THREE.Material>(m: T): T => {
    disposables.push(m);
    return m;
  };
  const geo = (g: THREE.BufferGeometry) => {
    disposables.push(g);
    return g;
  };

  const side = pt ? THREE.DoubleSide : THREE.FrontSide;
  const wallMat = mat(new THREE.MeshStandardMaterial({ color: r.wallColor, roughness: 0.92, side }));
  const ceilMat = mat(new THREE.MeshStandardMaterial({ color: r.ceilingColor, roughness: 0.95, side }));
  const floorMat = mat(new THREE.MeshStandardMaterial({ color: r.floorBaseColor, roughness: 0.85, side }));
  const zoneNeutralWall = mat(new THREE.MeshStandardMaterial({ color: r.wallColor, roughness: 0.9, side }));
  const zoneNeutralFloor = mat(new THREE.MeshStandardMaterial({ color: r.floorBaseColor, roughness: 0.85, side }));
  const revealMat = mat(new THREE.MeshStandardMaterial({ color: r.wallColor, roughness: 0.92, side: THREE.DoubleSide }));
  const frameMat = mat(new THREE.MeshStandardMaterial({ color: '#f3f3f1', roughness: 0.45, side: THREE.DoubleSide }));
  const highlightMat = mat(new THREE.LineBasicMaterial({ color: '#ff7a1a', depthTest: true }));
  const surfaceHlMat = mat(new THREE.LineBasicMaterial({ color: '#2f80ed', depthTest: true }));
  const tileMats = new Map<string, THREE.MeshPhysicalMaterial>();
  const groutMats = new Map<string, THREE.MeshStandardMaterial>();

  const addMesh = (g: THREE.BufferGeometry | null, m: THREE.Material, pick: PickInfo, name: string, shadows = true) => {
    if (!g) return;
    const mesh = new THREE.Mesh(geo(g), m);
    mesh.name = name;
    mesh.userData.pick = pick;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const bounds = new THREE.Box3();

  for (const room of project.rooms) {
    if (!room.confirmed || room.polygonMm.length < 3) continue;
    const H = room.heightMm;
    const bb = bboxOfRing(room.polygonMm);
    bounds.expandByPoint(new THREE.Vector3(mmToM(bb.minX), 0, mmToM(bb.minY)));
    bounds.expandByPoint(new THREE.Vector3(mmToM(bb.maxX), mmToM(H), mmToM(bb.maxY)));

    const surfaces: { id: SurfaceId; map: SurfaceMap; normal: THREE.Vector3; isFloor: boolean; frame?: WallFrame }[] = [
      { id: 'floor', map: floorMap(room), normal: new THREE.Vector3(0, 1, 0), isFloor: true },
    ];
    for (const f of wallFrames(room)) {
      if (hidden.has(f.wallId)) continue;
      const cam = opts.cutawayFrom;
      if (cam && (cam.x - mmToM(f.start[0])) * f.inward[0] + (cam.z - mmToM(f.start[1])) * f.inward[1] < 0) continue;
      surfaces.push({ id: f.wallId, map: wallMap(f), normal: new THREE.Vector3(f.inward[0], 0, f.inward[1]), isFloor: false, frame: f });
    }

    for (const s of surfaces) {
      const base = uncoveredRegion(room, s.id);
      addMesh(polygonsGeometry(base, s.map, s.normal, 0), s.isFloor ? floorMat : wallMat, { roomId: room.id, surfaceId: s.id, zoneId: null }, `${room.id}:${s.id}:base`);

      for (const zone of room.zones.filter((z) => z.surfaceId === s.id)) {
        const zl = resolveZoneLayout(project, room, zone);
        const pick: PickInfo = { roomId: room.id, surfaceId: s.id, zoneId: zone.id };
        const tex = zl.material ? opts.textures.get(zl.material.assetId) : undefined;
        if (zl.layout && zl.material && zl.assignment && tex) {
          const gKey = zl.assignment.groutColor;
          let groutMat = groutMats.get(gKey);
          if (!groutMat) {
            groutMat = mat(new THREE.MeshStandardMaterial({ color: gKey, roughness: 0.95, side }));
            groutMats.set(gKey, groutMat);
          }
          addMesh(polygonsGeometry(zl.region, s.map, s.normal, OFFSET_ZONE_BASE), groutMat, pick, `zone:${zone.id}:grout`);

          const m = zl.material;
          const mKey = `${m.id}:${m.roughness}`;
          let tileMat = tileMats.get(mKey);
          if (!tileMat) {
            tileMat = mat(
              new THREE.MeshPhysicalMaterial({
                map: tex,
                roughness: m.roughness,
                metalness: 0,
                clearcoat: m.finish === 'gloss' ? 0.6 : m.finish === 'satin' ? 0.15 : 0,
                clearcoatRoughness: 0.12,
                side,
              }),
            );
            tileMats.set(mKey, tileMat);
          }
          const pos: number[] = [];
          const uv: number[] = [];
          const idx: number[] = [];
          for (const t of zl.layout.tiles) {
            const f = t.fragment;
            const baseIdx = pos.length / 3;
            for (let i = 0; i < f.positions.length; i += 2) {
              const w = s.map(f.positions[i], f.positions[i + 1], OFFSET_TILE);
              pos.push(w.x, w.y, w.z);
            }
            uv.push(...f.uvs);
            for (const k of f.indices) idx.push(baseIdx + k);
            stats.tiles++;
            if (t.isFull) stats.full++;
            else stats.cut++;
          }
          addMesh(finishGeometry(pos, uv, idx, s.normal), tileMat, pick, `zone:${zone.id}:tiles`);
        } else {
          addMesh(polygonsGeometry(zl.region, s.map, s.normal, OFFSET_ZONE_BASE), s.isFloor ? zoneNeutralFloor : zoneNeutralWall, pick, `zone:${zone.id}:neutral`);
        }
        if (!pt && opts.highlightZoneId === zone.id) {
          const l = new THREE.LineSegments(geo(outlineGeometry(zl.region, s.map, OFFSET_HIGHLIGHT)), highlightMat);
          l.renderOrder = 10;
          group.add(l);
        }
      }

      if (!pt && opts.highlightSurface?.roomId === room.id && opts.highlightSurface.surfaceId === s.id && !opts.highlightZoneId) {
        const outline = s.isFloor
          ? [{ outer: room.polygonMm.map(floorFrame(room).toLocal), holes: [] }]
          : [{ outer: [[0, 0], [s.frame!.lengthMm, 0], [s.frame!.lengthMm, H], [0, H]] as Vec2[], holes: [] }];
        group.add(new THREE.LineSegments(geo(outlineGeometry(outline, s.map, OFFSET_HIGHLIGHT)), surfaceHlMat));
      }

      // Openings: reveals (wall thickness) and simple frames.
      if (s.frame) {
        for (const o of room.openings.filter((x) => x.wallId === s.id)) {
          const u0 = o.offsetMm;
          const u1 = o.offsetMm + o.widthMm;
          const v0 = o.bottomMm;
          const v1 = o.bottomMm + o.heightMm;
          const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3) =>
            finishGeometry([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3], n);
          const m = s.map;
          const D = -REVEAL_DEPTH_MM;
          const along = new THREE.Vector3(s.frame.dir[0], 0, s.frame.dir[1]);
          const pickW: PickInfo = { roomId: room.id, surfaceId: s.id, zoneId: null };
          addMesh(quad(m(u0, v0, 0), m(u0, v1, 0), m(u0, v1, D), m(u0, v0, D), along.clone()), revealMat, pickW, 'reveal');
          addMesh(quad(m(u1, v0, 0), m(u1, v1, 0), m(u1, v1, D), m(u1, v0, D), along.clone().negate()), revealMat, pickW, 'reveal');
          addMesh(quad(m(u0, v1, 0), m(u1, v1, 0), m(u1, v1, D), m(u0, v1, D), new THREE.Vector3(0, -1, 0)), revealMat, pickW, 'reveal');
          if (v0 > 0) addMesh(quad(m(u0, v0, 0), m(u1, v0, 0), m(u1, v0, D), m(u0, v0, D), new THREE.Vector3(0, 1, 0)), revealMat, pickW, 'reveal');
          if (o.kind === 'window') {
            // Frame profile 60 mm around the opening, set back into the reveal; glazing is left open (no fake glass).
            const fd = -REVEAL_DEPTH_MM * 0.55;
            const fw = 60;
            const box = (a0: number, b0: number, a1: number, b1: number) => {
              const n = s.normal.clone();
              addMesh(quad(m(a0, b0, fd), m(a1, b0, fd), m(a1, b1, fd), m(a0, b1, fd), n), frameMat, pickW, 'window-frame');
            };
            box(u0, v0, u1, v0 + fw);
            box(u0, v1 - fw, u1, v1);
            box(u0, v0, u0 + fw, v1);
            box(u1 - fw, v0, u1, v1);
            box((u0 + u1) / 2 - fw / 2, v0, (u0 + u1) / 2 + fw / 2, v1);
            // sill board
            addMesh(quad(m(u0 - 40, v0, 50), m(u1 + 40, v0, 50), m(u1 + 40, v0, D), m(u0 - 40, v0, D), new THREE.Vector3(0, 1, 0)), frameMat, pickW, 'sill');
          }
        }
      }
    }

    if (r.showCeiling && !(opts.cutawayFrom && opts.cutawayFrom.y > mmToM(H))) {
      const ceilMap: SurfaceMap = (x, y, off) => new THREE.Vector3(mmToM(x), mmToM(H - off), mmToM(y));
      addMesh(polygonsGeometry([{ outer: room.polygonMm, holes: [] }], ceilMap, new THREE.Vector3(0, -1, 0), 0), ceilMat, { roomId: room.id, surfaceId: 'ceiling', zoneId: null }, `${room.id}:ceiling`);
    }
  }

  return {
    group,
    bounds,
    stats,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/** Lights shared by preview and photo modes; positions derive only from room geometry and settings. */
export function buildLights(project: Project, bounds: THREE.Box3, mode: 'preview' | 'pathtrace'): THREE.Group {
  const g = new THREE.Group();
  g.name = 'lights';
  const r = project.render;
  if (mode === 'preview') {
    const hemi = new THREE.HemisphereLight('#ffffff', '#d8d2c8', r.ambientIntensity);
    g.add(hemi);
  }
  for (const room of project.rooms) {
    if (!room.confirmed || room.polygonMm.length < 3) continue;
    const bb = bboxOfRing(room.polygonMm);
    const c: Vec2 = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
    const y = mmToM(room.heightMm) - 0.02;
    if (mode === 'preview') {
      const p = new THREE.PointLight('#fff4e6', 5 * r.ceilingLightIntensity, 0, 2);
      p.position.set(mmToM(c[0]), y - 0.1, mmToM(c[1]));
      p.castShadow = true;
      p.shadow.mapSize.set(1024, 1024);
      p.shadow.bias = -0.0005;
      p.shadow.radius = 6;
      g.add(p);
    } else {
      const w = Math.min(0.6, mmToM(bb.maxX - bb.minX) * 0.4);
      const h = Math.min(0.6, mmToM(bb.maxY - bb.minY) * 0.4);
      const a = new THREE.RectAreaLight('#fff4e6', 12 * r.ceilingLightIntensity, w, h);
      a.position.set(mmToM(c[0]), y - 0.005, mmToM(c[1]));
      a.lookAt(mmToM(c[0]), 0, mmToM(c[1]));
      g.add(a);
    }
  }
  if (r.sunIntensity > 0 && !bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()).length();
    const az = (r.sunAzimuthDeg * Math.PI) / 180;
    const el = (r.sunElevationDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const sun = new THREE.DirectionalLight('#fff1dc', r.sunIntensity);
    sun.position.copy(center).addScaledVector(dir, size * 2 + 5);
    sun.target.position.copy(center);
    g.add(sun.target);
    if (mode === 'preview') {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const half = size * 0.75 + 1;
      const cam = sun.shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 0.1;
      cam.far = size * 4 + 20;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.01;
    }
    g.add(sun);
  }
  return g;
}
