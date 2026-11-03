import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { useStore, toast, downloadBlob, setView } from '../../state/store';
import { buildLights, buildScene } from '../viewport/sceneBuilder';
import { loadTileTexture, useMaterialTextures } from '../viewport/textures';
import { cameraBus } from '../viewport/cameraBus';
import { overviewPose, roomsBounds } from '../viewport/cameraPresets';
import { createSkyTexture } from './sky';
import { maxRenderSize } from './exportImage';

type Status = 'idle' | 'building' | 'rendering' | 'paused' | 'done' | 'error' | 'raster';

interface Session {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pt: WebGLPathTracer | null;
  dispose: () => void;
}

export function PhotoRender() {
  const project = useStore((s) => s.project);
  const assetUrls = useStore((s) => s.assetUrls);
  const textures = useMaterialTextures(project, assetUrls);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const session = useRef<Session | null>(null);
  const raf = useRef<number>(0);
  const [status, setStatus] = useState<Status>('idle');
  const [samples, setSamples] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] = useState(0);
  const [stats, setStats] = useState<{ tiles: number; full: number; cut: number } | null>(null);
  const r = project.render;
  const hasRooms = project.rooms.some((x) => x.confirmed);

  const stopLoop = () => cancelAnimationFrame(raf.current);

  const teardown = () => {
    stopLoop();
    session.current?.dispose();
    session.current = null;
  };

  useEffect(() => () => teardown(), []);

  /** All tile textures must be decoded before the scene is handed to the renderer. */
  const loadAllTextures = async () => {
    const map = new Map(textures);
    await Promise.all(
      project.materials.filter((m) => assetUrls[m.assetId]).map(async (m) => map.set(m.assetId, await loadTileTexture(assetUrls[m.assetId]))),
    );
    return map;
  };

  const prepare = (mode: 'pathtrace' | 'preview', textures: Map<string, THREE.Texture>) => {
    teardown();
    const canvas = document.createElement('canvas');
    canvas.className = 'pr-canvas';
    canvas.style.aspectRatio = `${r.outputWidth} / ${r.outputHeight}`;
    stageRef.current!.replaceChildren(canvas);
    canvasRef.current = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: mode === 'preview', preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = r.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const max = maxRenderSize(renderer);
    const W = Math.min(r.outputWidth, max);
    const H = Math.min(r.outputHeight, max);
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    const scene = new THREE.Scene();
    const pose = cameraBus.get() ?? overviewPose(roomsBounds(project));
    const built = buildScene(project, {
      textures,
      highlightZoneId: null,
      highlightSurface: null,
      mode,
      cutawayFrom: new THREE.Vector3(...pose.position),
    });
    setStats(built.stats);
    scene.add(built.group);
    scene.add(buildLights(project, built.bounds, mode));
    const sky = createSkyTexture();
    scene.environment = sky;
    scene.background = sky;
    scene.environmentIntensity = 0.6 + r.ambientIntensity;
    const camera = new THREE.PerspectiveCamera(pose.fov, W / H, 0.02, 300);
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
    return {
      renderer,
      scene,
      camera,
      pt: null as WebGLPathTracer | null,
      dispose: () => {
        built.dispose();
        sky.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      },
    };
  };

  const start = async () => {
    if (!hasRooms) return;
    setError(null);
    setSamples(0);
    setElapsed(0);
    setBuildProgress(0);
    setStatus('building');
    let s: Session;
    try {
      s = prepare('pathtrace', await loadAllTextures());
      session.current = s;
      const pt = new WebGLPathTracer(s.renderer);
      pt.tiles.set(2, 2);
      pt.bounces = 6;
      pt.filterGlossyFactor = 0.4;
      pt.renderDelay = 0;
      pt.fadeDuration = 0;
      pt.minSamples = 1;
      pt.dynamicLowRes = false;
      pt.renderScale = 1;
      s.pt = pt;
      // Let React paint the "building" state before the synchronous BVH build.
      await new Promise((r) => setTimeout(r, 30));
      pt.setScene(s.scene, s.camera);
      setBuildProgress(1);
    } catch (e) {
      console.error(e);
      setError(`Path tracer не запустился: ${(e as Error).message}`);
      setStatus('error');
      return;
    }
    setStatus('rendering');
    const t0 = performance.now();
    const loop = () => {
      const cur = session.current;
      if (!cur?.pt) return;
      try {
        cur.pt.renderSample();
      } catch (e) {
        setError(`Ошибка рендера: ${(e as Error).message}`);
        setStatus('error');
        return;
      }
      const n = Math.floor(cur.pt.samples);
      setSamples(n);
      setElapsed((performance.now() - t0) / 1000);
      if (n >= r.maxSamples) {
        setStatus('done');
        return;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };

  const pause = () => {
    stopLoop();
    setStatus('paused');
  };

  const resume = () => {
    if (!session.current?.pt) return;
    setStatus('rendering');
    const t0 = performance.now() - elapsed * 1000;
    const loop = () => {
      const cur = session.current;
      if (!cur?.pt) return;
      cur.pt.renderSample();
      const n = Math.floor(cur.pt.samples);
      setSamples(n);
      setElapsed((performance.now() - t0) / 1000);
      if (n >= r.maxSamples) return setStatus('done');
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };

  const rasterFallback = async () => {
    try {
      const s = prepare('preview', await loadAllTextures());
      s.renderer.shadowMap.enabled = true;
      s.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      s.scene.environmentIntensity = r.ambientIntensity * 0.6;
      session.current = s;
      s.renderer.render(s.scene, s.camera);
      setError(null);
      setStatus('raster');
    } catch (e) {
      setError(`Растровый рендер не удался: ${(e as Error).message}`);
      setStatus('error');
    }
  };

  const save = (format: 'png' | 'jpeg') => {
    const c = canvasRef.current;
    if (!c || !session.current) return;
    c.toBlob(
      (b) => {
        if (!b) return toast('Не удалось получить изображение', 'error');
        const kind = status === 'raster' ? 'raster' : `pathtrace-${samples}spp`;
        downloadBlob(b, `tile-studio-${kind}-${c.width}x${c.height}.${format === 'png' ? 'png' : 'jpg'}`);
      },
      format === 'png' ? 'image/png' : 'image/jpeg',
      0.95,
    );
  };

  if (!hasRooms) {
    return (
      <div className="empty-state">
        <h3>Нечего рендерить</h3>
        <p>Сначала подтвердите контур хотя бы одного помещения.</p>
      </div>
    );
  }

  const running = status === 'rendering' || status === 'building';
  const pct = Math.min(100, (samples / r.maxSamples) * 100);

  return (
    <div className="photo-render">
      <div className="pr-toolbar">
        {!running && status !== 'paused' && (
          <button className="primary" onClick={start}>
            {status === 'idle' ? 'Запустить Photo Render' : 'Перезапустить'}
          </button>
        )}
        {status === 'rendering' && <button onClick={pause}>Стоп</button>}
        {status === 'paused' && (
          <>
            <button className="primary" onClick={resume}>
              Продолжить
            </button>
            <button onClick={start}>Заново</button>
          </>
        )}
        <button onClick={() => setView('3d')} title="Ракурс берётся из 3D Preview">
          Изменить ракурс в 3D
        </button>
        <span className="grow" />
        {(status === 'done' || status === 'paused' || status === 'raster' || (status === 'rendering' && samples > 0)) && (
          <>
            <button onClick={() => save('png')}>PNG</button>
            <button onClick={() => save('jpeg')}>JPG</button>
          </>
        )}
      </div>
      <div className="pr-stage">
        <div className="pr-host" ref={stageRef} style={{ aspectRatio: `${r.outputWidth} / ${r.outputHeight}` }} />
        {status === 'idle' && (
          <div className="pr-overlay">
            <p>
              Прогрессивный GPU path tracing (three-gpu-pathtracer, WebGL2) по той же геометрии плиток, что и в Preview.
              <br />
              Ракурс — текущая камера 3D. Разрешение {r.outputWidth}×{r.outputHeight}, до {r.maxSamples} сэмплов.
            </p>
          </div>
        )}
        {status === 'building' && <div className="pr-overlay">Построение BVH сцены… {Math.round(buildProgress * 100)}%</div>}
        {status === 'error' && (
          <div className="pr-overlay error">
            <p>{error}</p>
            <button onClick={rasterFallback}>Сделать растровый кадр (не path tracing)</button>
          </div>
        )}
      </div>
      <div className="pr-status">
        {status === 'raster' ? (
          <span className="warn">Режим: растровый fallback (WebGL raster + shadow maps). Это НЕ path tracing.</span>
        ) : (
          <>
            <span>
              Path tracing: {samples} / {r.maxSamples} сэмплов · {elapsed.toFixed(1)} с{samples > 0 && elapsed > 0 ? ` · ${(samples / elapsed).toFixed(1)} spp/с` : ''}
            </span>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span>{status === 'done' ? 'Готово' : status === 'paused' ? 'Пауза' : status === 'rendering' ? 'Идёт рендер' : ''}</span>
          </>
        )}
        {stats && (
          <span className="muted">
            Плиток в сцене: {stats.tiles} (целых {stats.full}, подрезанных {stats.cut})
          </span>
        )}
      </div>
    </div>
  );
}
