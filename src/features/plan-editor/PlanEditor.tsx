import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dist, ringArea, ringCentroid, type Vec2 } from '../../core/geometry/polygon';
import { floorFrame, wallFrames, wallPointToPlan } from '../../core/geometry/room';
import { resolveZoneLayout } from '../viewport/zoneLayout';
import {
  useStore,
  setCalibration,
  setRoomPolygon,
  select,
  selectZone,
  setPlanTool,
  toast,
  getRoom,
} from '../../state/store';
import type { Room } from '../../core/project/types';

interface ViewT {
  s: number; // screen px per world unit
  tx: number;
  ty: number;
}

const ROOM_COLORS: Record<Room['id'], string> = { kitchen: '#2f80ed', wc: '#9b51e0', corridor: '#27ae60' };
const SNAP_PX = 10;

export function fmtMm(v: number) {
  return `${Math.round(v)} мм`;
}

export function PlanEditor() {
  const project = useStore((s) => s.project);
  const tool = useStore((s) => s.planTool);
  const selection = useStore((s) => s.selection);
  const assetUrls = useStore((s) => s.assetUrls);
  const plan = project.plan;
  const k = plan?.calibration?.mmPerPx ?? 1;
  const calibrated = !!plan?.calibration;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setViewT] = useState<ViewT>({ s: 0.1, tx: 40, ty: 40 });
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [calibPts, setCalibPts] = useState<Vec2[]>([]);
  const [calibLen, setCalibLen] = useState('5500');
  const [measurePts, setMeasurePts] = useState<Vec2[]>([]);
  const [measureExpected, setMeasureExpected] = useState('');
  const [drag, setDrag] = useState<{ roomId: Room['id']; index: number; orig: Vec2[] } | null>(null);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const fitted = useRef<string | null>(null);

  const room = getRoom(project, selection.roomId);

  // ---- sizing / fit ----
  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const contentBox = useMemo(() => {
    if (plan) return { x: 0, y: 0, w: plan.rasterWidthPx * k, h: plan.rasterHeightPx * k };
    const pts = project.rooms.flatMap((r) => r.polygonMm);
    if (!pts.length) return { x: -500, y: -500, w: 10000, h: 7000 };
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs) - 1000, y: Math.min(...ys) - 1000, w: Math.max(...xs) - Math.min(...xs) + 2000, h: Math.max(...ys) - Math.min(...ys) + 2000 };
  }, [plan, k, project.rooms]);

  const fit = useCallback(() => {
    const s = Math.min(size.w / contentBox.w, size.h / contentBox.h) * 0.94;
    setViewT({ s, tx: (size.w - contentBox.w * s) / 2 - contentBox.x * s, ty: (size.h - contentBox.h * s) / 2 - contentBox.y * s });
  }, [size, contentBox]);

  useEffect(() => {
    const key = `${plan?.rasterAssetId ?? 'none'}:${k}:${size.w > 100}`;
    if (fitted.current !== key && size.w > 100) {
      fitted.current = key;
      fit();
    }
  }, [plan?.rasterAssetId, k, size, fit]);

  // ---- coordinate helpers ----
  const toWorld = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left - view.tx) / view.s, (e.clientY - r.top - view.ty) / view.s];
  };

  const allVertices = useMemo(() => project.rooms.flatMap((r) => r.polygonMm.map((p) => ({ p, roomId: r.id }))), [project.rooms]);

  const snap = (w: Vec2, opts: { ortho: boolean; from?: Vec2; excludeRoom?: Room['id']; excludeIndex?: number }): { p: Vec2; snapped: string | null } => {
    const th = SNAP_PX / view.s;
    let best: Vec2 | null = null;
    let bestD = th;
    for (const v of allVertices) {
      if (opts.excludeRoom === v.roomId && opts.excludeIndex !== undefined && room && room.polygonMm[opts.excludeIndex] === v.p) continue;
      const d = dist(v.p, w);
      if (d < bestD) {
        bestD = d;
        best = v.p;
      }
    }
    for (const v of draft) {
      const d = dist(v, w);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) return { p: [best[0], best[1]], snapped: 'вершина' };
    if (opts.ortho && opts.from) {
      const dx = w[0] - opts.from[0];
      const dy = w[1] - opts.from[1];
      let p: Vec2 = Math.abs(dx) > Math.abs(dy) ? [w[0], opts.from[1]] : [opts.from[0], w[1]];
      // align to x/y of any other vertex
      for (const v of allVertices) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(v.p[0] - p[0]) < th) p = [v.p[0], p[1]];
        if (Math.abs(dx) <= Math.abs(dy) && Math.abs(v.p[1] - p[1]) < th) p = [p[0], v.p[1]];
      }
      return { p, snapped: 'орто' };
    }
    return { p: w, snapped: null };
  };

  // ---- interactions ----
  const traceAllowed = !plan || calibrated;

  const finishDraft = () => {
    if (!room) return;
    if (draft.length < 3) {
      toast('Нужно минимум 3 точки.', 'error');
      return;
    }
    setRoomPolygon(room.id, draft);
    setDraft([]);
    setPlanTool('select');
    toast(`${room.name}: контур замкнут (${(ringArea(draft) / 1e6).toFixed(2)} м²). Проверьте размеры и подтвердите.`, 'ok');
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const w = toWorld(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey) || (tool === 'select' && e.button === 0 && !(e.target as Element).closest('[data-hit]'))) {
      pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      if (tool === 'select' && e.button === 0) pan.current = { ...pan.current };
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'calibrate') {
      const px: Vec2 = [w[0] / k, w[1] / k];
      setCalibPts((pts) => (pts.length >= 2 ? [px] : [...pts, px]));
    } else if (tool === 'measure') {
      setMeasurePts((pts) => (pts.length >= 2 ? [w] : [...pts, w]));
    } else if (tool === 'trace') {
      if (!room) return toast('Выберите помещение слева.', 'error');
      if (!traceAllowed) return toast('Сначала откалибруйте план.', 'error');
      const { p } = snap(w, { ortho: !e.shiftKey, from: draft[draft.length - 1] });
      if (draft.length >= 3 && dist(p, draft[0]) < SNAP_PX / view.s) return finishDraft();
      setDraft((d) => [...d, p]);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e);
    if (pan.current) {
      setViewT((v) => ({ ...v, tx: pan.current!.tx + e.clientX - pan.current!.x, ty: pan.current!.ty + e.clientY - pan.current!.y }));
      return;
    }
    if (drag) {
      const { p } = snap(w, { ortho: false, excludeRoom: drag.roomId, excludeIndex: drag.index });
      const r = getRoom(project, drag.roomId);
      if (r) {
        const poly = r.polygonMm.map((q, i) => (i === drag.index ? p : q));
        setRoomPolygon(drag.roomId, poly, false);
      }
      return;
    }
    if (tool === 'trace') setCursor(snap(w, { ortho: !e.shiftKey, from: draft[draft.length - 1] }).p);
    else setCursor(w);
  };

  const onPointerUp = () => {
    pan.current = null;
    if (drag) {
      // record a single undo step for the whole drag
      const r = getRoom(useStore.getState().project, drag.roomId);
      if (r) {
        const final = r.polygonMm;
        setRoomPolygon(drag.roomId, drag.orig, false);
        setRoomPolygon(drag.roomId, final, true);
      }
      setDrag(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setViewT((v) => {
      const s = Math.min(Math.max(v.s * f, 0.005), 20);
      return { s, tx: mx - ((mx - v.tx) * s) / v.s, ty: my - ((my - v.ty) * s) / v.s };
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'Escape') {
        setDraft([]);
        setCalibPts([]);
        setMeasurePts([]);
        setPlanTool('select');
      } else if (e.key === 'Enter' && tool === 'trace') finishDraft();
      else if (e.key === 'Backspace' && tool === 'trace' && draft.length) {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (tool !== 'trace') setDraft([]);
    if (tool !== 'calibrate') setCalibPts([]);
    if (tool !== 'measure') setMeasurePts([]);
  }, [tool]);

  const deleteVertex = (r: Room, i: number) => {
    if (r.polygonMm.length <= 3) return toast('В контуре должно остаться ≥ 3 вершин.', 'error');
    setRoomPolygon(
      r.id,
      r.polygonMm.filter((_, j) => j !== i),
    );
  };

  const insertVertex = (r: Room, edge: number, at: Vec2) => {
    const poly = [...r.polygonMm];
    poly.splice(edge + 1, 0, at);
    setRoomPolygon(r.id, poly);
  };

  // ---- rendering ----
  const sw = 1 / view.s; // 1 screen px in world units
  const label = (p: Vec2, text: string, color = '#111', size = 11, anchor: 'middle' | 'start' = 'middle') => (
    <text x={p[0]} y={p[1]} fontSize={size * sw} fill={color} textAnchor={anchor} dominantBaseline="middle" className="svg-label" style={{ paintOrder: 'stroke' }} stroke="#fff" strokeWidth={3 * sw}>
      {text}
    </text>
  );

  const calibWorld = calibPts.map((p) => [p[0] * k, p[1] * k] as Vec2);
  const calibPxLen = calibPts.length === 2 ? dist(calibPts[0], calibPts[1]) : 0;
  const measureLen = measurePts.length === 2 ? dist(measurePts[0], measurePts[1]) : 0;
  const expected = parseFloat(measureExpected);

  const gridLines = useMemo(() => {
    if (plan) return null;
    const lines: React.ReactNode[] = [];
    const x0 = Math.floor(contentBox.x / 1000) * 1000;
    const y0 = Math.floor(contentBox.y / 1000) * 1000;
    for (let x = x0; x <= contentBox.x + contentBox.w; x += 500) lines.push(<line key={`x${x}`} x1={x} y1={contentBox.y} x2={x} y2={contentBox.y + contentBox.h} className={x % 1000 === 0 ? 'grid-major' : 'grid-minor'} vectorEffect="non-scaling-stroke" />);
    for (let y = y0; y <= contentBox.y + contentBox.h; y += 500) lines.push(<line key={`y${y}`} x1={contentBox.x} y1={y} x2={contentBox.x + contentBox.w} y2={y} className={y % 1000 === 0 ? 'grid-major' : 'grid-minor'} vectorEffect="non-scaling-stroke" />);
    return lines;
  }, [plan, contentBox]);

  return (
    <div className="plan-editor">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        className={`tool-${tool}`}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          {gridLines}
          {plan && plan.visible && assetUrls[plan.rasterAssetId] && (
            <image href={assetUrls[plan.rasterAssetId]} x={0} y={0} width={plan.rasterWidthPx * k} height={plan.rasterHeightPx * k} opacity={plan.opacity} preserveAspectRatio="none" style={{ imageRendering: view.s * k > 1.5 ? 'pixelated' : 'auto' }} />
          )}

          {project.rooms.map((r) => {
            if (r.polygonMm.length < 2) return null;
            const sel = r.id === selection.roomId;
            const color = ROOM_COLORS[r.id];
            const pts = r.polygonMm.map((p) => p.join(',')).join(' ');
            const c = ringCentroid(r.polygonMm);
            const frames = r.polygonMm.length >= 3 ? wallFrames(r) : [];
            return (
              <g key={r.id} opacity={sel ? 1 : 0.75}>
                <polygon
                  data-hit
                  points={pts}
                  fill={color}
                  fillOpacity={sel ? 0.16 : 0.08}
                  stroke={color}
                  strokeWidth={sel ? 2.5 : 1.5}
                  strokeDasharray={r.confirmed ? undefined : '6 4'}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(e) => {
                    if (tool !== 'select') return;
                    e.stopPropagation();
                    select({ roomId: r.id, surfaceId: 'floor', zoneId: null });
                  }}
                />
                {/* floor zones */}
                {r.confirmed &&
                  r.zones
                    .filter((z) => z.surfaceId === 'floor')
                    .map((z) => {
                      const ff = floorFrame(r);
                      const zl = resolveZoneLayout(project, r, z);
                      const zsel = selection.zoneId === z.id;
                      return (
                        <g key={z.id}>
                          {zl.region.map((poly, i) => (
                            <path
                              key={i}
                              data-hit
                              d={[poly.outer, ...poly.holes].map((ring) => 'M' + ring.map((p) => ff.toPlan(p).join(',')).join('L') + 'Z').join(' ')}
                              fill={zl.assignment ? '#ff7a1a' : '#888'}
                              fillOpacity={zsel ? 0.35 : 0.15}
                              fillRule="evenodd"
                              stroke={zsel ? '#ff7a1a' : '#666'}
                              strokeWidth={zsel ? 2 : 1}
                              strokeDasharray="3 3"
                              vectorEffect="non-scaling-stroke"
                              onPointerDown={(e) => {
                                if (tool !== 'select') return;
                                e.stopPropagation();
                                selectZone(z.id);
                              }}
                            />
                          ))}
                        </g>
                      );
                    })}
                {/* openings */}
                {frames.map((f) =>
                  r.openings
                    .filter((o) => o.wallId === f.wallId)
                    .map((o) => {
                      const a = wallPointToPlan(f, o.offsetMm);
                      const b = wallPointToPlan(f, o.offsetMm + o.widthMm);
                      return <line key={o.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={o.kind === 'window' ? '#00a3c4' : '#c47f00'} strokeWidth={6} vectorEffect="non-scaling-stroke" strokeLinecap="butt" />;
                    }),
                )}
                {label(c, `${r.name}${r.polygonMm.length >= 3 ? ` · ${(ringArea(r.polygonMm) / 1e6).toFixed(2)} м²` : ''}${r.confirmed ? '' : ' (не подтв.)'}`, color, 13)}
                {sel &&
                  r.polygonMm.map((p, i) => {
                    const q = r.polygonMm[(i + 1) % r.polygonMm.length];
                    const m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                    const wf = frames.find((f) => f.index === i);
                    return (
                      <g key={i}>
                        <line
                          data-hit
                          x1={p[0]}
                          y1={p[1]}
                          x2={q[0]}
                          y2={q[1]}
                          stroke="transparent"
                          strokeWidth={12}
                          vectorEffect="non-scaling-stroke"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            insertVertex(r, i, toWorld(e));
                          }}
                          onPointerDown={(e) => {
                            if (tool !== 'select' || !wf) return;
                            e.stopPropagation();
                            select({ roomId: r.id, surfaceId: wf.wallId, zoneId: null });
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <title>{`${wf?.name ?? ''}: двойной клик — добавить вершину`}</title>
                        </line>
                        {wf && selection.surfaceId === wf.wallId && <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#ff7a1a" strokeWidth={4} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                        {label(m, `${wf ? wf.name.replace('Стена ', 'С') + ': ' : ''}${fmtMm(dist(p, q))}`, '#222', 10)}
                      </g>
                    );
                  })}
                {sel &&
                  tool === 'select' &&
                  r.polygonMm.map((p, i) => (
                    <circle
                      key={`v${i}`}
                      data-hit
                      cx={p[0]}
                      cy={p[1]}
                      r={5 * sw}
                      fill="#fff"
                      stroke={color}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: 'move' }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button === 2 || e.shiftKey) return deleteVertex(r, i);
                        setDrag({ roomId: r.id, index: i, orig: r.polygonMm });
                      }}
                    >
                      <title>Перетащить; Shift+клик или правый клик — удалить</title>
                    </circle>
                  ))}
              </g>
            );
          })}

          {/* trace draft */}
          {tool === 'trace' && draft.length > 0 && (
            <g>
              <polyline points={[...draft, ...(cursor ? [cursor] : [])].map((p) => p.join(',')).join(' ')} fill="none" stroke="#ff7a1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {draft.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={(i === 0 ? 7 : 4) * sw} fill={i === 0 ? '#ff7a1a' : '#fff'} stroke="#ff7a1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
              {cursor && label([(draft[draft.length - 1][0] + cursor[0]) / 2, (draft[draft.length - 1][1] + cursor[1]) / 2 - 12 * sw], fmtMm(dist(draft[draft.length - 1], cursor)), '#ff7a1a', 12)}
            </g>
          )}

          {/* calibration */}
          {calibWorld.length > 0 && (
            <g>
              {calibWorld.length === 2 && <line x1={calibWorld[0][0]} y1={calibWorld[0][1]} x2={calibWorld[1][0]} y2={calibWorld[1][1]} stroke="#e0245e" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
              {calibWorld.map((p, i) => (
                <g key={i}>
                  <line x1={p[0] - 8 * sw} y1={p[1]} x2={p[0] + 8 * sw} y2={p[1]} stroke="#e0245e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <line x1={p[0]} y1={p[1] - 8 * sw} x2={p[0]} y2={p[1] + 8 * sw} stroke="#e0245e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </g>
          )}
          {plan?.calibration && tool === 'calibrate' && calibPts.length === 0 && (
            <line x1={plan.calibration.p1[0] * k} y1={plan.calibration.p1[1] * k} x2={plan.calibration.p2[0] * k} y2={plan.calibration.p2[1] * k} stroke="#e0245e" strokeDasharray="4 3" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          )}

          {/* measure */}
          {measurePts.length > 0 && (
            <g>
              {measurePts.length === 2 && <line x1={measurePts[0][0]} y1={measurePts[0][1]} x2={measurePts[1][0]} y2={measurePts[1][1]} stroke="#00897b" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
              {measurePts.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={4 * sw} fill="#00897b" />
              ))}
              {measurePts.length === 2 && label([(measurePts[0][0] + measurePts[1][0]) / 2, (measurePts[0][1] + measurePts[1][1]) / 2 - 12 * sw], fmtMm(measureLen), '#00897b', 13)}
            </g>
          )}

          {cursor && (tool === 'calibrate' || tool === 'measure' || tool === 'trace') && (
            <g pointerEvents="none">
              <line x1={cursor[0] - 14 * sw} y1={cursor[1]} x2={cursor[0] + 14 * sw} y2={cursor[1]} stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <line x1={cursor[0]} y1={cursor[1] - 14 * sw} x2={cursor[0]} y2={cursor[1] + 14 * sw} stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </g>
      </svg>

      <div className="plan-hud">
        {tool === 'calibrate' && (
          <div className="hud-card">
            <b>Калибровка.</b> Кликните два конца известной размерной линии (колесо — зум, правая кнопка/Alt — панорама).
            {calibPts.length === 2 && (
              <div className="row">
                <span>{calibPxLen.toFixed(1)} пикс =</span>
                <input type="number" value={calibLen} onChange={(e) => setCalibLen(e.target.value)} autoFocus style={{ width: 90 }} />
                <span>мм</span>
                <button className="primary" onClick={() => setCalibration(calibPts[0], calibPts[1], parseFloat(calibLen))}>
                  Применить
                </button>
              </div>
            )}
          </div>
        )}
        {tool === 'measure' && (
          <div className="hud-card">
            <b>Контрольный отрезок.</b> {measurePts.length < 2 ? 'Кликните две точки.' : `Измерено: ${measureLen.toFixed(1)} мм.`}
            {measurePts.length === 2 && (
              <div className="row">
                <span>По чертежу:</span>
                <input type="number" value={measureExpected} onChange={(e) => setMeasureExpected(e.target.value)} style={{ width: 90 }} placeholder="мм" />
                {expected > 0 && (
                  <span className={Math.abs(measureLen - expected) / expected > 0.01 ? 'warn' : 'ok'}>
                    расхождение {(measureLen - expected).toFixed(1)} мм ({(((measureLen - expected) / expected) * 100).toFixed(2)}%)
                    {Math.abs(measureLen - expected) / expected > 0.01 ? ' — подложка может быть искажена' : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {tool === 'trace' && (
          <div className="hud-card">
            <b>Обводка: {room?.name}.</b> Клики — вершины; привязка к вершинам и ортогональность (Shift — без орто). Клик в первую точку / Enter — замкнуть; Backspace — убрать точку; Esc — отмена.
            {draft.length >= 3 && (
              <button className="primary" onClick={finishDraft}>
                Замкнуть ({draft.length})
              </button>
            )}
          </div>
        )}
        {plan && !calibrated && tool !== 'calibrate' && <div className="hud-card warn">План не откалиброван — обводка недоступна. Нажмите «Калибровка».</div>}
      </div>
      <div className="plan-coords">
        {cursor ? `x ${Math.round(cursor[0])} · y ${Math.round(cursor[1])} ${calibrated || !plan ? 'мм' : 'пикс'}` : ''}
        <button onClick={fit}>Вписать</button>
      </div>
    </div>
  );
}
