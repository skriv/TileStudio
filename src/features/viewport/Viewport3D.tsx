import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore, selectZone, select, toast, saveCameraPreset, updateRender, downloadBlob, findZone, createZone } from '../../state/store';
import { buildLights, buildScene, type PickInfo } from './sceneBuilder';
import { useMaterialTextures } from './textures';
import { cameraBus, type CameraPose } from './cameraBus';
import { eyeLevelPose, overviewPose, topPose } from './cameraPresets';
import { renderToBlob } from '../render/exportImage';
import { mmToM } from '../../core/geometry/room';
import { bboxOfMulti, bboxOfRing, type Vec2 } from '../../core/geometry/polygon';
import { resolveZoneLayout } from './zoneLayout';
import { floorFrame, wallFrames } from '../../core/geometry/room';
import type { RoomId, SurfaceId } from '../../core/project/types';
import { simplifyPath, surfaceMapFor, tidyRing, worldToSurface } from './zoneDraw';

type DrawEventKind = 'down' | 'move';
type DrawHandler = (kind: DrawEventKind, pick: PickInfo, point: THREE.Vector3, e: ThreeEvent<PointerEvent>) => void;

interface Draft {
  roomId: RoomId;
  surfaceId: SurfaceId;
  pts: Vec2[];
}

function SceneContent({ onBounds, drawing, onDraw }: { onBounds: (b: THREE.Box3) => void; drawing: boolean; onDraw: DrawHandler }) {
  const project = useStore((s) => s.project);
  const assetUrls = useStore((s) => s.assetUrls);
  const selection = useStore((s) => s.selection);
  const textures = useMaterialTextures(project, assetUrls);
  const { gl, scene, camera } = useThree();

  const built = useMemo(
    () =>
      buildScene(project, {
        textures,
        highlightZoneId: selection.zoneId,
        highlightSurface: selection.roomId && selection.surfaceId ? { roomId: selection.roomId, surfaceId: selection.surfaceId } : null,
        mode: 'preview',
      }),
    [project, textures, selection.zoneId, selection.roomId, selection.surfaceId],
  );
  const lights = useMemo(() => buildLights(project, built.bounds, 'preview'), [project, built.bounds]);

  useEffect(() => () => built.dispose(), [built]);
  useEffect(() => onBounds(built.bounds), [built.bounds, onBounds]);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.background = new THREE.Color('#e9e7e3');
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  useEffect(() => {
    scene.environmentIntensity = project.render.ambientIntensity * 0.6;
    gl.toneMappingExposure = project.render.exposure;
  }, [scene, gl, project.render.ambientIntensity, project.render.exposure]);

  useEffect(() => {
    cameraBus.setLive({ gl, scene, camera });
    return () => cameraBus.setLive(null);
  }, [gl, scene, camera]);

  const downAt = useRef<[number, number] | null>(null);
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    downAt.current = [e.clientX, e.clientY];
    const pick = e.object.userData.pick as PickInfo | undefined;
    if (drawing && pick && e.button === 0) {
      e.stopPropagation();
      onDraw('down', pick, e.point, e);
    }
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const pick = e.object.userData.pick as PickInfo | undefined;
    if (drawing && pick) {
      e.stopPropagation();
      onDraw('move', pick, e.point, e);
    }
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (drawing) return;
    const d = downAt.current;
    if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
    e.stopPropagation();
    const pick = e.object.userData.pick as PickInfo | undefined;
    if (!pick) return;
    if (pick.zoneId) selectZone(pick.zoneId);
    else if (pick.surfaceId !== 'ceiling') select({ roomId: pick.roomId, surfaceId: pick.surfaceId, zoneId: null });
    else select({ roomId: pick.roomId, zoneId: null });
  };

  return (
    <>
      <primitive object={built.group} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onClick={onClick} />
      <primitive object={lights} />
    </>
  );
}

