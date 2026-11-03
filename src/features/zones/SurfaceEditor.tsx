import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bboxOfMulti, dist, rectRing, type MultiPolygon, type Vec2 } from '../../core/geometry/polygon';
import { surfaceName, surfaceOpenings, surfaceOutline } from '../../core/geometry/room';
import { imageUVToFootprint, type TileInstance, type TileRotation } from '../../core/tiling/layout';
import { useStore, getRoom, createZone, selectZone, updateZoneGeometry, toast, select } from '../../state/store';
import { resolveZoneLayout } from '../viewport/zoneLayout';
import type { Room } from '../../core/project/types';

type ZoneTool = 'select' | 'rect' | 'polygon';

const pathOf = (mp: MultiPolygon) => mp.map((p) => [p.outer, ...p.holes].map((r) => 'M' + r.map((q) => `${q[0]},${q[1]}`).join('L') + 'Z').join(' ')).join(' ');

/** SVG matrix mapping the unit image square (x right, y down) onto the full physical tile on the surface. */
function tileImageMatrix(t: TileInstance, rot: TileRotation): string {
  const [c0, c1, , c3] = t.fullCornersMm;
  const toLocal = (px: number, py: number): Vec2 => {
    const [s, tt] = imageUVToFootprint(px, 1 - py, rot);
    return [c0[0] + s * (c1[0] - c0[0]) + tt * (c3[0] - c0[0]), c0[1] + s * (c1[1] - c0[1]) + tt * (c3[1] - c0[1])];
  };
  const o = toLocal(0, 0);
  const ex = toLocal(1, 0);
  const ey = toLocal(0, 1);
  return `matrix(${ex[0] - o[0]} ${ex[1] - o[1]} ${ey[0] - o[0]} ${ey[1] - o[1]} ${o[0]} ${o[1]})`;
}

export function SurfaceEditor() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const assetUrls = useStore((s) => s.assetUrls);
  const zoneEditMode = useStore((s) => s.zoneEditMode);
  const room = getRoom(project, selection.roomId);
  const surfaceId = selection.surfaceId;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tool, setTool] = useState<ZoneTool>('select');
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [rectStart, setRectStart] = useState<Vec2 | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [hoverTile, setHoverTile] = useState<{ zone: string; tile: TileInstance } | null>(null);
  const [vdrag, setVdrag] = useState<{ zoneId: string; index: number; poly: Vec2[] } | null>(null);
  const [showTiles, setShowTiles] = useState(true);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const outline = useMemo(() => (room && surfaceId ? surfaceOutline(room, surfaceId) : []), [room, surfaceId]);
  const openings = useMemo(() => (room && surfaceId ? surfaceOpenings(room, surfaceId) : []), [room, surfaceId]);
  const zones = room && surfaceId ? room.zones.filter((z) => z.surfaceId === surfaceId) : [];

  const bb = outline.length ? bboxOfMulti(outline) : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const pad = 70;
  const s = Math.min((size.w - pad * 2) / Math.max(1, bb.maxX - bb.minX), (size.h - pad * 2 - 40) / Math.max(1, bb.maxY - bb.minY));
  const tx = (size.w - (bb.maxX - bb.minX) * s) / 2 - bb.minX * s;
  const ty = (size.h + 40 + (bb.maxY - bb.minY) * s) / 2 + bb.minY * s;
  const sw = 1 / s;

  const toLocal = useCallback(
    (e: { clientX: number; clientY: number }): Vec2 => {
      const r = svgRef.current!.getBoundingClientRect();
      return [(e.clientX - r.left - tx) / s, -(e.clientY - r.top - ty) / s];
    },
    [tx, ty, s],
  );

  /** Snap to 5 mm, to outline/opening/zone vertices and their x/y. */
  const snap = (p: Vec2): Vec2 => {
    const th = 8 / s;
    const keys: Vec2[] = [];
    outline.forEach((pp) => keys.push(...pp.outer));
    openings.forEach((pp) => keys.push(...pp.outer));
    zones.forEach((z) => keys.push(...z.polygonMm));
    draft.forEach((d) => keys.push(d));
    let best: Vec2 | null = null;
    let bd = th;
    for (const k of keys) {
      const d = dist(k, p);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    if (best) return [best[0], best[1]];
    let [x, y] = [Math.round(p[0] / 5) * 5, Math.round(p[1] / 5) * 5];
    for (const k of keys) {
      if (Math.abs(k[0] - p[0]) < th) x = k[0];
      if (Math.abs(k[1] - p[1]) < th) y = k[1];
    }
    return [x, y];
  };

  useEffect(() => {
    setDraft([]);
    setRectStart(null);
  }, [tool, surfaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'Escape') {
        setDraft([]);
        setRectStart(null);
        setTool('select');
      }
      if (!room || !surfaceId || !room.confirmed) return;
      if (e.key === 'Enter' && tool === 'polygon') finishPolygon();
      if (e.key === 'Backspace' && tool === 'polygon') setDraft((d) => d.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!room || !surfaceId || !room.confirmed) {
    return (
      <div className="empty-state">
        <h3>Выберите поверхность</h3>
        <p>Выберите пол или стену подтверждённого помещения в дереве слева, кликом по ребру на плане или по поверхности в 3D.</p>
      </div>
    );
  }

  const finishPolygon = () => {
    if (draft.length < 3) return toast('Нужно минимум 3 точки.', 'error');
    if (createZone(room.id, surfaceId, 'polygon', draft)) setTool('select');
    setDraft([]);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = snap(toLocal(e));
    if (tool === 'rect') setRectStart(p);
    else if (tool === 'polygon') {
      if (draft.length >= 3 && dist(p, draft[0]) < 10 / s) return finishPolygon();
      setDraft((d) => [...d, p]);
    } else if (!(e.target as Element).closest('[data-hit]')) select({ zoneId: null });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = snap(toLocal(e));
    setCursor(p);
    if (vdrag) setVdrag({ ...vdrag, poly: vdrag.poly.map((q, i) => (i === vdrag.index ? p : q)) });
  };

  const onUp = () => {
    if (tool === 'rect' && rectStart && cursor) {
      const [x0, x1] = [Math.min(rectStart[0], cursor[0]), Math.max(rectStart[0], cursor[0])];
      const [y0, y1] = [Math.min(rectStart[1], cursor[1]), Math.max(rectStart[1], cursor[1])];
      setRectStart(null);
      if (x1 - x0 < 10 || y1 - y0 < 10) return;
      if (createZone(room.id, surfaceId, 'rect', rectRing(x0, y0, x1, y1))) setTool('select');
    }
    if (vdrag) {
      updateZoneGeometry(vdrag.zoneId, vdrag.poly);
      setVdrag(null);
    }
  };

  const textAt = (p: Vec2, t: string, color = '#222', fs = 11) => (
    <text transform={`translate(${p[0]} ${p[1]}) scale(${sw} ${-sw})`} fontSize={fs} fill={color} textAnchor="middle" dominantBaseline="middle" stroke="#fff" strokeWidth={3} style={{ paintOrder: 'stroke' }} pointerEvents="none">
      {t}
    </text>
  );

  const W = bb.maxX - bb.minX;
  const H = bb.maxY - bb.minY;

  return (
    <div className="surface-editor">
      <div className="se-toolbar">
        <b>
          {room.name} · {surfaceName(room, surfaceId)}
        </b>
        <span className="muted">
          {Math.round(W)} × {Math.round(H)} мм · локальные оси: u →, v ↑ {surfaceId === 'floor' ? '(вид сверху)' : '(вид изнутри помещения)'}
        </span>
        <span className="grow" />
        <span className="muted">Создать зону:</span>
        <button onClick={() => createZone(room.id, surfaceId, 'full', [], surfaceId === 'floor' ? 'Весь пол' : `${surfaceName(room, surfaceId)} целиком`)}>Вся поверхность</button>
        <button className={tool === 'rect' ? 'active' : ''} onClick={() => setTool(tool === 'rect' ? 'select' : 'rect')}>
          Прямоугольник
        </button>
        <button className={tool === 'polygon' ? 'active' : ''} onClick={() => setTool(tool === 'polygon' ? 'select' : 'polygon')}>
          Многоугольник
        </button>
        <label className="chk">
          <input type="checkbox" checked={showTiles} onChange={(e) => setShowTiles(e.target.checked)} /> Плитки
        </label>
      </div>
      <div className="se-canvas">
        <svg ref={svgRef} width={size.w} height={size.h} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)} className={`tool-${tool}`}>
          <defs>
            <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" stroke="#9aa" strokeWidth="2" />
            </pattern>
          </defs>
          <g transform={`translate(${tx} ${ty}) scale(${s} ${-s})`}>
            <path d={pathOf(outline)} fill={surfaceId === 'floor' ? '#ddd8d0' : '#f1eee9'} stroke="#333" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {zones.map((z) => {
              const zl = resolveZoneLayout(project, room, z);
              const sel = selection.zoneId === z.id;
              const url = zl.material ? assetUrls[zl.material.assetId] : undefined;
              return (
                <g key={z.id}>
                  <path
                    data-hit
                    d={pathOf(zl.region)}
                    fill={zl.assignment ? zl.assignment.groutColor : '#c9c4bb'}
                    fillOpacity={zl.assignment ? 1 : 0.5}
                    fillRule="evenodd"
                    onPointerDown={(e) => {
                      if (tool !== 'select') return;
                      e.stopPropagation();
                      selectZone(z.id);
                    }}
                    style={{ cursor: tool === 'select' ? 'pointer' : undefined }}
                  />
                  {showTiles &&
                    zl.layout &&
                    url &&
                    zl.assignment &&
                    zl.layout.tiles.map((t) => {
                      const cid = `c-${z.id}-${t.id}`;
                      return (
                        <g key={t.id} onPointerEnter={() => setHoverTile({ zone: z.id, tile: t })} onPointerLeave={() => setHoverTile(null)} data-hit onPointerDown={(e) => {
                          if (tool !== 'select') return;
                          e.stopPropagation();
                          selectZone(z.id);
                        }}>
                          {!t.isFull && (
                            <clipPath id={cid}>
                              <path d={pathOf(t.fragment.polygons)} />
                            </clipPath>
                          )}
                          <g clipPath={t.isFull ? undefined : `url(#${cid})`}>
                            <image href={url} width={1} height={1} preserveAspectRatio="none" transform={tileImageMatrix(t, zl.assignment!.rotationDeg)} />
                          </g>
                        </g>
                      );
                    })}
                  <path d={pathOf(zl.region)} fill="none" stroke={sel ? '#ff7a1a' : '#555'} strokeWidth={sel ? 2.5 : 1} strokeDasharray={sel ? undefined : '5 4'} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                  {zl.region[0] && textAt(centerOf(zl.region), `${z.name}${zl.material ? '' : ' · без материала'}`, sel ? '#c25400' : '#333', 12)}
                </g>
              );
            })}
            {openings.map((o, i) => (
              <g key={i}>
                <path d={pathOf([o])} fill="url(#hatch)" stroke="#007f99" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
            {room.openings
              .filter((o) => o.wallId === surfaceId)
              .map((o) => textAt([o.offsetMm + o.widthMm / 2, o.bottomMm + o.heightMm / 2], `${o.kind === 'window' ? 'Окно' : 'Проём'} ${o.widthMm}×${o.heightMm}${o.heightAssumed ? ' (H — предп.)' : ''}`, '#007f99', 11))}

            {/* selected zone vertex handles (edit mode only) */}
            {zoneEditMode &&
              tool === 'select' &&
              zones
                .filter((z) => z.id === selection.zoneId)
                .map((z) => {
                  const poly = vdrag?.zoneId === z.id ? vdrag.poly : z.polygonMm;
                  return (
                    <g key={z.id}>
                      <polygon points={poly.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ff7a1a" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                      {poly.map((p, i) => (
                        <circle
                          key={i}
                          data-hit
                          cx={p[0]}
                          cy={p[1]}
                          r={5 * sw}
                          fill="#fff"
                          stroke="#ff7a1a"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: 'move' }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setVdrag({ zoneId: z.id, index: i, poly: z.polygonMm });
                          }}
                        />
                      ))}
                    </g>
                  );
                })}

            {/* drafts */}
            {tool === 'rect' && rectStart && cursor && (
              <polygon points={rectRing(rectStart[0], rectStart[1], cursor[0], cursor[1]).map((p) => p.join(',')).join(' ')} fill="#ff7a1a" fillOpacity={0.15} stroke="#ff7a1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            )}
            {tool === 'rect' &&
              rectStart &&
              cursor &&
              textAt([(rectStart[0] + cursor[0]) / 2, (rectStart[1] + cursor[1]) / 2], `${Math.abs(Math.round(cursor[0] - rectStart[0]))} × ${Math.abs(Math.round(cursor[1] - rectStart[1]))} мм`, '#c25400', 12)}
            {tool === 'polygon' && draft.length > 0 && (
              <polyline points={[...draft, ...(cursor ? [cursor] : [])].map((p) => p.join(',')).join(' ')} fill="none" stroke="#ff7a1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            )}
            {tool === 'polygon' && draft.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={(i ? 4 : 7) * sw} fill={i ? '#fff' : '#ff7a1a'} stroke="#ff7a1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}

            {/* dimensions */}
            {textAt([(bb.minX + bb.maxX) / 2, bb.minY - 22 * sw], `${Math.round(W)} мм`, '#000', 12)}
            {textAt([bb.minX - 34 * sw, (bb.minY + bb.maxY) / 2], `${Math.round(H)} мм`, '#000', 12)}
          </g>
        </svg>
        <div className="se-info">
          {cursor && (
            <span>
              u {Math.round(cursor[0])} · v {Math.round(cursor[1])} мм
            </span>
          )}
          {hoverTile && (
            <span>
              Плитка {hoverTile.tile.id}: {hoverTile.tile.isFull ? 'целая' : 'подрезка'} · {Math.round(hoverTile.tile.footprintMm.w)}×{Math.round(hoverTile.tile.footprintMm.h)} мм ·{' '}
              {(hoverTile.tile.areaMm2 / hoverTile.tile.fullAreaMm2 * 100).toFixed(1)}% площади
            </span>
          )}
          {tool === 'rect' && <span>Протяните прямоугольник (привязка 5 мм и к углам/проёмам). Esc — отмена.</span>}
          {tool === 'polygon' && <span>Клики — вершины; клик в первую / Enter — замкнуть; Backspace — убрать точку.</span>}
          {!zoneEditMode && tool === 'select' && <span className="muted">Границы зон зафиксированы.</span>}
        </div>
      </div>
    </div>
  );
}

function centerOf(mp: MultiPolygon): Vec2 {
  const b = bboxOfMulti(mp);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

export type { Room };