function DraftOverlay({ draft, hover }: { draft: Draft | null; hover: { roomId: RoomId; surfaceId: SurfaceId; pt: Vec2 } | null }) {
  const project = useStore((s) => s.project);
  const key = draft ?? hover;
  const room = key && project.rooms.find((r) => r.id === key.roomId);
  const map = room && key ? surfaceMapFor(room, key.surfaceId) : null;
  if (!room || !map) return null;
  const toW = (p: Vec2) => map(p[0], p[1], 5);
  const pts = draft?.pts ?? [];
  const sameSurface = hover && (!draft || (hover.roomId === draft.roomId && hover.surfaceId === draft.surfaceId));
  const line = pts.map(toW);
  if (sameSurface && pts.length) line.push(toW(hover!.pt));
  return (
    <group renderOrder={20}>
      {line.length >= 2 && <Line points={line} color="#e53935" lineWidth={3} depthTest={false} />}
      {pts.length >= 3 && sameSurface && <Line points={[toW(hover!.pt), toW(pts[0])]} color="#e53935" lineWidth={1.5} dashed dashSize={0.05} gapSize={0.04} depthTest={false} />}
      {pts.map((p, i) => (
        <mesh key={i} position={toW(p)} renderOrder={21}>
          <sphereGeometry args={[i === 0 ? 0.03 : 0.018, 12, 8]} />
          <meshBasicMaterial color={i === 0 ? '#ffffff' : '#e53935'} depthTest={false} />
        </mesh>
      ))}
      {sameSurface && (
        <mesh position={toW(hover!.pt)} renderOrder={21}>
          <sphereGeometry args={[0.02, 12, 8]} />
          <meshBasicMaterial color="#e53935" depthTest={false} />
        </mesh>
      )}
    </group>
  );
}

function CameraRig({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree();
  useEffect(() => {
    const apply = (p: CameraPose) => {
      camera.position.set(...p.position);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = p.fov;
        camera.updateProjectionMatrix();
      }
      const c = controlsRef.current;
      if (c) {
        c.target.set(...p.target);
        c.update();
      } else camera.lookAt(...p.target);
    };
    cameraBus.registerApply(apply);
    const last = cameraBus.get();
    if (last) apply(last);
    return () => cameraBus.registerApply(null);
  }, [camera, controlsRef]);
  return null;
}

function useNarrow(maxPx: number) {
  const [match, setMatch] = useState(() => window.matchMedia(`(max-width: ${maxPx}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxPx}px)`);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [maxPx]);
  return match;
}

export function Viewport3D() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const [bounds, setBounds] = useState<THREE.Box3>(() => new THREE.Box3());
  const firstFit = useRef(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  const confirmedRooms = project.rooms.filter((r) => r.confirmed);

  const [drawing, setDrawing] = useState(false);
  const narrow = useNarrow(1400);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<{ roomId: RoomId; surfaceId: SurfaceId; pt: Vec2 } | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  /** Active mouse press: a drag becomes a freehand stroke, a short press adds one vertex. */
  const stroke = useRef<{ x: number; y: number; roomId: RoomId; surfaceId: SurfaceId; pts: Vec2[]; base: Vec2[]; freehand: boolean } | null>(null);

  const stopDrawing = useCallback(() => {
    setDrawing(false);
    setDraft(null);
    setHover(null);
    stroke.current = null;
  }, []);

  const finishZone = useCallback(
    (d: Draft | null, freehand = false) => {
      if (!d) return;
      const ring = tidyRing(freehand ? simplifyPath(d.pts, 6) : d.pts);
      if (ring.length < 3) {
        toast('Нужно минимум 3 точки, чтобы замкнуть зону.', 'error');
        return;
      }
      const id = createZone(d.roomId, d.surfaceId, 'polygon', ring);
      if (!id) return;
      stopDrawing();
      toast('Зона создана. Теперь нажмите на плитку в библиотеке слева — она применится к этой зоне.', 'ok');
    },
    [stopDrawing],
  );

  const onDraw = useCallback<DrawHandler>(
    (kind, pick, point, e) => {
      if (pick.surfaceId === 'ceiling') return;
      const room = project.rooms.find((r) => r.id === pick.roomId);
      if (!room) return;
      const d = draftRef.current;
      const onDraftSurface = !d || (d.roomId === pick.roomId && d.surfaceId === pick.surfaceId);
      const local = worldToSurface(room, pick.surfaceId, point);
      if (!local) return;
      if (kind === 'move') {
        setHover({ roomId: pick.roomId, surfaceId: pick.surfaceId, pt: local });
        const st = stroke.current;
        if (st && st.roomId === pick.roomId && st.surfaceId === pick.surfaceId) {
          if (!st.freehand && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 6) st.freehand = true;
          const last = st.pts[st.pts.length - 1];
          if (st.freehand && Math.hypot(local[0] - last[0], local[1] - last[1]) >= 10) {
            st.pts.push(local);
            setDraft({ roomId: st.roomId, surfaceId: st.surfaceId, pts: [...st.base, ...st.pts] });
          }
        }
        return;
      }
      if (!onDraftSurface) {
        toast('Зона рисуется на одной поверхности. Замкните текущий контур (Enter) или отмените (Esc).', 'error');
        return;
      }
      stroke.current = { x: e.clientX, y: e.clientY, roomId: pick.roomId, surfaceId: pick.surfaceId, pts: [local], base: d?.pts ?? [], freehand: false };
      if (!d) select({ roomId: pick.roomId, surfaceId: pick.surfaceId, zoneId: null });
    },
    [project.rooms],
  );

  useEffect(() => {
    if (!drawing) return;
    const onUp = () => {
      const st = stroke.current;
      stroke.current = null;
      if (!st) return;
      if (st.freehand) {
        // A stroke drawn from scratch closes itself; a stroke added to clicked vertices extends the contour.
        if (!st.base.length) finishZone({ roomId: st.roomId, surfaceId: st.surfaceId, pts: st.pts }, true);
        return;
      }
      const p = st.pts[0];
      const prev = st.base;
      if (prev.length >= 3 && Math.hypot(p[0] - prev[0][0], p[1] - prev[0][1]) < 80) {
        finishZone({ roomId: st.roomId, surfaceId: st.surfaceId, pts: prev });
        return;
      }
      setDraft({ roomId: st.roomId, surfaceId: st.surfaceId, pts: [...prev, p] });
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'Escape') {
        if (draftRef.current?.pts.length) setDraft(null);
        else stopDrawing();
      } else if (e.key === 'Enter') finishZone(draftRef.current);
      else if (e.key === 'Backspace') {
        e.preventDefault();
        setDraft((d) => (d && d.pts.length > 1 ? { ...d, pts: d.pts.slice(0, -1) } : null));
      }
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawing, finishZone, stopDrawing]);

  useEffect(() => {
    if (!firstFit.current && !bounds.isEmpty() && !cameraBus.get()) {
      firstFit.current = true;
      cameraBus.apply(overviewPose(bounds));
    }
  }, [bounds]);

  useEffect(() => {
    const c = document.createElement('canvas');
    if (!c.getContext('webgl2')) setWebglError('WebGL2 недоступен в этом браузере/на этом GPU. 3D-просмотр и рендер невозможны; доступны План и Развёртка.');
  }, []);

  const focusSelection = () => {
    const f = findZone(project, selection.zoneId);
    if (!f) return toast('Выберите зону для фокуса (F).');
    const zl = resolveZoneLayout(project, f.room, f.zone);
    const bb = bboxOfMulti(zl.region);
    const cu = (bb.minX + bb.maxX) / 2;
    const cv = (bb.minY + bb.maxY) / 2;
    if (f.zone.surfaceId === 'floor') {
      const [x, y] = floorFrame(f.room).toPlan([cu, cv]);
      cameraBus.apply({ position: [mmToM(x), 2.2, mmToM(y) + 1.6], target: [mmToM(x), 0, mmToM(y)], fov: 55 });
    } else {
      const fr = wallFrames(f.room).find((w) => w.wallId === f.zone.surfaceId);
      if (!fr) return;
      const px = fr.start[0] + fr.dir[0] * cu;
      const py = fr.start[1] + fr.dir[1] * cu;
      const dist = 1600;
      cameraBus.apply({
        position: [mmToM(px + fr.inward[0] * dist), Math.max(1.2, mmToM(cv)), mmToM(py + fr.inward[1] * dist)],
        target: [mmToM(px), mmToM(cv), mmToM(py)],
        fov: 60,
      });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') focusSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exportImage = async (format: 'png' | 'jpeg') => {
    const live = cameraBus.live();
    if (!live) return;
    try {
      const { outputWidth: w, outputHeight: h } = project.render;
      const blob = await renderToBlob(live.gl, live.scene, live.camera, w, h, format);
      downloadBlob(blob, `tile-studio-preview-${w}x${h}.${format === 'png' ? 'png' : 'jpg'}`);
      toast(`Экспортирован кадр Preview ${w}×${h}`, 'ok');
    } catch (e) {
      toast(`Экспорт: ${(e as Error).message}`, 'error');
    }
  };

  if (webglError) return <div className="empty-state error">{webglError}</div>;

  if (!confirmedRooms.length) {
    return (
      <div className="empty-state">
        <h3>Нет подтверждённой геометрии</h3>
        <p>Обведите помещение на плане и нажмите «Подтвердить контур → 3D».</p>
      </div>
    );
  }

  const selRoom = project.rooms.find((r) => r.id === selection.roomId && r.confirmed) ?? confirmedRooms[0];
  const hiddenSel = selection.surfaceId && selection.surfaceId !== 'floor' && project.render.hiddenWallIds.includes(selection.surfaceId);

  return (
    <div className={`viewport3d ${drawing ? 'drawing' : ''}`}>
      <Canvas
        shadows={{ type: THREE.PCFSoftShadowMap }}
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.AgXToneMapping }}
        camera={{ fov: 50, near: 0.02, far: 300, position: [6, 6, 6] }}
        onPointerMissed={() => !drawing && select({ zoneId: null })}
      >
        <SceneContent onBounds={setBounds} drawing={drawing} onDraw={onDraw} />
        {drawing && <DraftOverlay draft={draft} hover={hover} />}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enabled={!drawing}
          enableDamping
          dampingFactor={0.12}
          onEnd={() => {
            const c = controlsRef.current;
            if (!c) return;
            const cam = c.object as THREE.PerspectiveCamera;
            cameraBus.set({ position: cam.position.toArray() as [number, number, number], target: c.target.toArray() as [number, number, number], fov: cam.fov });
          }}
        />
        <CameraRig controlsRef={controlsRef} />
      </Canvas>
      {(() => {
        const toolbar = (
      <div className="vp-toolbar">
        {project.rooms.map((r) => (
          <button
            key={r.id}
            className={selection.roomId === r.id ? 'active' : ''}
            onClick={() => {
              select({ roomId: r.id, surfaceId: null, zoneId: null });
              if (!r.confirmed || r.polygonMm.length < 3) {
                toast(`${r.name}: контур ещё не построен.`);
                return;
              }
              const bb = bboxOfRing(r.polygonMm);
              const b = new THREE.Box3(new THREE.Vector3(mmToM(bb.minX), 0, mmToM(bb.minY)), new THREE.Vector3(mmToM(bb.maxX), mmToM(r.heightMm), mmToM(bb.maxY)));
              cameraBus.apply(overviewPose(b));
            }}
          >
            {r.name}
          </button>
        ))}
        <span className="sep" />
        <button className={drawing ? 'active' : 'primary'} onClick={() => (drawing ? stopDrawing() : setDrawing(true))} title="Обвести зону прямо на стене или полу">
          {drawing ? 'Готово / отмена рисования' : '✏ Обвести зону'}
        </button>
        <span className="sep" />
        <button onClick={() => cameraBus.apply(overviewPose(bounds))}>Обзор</button>
        <button onClick={() => cameraBus.apply(topPose(bounds))}>Сверху</button>
        <button
          onClick={() => {
            const p = eyeLevelPose(selRoom, selRoom.id === selection.roomId ? selection.surfaceId : null);
            if (p) cameraBus.apply(p);
          }}
          title="Вид с высоты 1600 мм на выбранную (или самую длинную) стену"
        >
          Глаза: {selRoom.name}
        </button>
        <button onClick={focusSelection} title="F">
          Фокус зоны
        </button>
        <span className="sep" />
        <label className="chk">
          <input type="checkbox" checked={project.render.showCeiling} onChange={(e) => updateRender({ showCeiling: e.target.checked })} />
          Потолок
        </label>
        {selection.surfaceId && selection.surfaceId !== 'floor' && (
          <button onClick={() => updateRender({ hiddenWallIds: [...project.render.hiddenWallIds, selection.surfaceId!] })} disabled={!!hiddenSel}>
            Скрыть стену
          </button>
        )}
        {project.render.hiddenWallIds.length > 0 && <button onClick={() => updateRender({ hiddenWallIds: [] })}>Показать стены ({project.render.hiddenWallIds.length})</button>}
        <span className="sep" />
        <button
          onClick={() => {
            const p = cameraBus.get();
            if (p) saveCameraPreset(p);
            toast('Ракурс сохранён', 'ok');
          }}
        >
          Сохранить ракурс
        </button>
        {project.cameras.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const c = project.cameras.find((x) => x.id === e.target.value);
              if (c) cameraBus.apply({ position: c.position, target: c.target, fov: c.fov });
            }}
          >
            <option value="">Ракурсы…</option>
            {project.cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <span className="grow" />
        <button onClick={() => exportImage('png')}>PNG</button>
        <button onClick={() => exportImage('jpeg')}>JPG</button>
      </div>
        );
        const slot = narrow ? document.getElementById('app-menu-tools') : null;
        return slot ? createPortal(toolbar, slot) : toolbar;
      })()}
      {drawing && (
        <div className="vp-draw-hint">
          {draft?.pts.length
            ? `Точек: ${draft.pts.length}. Клик в белую точку или Enter — замкнуть · Backspace — убрать точку · Esc — сбросить`
            : 'Ведите мышью с зажатой кнопкой по стене или полу — контур замкнётся сам. Или кликайте по точкам. Камера заблокирована; Esc — выйти.'}
        </div>
      )}
      <div className="vp-badge">3D Preview · растеризация WebGL2 · {project.render.outputWidth}×{project.render.outputHeight} при экспорте</div>
    </div>
  );
}
