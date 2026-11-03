import { useState } from 'react';
import { dist, multiPolygonArea, rectRing, ringArea, type Vec2 } from '../core/geometry/polygon';
import { surfaceName, wallFrames } from '../core/geometry/room';
import { checkTileAspect } from '../core/tiling/material';
import { footprintFor, type RowOffset, type TileRotation } from '../core/tiling/layout';
import type { Opening, Room } from '../core/project/types';
import {
  useStore,
  getRoom,
  findZone,
  setPlanTool,
  setPlanPage,
  setRoomPolygon,
  confirmRoom,
  clearRoom,
  setRoomHeight,
  addOpening,
  updateOpening,
  removeOpening,
  renameWall,
  renameZone,
  deleteZone,
  moveZoneOrder,
  setZoneEditMode,
  assignMaterial,
  updateAssignment,
  setMaterialRotation,
  clearAssignment,
  updateMaterial,
  removeMaterial,
  finishRoughness,
  updateRender,
  select,
  setView,
  loadPilotPlan,
  createZone,
  toast,
} from '../state/store';
import { resolveZoneLayout } from '../features/viewport/zoneLayout';
import { GroutColorField, NumField, Section, TextField } from './fields';

export function RightPanel() {
  const view = useStore((s) => s.view);
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const zone = findZone(project, selection.zoneId);
  const room = getRoom(project, selection.roomId);
  const material = project.materials.find((m) => m.id === selection.materialId);

  return (
    <aside className="sidebar right">
      {material && <MaterialPanel id={material.id} />}
      {view === 'plan' && <PlanPanel />}
      {view !== 'plan' && zone && <ZonePanel zoneId={zone.zone.id} />}
      {view !== 'plan' && !zone && room && selection.surfaceId && room.confirmed && <SurfacePanel room={room} surfaceId={selection.surfaceId} />}
      {view !== 'plan' && !zone && room && !selection.surfaceId && <RoomSummary room={room} />}
      {(view === '3d' || view === 'render') && <RenderPanel />}
    </aside>
  );
}

// ---------------- plan ----------------

function PlanPanel() {
  const project = useStore((s) => s.project);
  const tool = useStore((s) => s.planTool);
  const selection = useStore((s) => s.selection);
  const plan = project.plan;
  const room = getRoom(project, selection.roomId);

  return (
    <>
      <Section title="План">
        {!plan ? (
          <>
            <p className="hint">План не загружен. Импортируйте PDF/PNG/JPG/WebP (кнопка сверху) или откройте пилотный room_scheme.pdf.</p>
            <button className="primary" onClick={loadPilotPlan}>
              Открыть room_scheme.pdf
            </button>
            <p className="hint">Можно работать и без плана: обводка по сетке 1 ед. = 1 мм и ввод координат вручную.</p>
          </>
        ) : (
          <>
            <div className="kv">
              <span>Файл</span>
              <b>{plan.fileName}</b>
            </div>
            {plan.kind === 'pdf' && (
              <div className="kv">
                <span>Страница</span>
                <select value={plan.page} onChange={(e) => setPlanPage(Number(e.target.value))}>
                  {Array.from({ length: plan.pageCount }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1} / {plan.pageCount}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="kv">
              <span>Масштаб</span>
              {plan.calibration ? (
                <b>
                  {plan.calibration.mmPerPx.toFixed(4)} мм/пикс ({plan.calibration.lengthMm} мм)
                </b>
              ) : (
                <b className="warn">не откалиброван</b>
              )}
            </div>
          </>
        )}
        <div className="tools">
          {plan && (
            <button className={tool === 'calibrate' ? 'active' : ''} onClick={() => setPlanTool(tool === 'calibrate' ? 'select' : 'calibrate')}>
              Калибровка
            </button>
          )}
          <button className={tool === 'measure' ? 'active' : ''} onClick={() => setPlanTool(tool === 'measure' ? 'select' : 'measure')} disabled={!!plan && !plan.calibration}>
            Контр. отрезок
          </button>
          <button className={tool === 'select' ? 'active' : ''} onClick={() => setPlanTool('select')}>
            Выбор / правка
          </button>
        </div>
      </Section>
      {room && <RoomGeometryPanel room={room} />}
    </>
  );
}

function RoomGeometryPanel({ room }: { room: Room }) {
  const tool = useStore((s) => s.planTool);
  const plan = useStore((s) => s.project.plan);
  const [rw, setRw] = useState('');
  const [rd, setRd] = useState('');
  const canTrace = !plan || !!plan.calibration;
  const poly = room.polygonMm;
  const frames = poly.length >= 3 ? wallFrames(room) : [];

  const setVertex = (i: number, axis: 0 | 1, v: number) => {
    const next = poly.map((p, j) => (j === i ? ((axis === 0 ? [v, p[1]] : [p[0], v]) as Vec2) : p));
    setRoomPolygon(room.id, next);
  };

  const setEdgeLength = (i: number, len: number) => {
    const a = poly[i];
    const j = (i + 1) % poly.length;
    const b = poly[j];
    const d = dist(a, b);
    if (d < 1e-6 || len <= 0) return;
    const nb: Vec2 = [a[0] + ((b[0] - a[0]) / d) * len, a[1] + ((b[1] - a[1]) / d) * len];
    const dx = nb[0] - b[0];
    const dy = nb[1] - b[1];
    setRoomPolygon(
      room.id,
      poly.map((p, k) => (k === j ? ([p[0] + dx, p[1] + dy] as Vec2) : p)),
    );
  };

  return (
    <Section title={`Помещение: ${room.name}`}>
      <div className="kv">
        <span>Статус</span>
        <b className={room.confirmed ? 'ok' : 'warn'}>{!poly.length ? 'нет контура' : room.confirmed ? '3D построено' : 'контур не подтверждён'}</b>
      </div>
      {poly.length >= 3 && (
        <div className="kv">
          <span>Площадь / периметр</span>
          <b>
            {(ringArea(poly) / 1e6).toFixed(3)} м² · {Math.round(frames.reduce((s, f) => s + f.lengthMm, 0))} мм
          </b>
        </div>
      )}
      <div className="tools">
        <button
          className={tool === 'trace' ? 'active' : ''}
          disabled={!canTrace}
          onClick={() => {
            if (room.zones.length || room.openings.length) {
              if (!confirm(`Перерисовать контур «${room.name}»? Зоны и проёмы этого помещения будут удалены.`)) return;
              clearRoom(room.id);
            }
            setPlanTool('trace');
          }}
        >
          {poly.length ? 'Обвести заново' : 'Обвести контур'}
        </button>
        {poly.length >= 3 && !room.confirmed && (
          <button className="primary" onClick={() => confirmRoom(room.id, true)}>
            Подтвердить контур → 3D
          </button>
        )}
        {room.confirmed && <button onClick={() => confirmRoom(room.id, false)}>Снять подтверждение</button>}
        {poly.length > 0 && (
          <button className="danger" onClick={() => confirm(`Удалить контур «${room.name}» вместе с зонами?`) && clearRoom(room.id)}>
            Очистить
          </button>
        )}
      </div>
      {!poly.length && (
        <div className="quick-rect">
          <span className="muted">или прямоугольник по известным размерам:</span>
          <div className="row">
            <input type="number" placeholder="ширина" value={rw} onChange={(e) => setRw(e.target.value)} style={{ width: 72 }} />×
            <input type="number" placeholder="глубина" value={rd} onChange={(e) => setRd(e.target.value)} style={{ width: 72 }} />
            мм
            <button
              onClick={() => {
                const w = parseFloat(rw);
                const d = parseFloat(rd);
                if (!(w > 0 && d > 0)) return toast('Введите оба размера', 'error');
                setRoomPolygon(room.id, rectRing(0, 0, w, d));
              }}
            >
              Создать
            </button>
          </div>
        </div>
      )}
      <NumField label="Высота потолка" value={room.heightMm} min={1000} max={6000} onCommit={(v) => setRoomHeight(room.id, v)} />
      {poly.length > 0 && (
        <details open={poly.length <= 12}>
          <summary>
            Вершины и рёбра ({poly.length}) — ввод в мм
          </summary>
          <table className="vtable">
            <thead>
              <tr>
                <th>#</th>
                <th>x</th>
                <th>y</th>
                <th>ребро → след.</th>
              </tr>
            </thead>
            <tbody>
              {poly.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <NumField value={p[0]} unit="" width={70} precision={1} onCommit={(v) => setVertex(i, 0, v)} />
                  </td>
                  <td>
                    <NumField value={p[1]} unit="" width={70} precision={1} onCommit={(v) => setVertex(i, 1, v)} />
                  </td>
                  <td>
                    {poly.length >= 2 && <NumField value={dist(p, poly[(i + 1) % poly.length])} unit="" width={70} precision={1} onCommit={(v) => setEdgeLength(i, v)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">На плане: перетаскивание вершин, двойной клик по ребру — новая вершина, Shift/ПКМ по вершине — удалить. Размеры считываются с подложки приблизительно — сверяйте с чертежом.</p>
        </details>
      )}
      {room.confirmed && <OpeningsQuick room={room} />}
    </Section>
  );
}

function OpeningsQuick({ room }: { room: Room }) {
  const n = room.openings.length;
  return (
    <p className="hint">
      Проёмов: {n}. Чтобы добавить окно/дверь, выберите стену (клик по ребру на плане или в дереве) и откройте «Развёртку».
    </p>
  );
}

// ---------------- room / surface ----------------

function RoomSummary({ room }: { room: Room }) {
  return (
    <Section title={room.name}>
      {!room.confirmed ? (
        <p className="hint">Контур не подтверждён. Перейдите в «План», обведите и подтвердите помещение.</p>
      ) : (
        <>
          <p className="hint">Выберите пол или стену (в дереве или кликом в 3D), затем создайте зону.</p>
          <div className="tools">
            <button onClick={() => select({ surfaceId: 'floor' })}>Пол</button>
            {wallFrames(room).map((f) => (
              <button key={f.wallId} onClick={() => select({ surfaceId: f.wallId })}>
                {f.name}
              </button>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function SurfacePanel({ room, surfaceId }: { room: Room; surfaceId: string }) {
  const view = useStore((s) => s.view);
  const isFloor = surfaceId === 'floor';
  const frame = wallFrames(room).find((f) => f.wallId === surfaceId);
  const zones = room.zones.filter((z) => z.surfaceId === surfaceId);
  const wall = room.walls.find((w) => w.id === surfaceId);
  const [nz, setNz] = useState({ u: '0', v: '0', w: '', h: '' });

  return (
    <>
      <Section title={`${room.name} · ${surfaceName(room, surfaceId)}`}>
        {wall && (
          <div className="kv">
            <span>Название</span>
            <TextField value={wall.name} onCommit={(v) => renameWall(room.id, wall.id, v)} />
          </div>
        )}
        <div className="kv">
          <span>Тип</span>
          <b>{isFloor ? 'пол' : 'стена'}</b>
        </div>
        {frame && (
          <div className="kv">
            <span>Размер</span>
            <b>
              {Math.round(frame.lengthMm)} × {room.heightMm} мм
            </b>
          </div>
        )}
        {view !== 'surface' && (
          <button onClick={() => setView('surface')} className="primary">
            Открыть развёртку
          </button>
        )}
      </Section>

      <Section title="Зоны поверхности">
        {!zones.length && <p className="hint">Зон нет. Создайте зону — изначально она без материала.</p>}
        <ul className="list">
          {zones.map((z) => (
            <li key={z.id} onClick={() => select({ zoneId: z.id })}>
              {z.name} <span className="muted">{(multiPolygonArea(resolveZoneLayout(useStore.getState().project, room, z).region) / 1e6).toFixed(3)} м²</span>
            </li>
          ))}
        </ul>
        <div className="tools">
          <button onClick={() => createZone(room.id, surfaceId, 'full', [], isFloor ? 'Весь пол' : `${surfaceName(room, surfaceId)} целиком`)}>Вся поверхность</button>
        </div>
        <div className="quick-rect">
          <span className="muted">Прямоугольник по координатам (u, v — от левого нижнего угла):</span>
          <div className="row wrap">
            u <input type="number" value={nz.u} onChange={(e) => setNz({ ...nz, u: e.target.value })} style={{ width: 58 }} />
            v <input type="number" value={nz.v} onChange={(e) => setNz({ ...nz, v: e.target.value })} style={{ width: 58 }} />
            ш <input type="number" value={nz.w} onChange={(e) => setNz({ ...nz, w: e.target.value })} style={{ width: 58 }} />
            в <input type="number" value={nz.h} onChange={(e) => setNz({ ...nz, h: e.target.value })} style={{ width: 58 }} />
            мм
            <button
              onClick={() => {
                const [u, v, w, h] = [nz.u, nz.v, nz.w, nz.h].map(parseFloat);
                if (![u, v, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return toast('Заполните u, v, ширину и высоту', 'error');
                createZone(room.id, surfaceId, 'rect', rectRing(u, v, u + w, v + h));
              }}
            >
              Создать
            </button>
          </div>
        </div>
        <p className="hint">В «Развёртке» зону можно нарисовать мышью: прямоугольник или многоугольник.</p>
      </Section>

      {!isFloor && frame && <OpeningsPanel room={room} wallId={surfaceId} wallLength={frame.lengthMm} />}
    </>
  );
}

function OpeningsPanel({ room, wallId, wallLength }: { room: Room; wallId: string; wallLength: number }) {
  const ops = room.openings.filter((o) => o.wallId === wallId);
  const upd = (o: Opening, patch: Partial<Opening>) => updateOpening(room.id, o.id, patch);
  return (
    <Section
      title="Проёмы"
      actions={
        <div className="row">
          <button className="small" onClick={() => addOpening(room.id, wallId, 'window')}>
            + Окно
          </button>
          <button className="small" onClick={() => addOpening(room.id, wallId, 'door')}>
            + Проём
          </button>
        </div>
      }
    >
      {!ops.length && <p className="hint">Нет проёмов. Окно по разрезу: низ 1000 мм, высота 1000 мм. Проём — отверстие в стене, без дверного полотна.</p>}
      {ops.map((o) => {
        const bad = o.offsetMm < 0 || o.offsetMm + o.widthMm > wallLength + 0.01 || o.bottomMm + o.heightMm > room.heightMm + 0.01;
        return (
          <div key={o.id} className="opening">
            <div className="row">
              <b>{o.kind === 'window' ? 'Окно' : 'Проём'}</b>
              <span className="grow" />
              <button className="small danger" onClick={() => removeOpening(room.id, o.id)}>
                Удалить
              </button>
            </div>
            <div className="grid2">
              <NumField label="От левого края" value={o.offsetMm} min={0} onCommit={(v) => upd(o, { offsetMm: v })} width={64} />
              <NumField label="Ширина" value={o.widthMm} min={10} onCommit={(v) => upd(o, { widthMm: v })} width={64} />
              <NumField label="Низ от пола" value={o.bottomMm} min={0} onCommit={(v) => upd(o, { bottomMm: v })} width={64} />
              <NumField label="Высота" value={o.heightMm} min={10} onCommit={(v) => upd(o, { heightMm: v, heightAssumed: false })} width={64} />
            </div>
            <label className="chk">
              <input type="checkbox" checked={o.heightAssumed} onChange={(e) => upd(o, { heightAssumed: e.target.checked })} />
              Высота — предположение (не указана в чертеже)
            </label>
            {bad && <p className="warn">Проём выходит за пределы стены ({Math.round(wallLength)} × {room.heightMm} мм).</p>}
          </div>
        );
      })}
    </Section>
  );
}

// ---------------- zone ----------------

function ZonePanel({ zoneId }: { zoneId: string }) {
  const project = useStore((s) => s.project);
  const assetUrls = useStore((s) => s.assetUrls);
  const zoneEditMode = useStore((s) => s.zoneEditMode);
  const f = findZone(project, zoneId)!;
  const { room, zone } = f;
  const zl = resolveZoneLayout(project, room, zone);
  const a = zl.assignment;
  const m = zl.material;
  const area = multiPolygonArea(zl.region);

  return (
    <>
      <Section title="Зона">
        <div className="kv">
          <span>Название</span>
          <TextField value={zone.name} onCommit={(v) => renameZone(zone.id, v)} />
        </div>
        <div className="kv">
          <span>ID</span>
          <code>{zone.id}</code>
        </div>
        <div className="kv">
          <span>Поверхность</span>
          <b>
            {room.name} · {surfaceName(room, zone.surfaceId)} ({zone.surfaceId === 'floor' ? 'пол' : 'стена'})
          </b>
        </div>
        <div className="kv">
          <span>Площадь</span>
          <b>{(area / 1e6).toFixed(3)} м²</b>
        </div>
        <div className="kv">
          <span>Форма</span>
          <b>{zone.kind === 'full' ? 'вся поверхность' : zone.kind === 'rect' ? 'прямоугольник' : 'многоугольник'}</b>
        </div>
        <div className="kv">
          <span>Материал</span>
          <b className={m ? '' : 'warn'}>{m ? m.name : 'не назначен'}</b>
        </div>
        <label className="chk">
          <input type="checkbox" checked={zoneEditMode} onChange={(e) => setZoneEditMode(e.target.checked)} /> Редактировать зоны
        </label>
        {zoneEditMode && (
          <div className="tools">
            <button onClick={() => moveZoneOrder(zone.id, -1)} title="Ниже в стопке">
              ↓ Ниже
            </button>
            <button onClick={() => moveZoneOrder(zone.id, 1)} title="Выше в стопке">
              ↑ Выше
            </button>
            <button className="danger" onClick={() => confirm(`Удалить зону «${zone.name}»?`) && deleteZone(zone.id)}>
              Удалить зону
            </button>
          </div>
        )}
        {zoneEditMode && <p className="hint">Режим правки: перетаскивайте вершины зоны в «Развёртке». Смена плитки границы не меняет.</p>}
      </Section>

      <Section title="Плитка зоны">
        {!project.materials.length && <p className="hint">Библиотека пуста — загрузите плитку слева.</p>}
        <div className="mat-pick">
          {project.materials.map((mm) => (
            <button key={mm.id} className={`mat-chip ${m?.id === mm.id ? 'sel' : ''}`} onClick={() => assignMaterial(zone.id, mm.id)} title={`${mm.widthMm}×${mm.heightMm} мм`}>
              {assetUrls[mm.assetId] && <img src={assetUrls[mm.assetId]} alt="" />}
              <span>{mm.name}</span>
            </button>
          ))}
        </div>
        {!a && <p className="hint">Зона без материала — отображается нейтральной основой. Выберите плитку выше.</p>}
        {a && (
          <button className="small" onClick={() => clearAssignment(zone.id)}>
            Снять плитку
          </button>
        )}
        {zl.error && <p className="warn">{zl.error}</p>}
      </Section>

      {a && m && (
        <Section title="Раскладка">
          <div className="kv">
            <span>Поворот плитки</span>
            <div className="seg">
              {([0, 90, 180, 270] as TileRotation[]).map((r) => (
                <button key={r} className={a.rotationDeg === r ? 'active' : ''} onClick={() => { updateAssignment(zone.id, { rotationDeg: r }); setView('3d'); }}>
                  {r}°
                </button>
              ))}
            </div>
          </div>
          <div className="kv">
            <span>Размер на поверхности</span>
            <b>
              {(() => {
                const fp = footprintFor(m.widthMm, m.heightMm, a.rotationDeg);
                return `${fp.w} × ${fp.h} мм`;
              })()}
            </b>
          </div>
          <NumField label="Шов" value={a.groutMm} min={0} max={30} step={0.5} onCommit={(v) => updateAssignment(zone.id, { groutMm: v })} width={60} />
          <GroutColorField value={a.groutColor} onChange={(groutColor) => updateAssignment(zone.id, { groutColor })} />
          <div className="kv">
            <span>Точка старта</span>
            <div className="seg">
              <button className={a.anchor === 'origin' ? 'active' : ''} onClick={() => updateAssignment(zone.id, { anchor: 'origin' })}>
                От угла (u,v)
              </button>
              <button className={a.anchor === 'center' ? 'active' : ''} onClick={() => updateAssignment(zone.id, { anchor: 'center' })}>
                По центру
              </button>
            </div>
          </div>
          <div className="grid2">
            <NumField label={a.anchor === 'origin' ? 'Старт u' : 'Сдвиг u'} value={a.originMm[0]} onCommit={(v) => updateAssignment(zone.id, { originMm: [v, a.originMm[1]] })} width={60} />
            <NumField label={a.anchor === 'origin' ? 'Старт v' : 'Сдвиг v'} value={a.originMm[1]} onCommit={(v) => updateAssignment(zone.id, { originMm: [a.originMm[0], v] })} width={60} />
          </div>
          <div className="kv">
            <span>Смещение рядов</span>
            <div className="seg">
              {(
                [
                  ['none', 'нет'],
                  ['half', '1/2'],
                  ['third', '1/3'],
                ] as [RowOffset, string][]
              ).map(([k, l]) => (
                <button key={k} className={a.rowOffset === k ? 'active' : ''} onClick={() => updateAssignment(zone.id, { rowOffset: k })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <NumField label="Угол сетки" unit="°" value={a.gridAngleDeg} min={-180} max={180} onCommit={(v) => updateAssignment(zone.id, { gridAngleDeg: v })} width={60} />
          {zl.layout && (
            <div className="stats">
              <div>
                Плиток: <b>{zl.layout.tiles.length}</b> (целых <b>{zl.layout.fullCount}</b>, подрезанных <b>{zl.layout.cutCount}</b>)
              </div>
              <div>
                Шаг сетки: {zl.layout.pitchMm.x} × {zl.layout.pitchMm.y} мм
              </div>
              <div>
                Покрытие плиткой: {((zl.layout.tileAreaMm2 / Math.max(1, zl.layout.regionAreaMm2)) * 100).toFixed(1)}% (остальное — швы)
              </div>
            </div>
          )}
        </Section>
      )}
    </>
  );
}

// ---------------- material ----------------

function MaterialPanel({ id }: { id: string }) {
  const project = useStore((s) => s.project);
  const assetUrls = useStore((s) => s.assetUrls);
  const m = project.materials.find((x) => x.id === id)!;
  const aspect = checkTileAspect(m.imageWidthPx, m.imageHeightPx, m.widthMm, m.heightMm);
  const uses = project.assignments.filter((a) => a.materialId === id).length;
  const zoneId = useStore((s) => s.selection.zoneId);
  const liveRotation = project.assignments.find((a) => a.zoneId === zoneId && a.materialId === id)?.rotationDeg ?? m.defaultRotationDeg;
  return (
    <Section
      title="Плитка"
      actions={
        <button className="small" onClick={() => select({ materialId: null })}>
          ✕
        </button>
      }
    >
      <div className="mat-preview">
        {assetUrls[m.assetId] && <img src={assetUrls[m.assetId]} alt={m.name} style={{ aspectRatio: `${m.imageWidthPx} / ${m.imageHeightPx}` }} />}
        <span className="muted">Одна физическая плитка, изображение целиком</span>
      </div>
      <div className="kv">
        <span>Название</span>
        <TextField value={m.name} onCommit={(v) => updateMaterial(id, { name: v })} />
      </div>
      <div className="kv">
        <span>Файл</span>
        <b>
          {m.fileName} · {m.imageWidthPx}×{m.imageHeightPx} px
        </b>
      </div>
      <div className="grid2">
        <NumField label="Ширина" value={m.widthMm} min={1} onCommit={(v) => updateMaterial(id, { widthMm: v })} width={64} />
        <NumField label="Высота" value={m.heightMm} min={1} onCommit={(v) => updateMaterial(id, { heightMm: v })} width={64} />
      </div>
      {aspect.ok ? (
        <p className="ok small">Пропорции изображения совпадают с размером ({(aspect.mismatch * 100).toFixed(2)}%).</p>
      ) : (
        <p className="warn">
          Пропорции не совпадают ({(aspect.mismatch * 100).toFixed(1)}%) — плитка будет искажена. Проверьте ширину/высоту.
        </p>
      )}
      <div className="kv">
        <span>Поворот</span>
        <select value={liveRotation} onChange={(e) => setMaterialRotation(id, Number(e.target.value) as TileRotation)}>
          {[0, 90, 180, 270].map((r) => (
            <option key={r} value={r}>
              {r}° {r % 180 ? `(${m.heightMm}×${m.widthMm})` : `(${m.widthMm}×${m.heightMm})`}
            </option>
          ))}
        </select>
      </div>
      <div className="kv">
        <span>Поверхность</span>
        <div className="seg">
          {(
            [
              ['matte', 'мат'],
              ['satin', 'сатин'],
              ['gloss', 'глянец'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={m.finish === k ? 'active' : ''} onClick={() => updateMaterial(id, { finish: k, roughness: finishRoughness(k) })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field-label">Roughness {m.roughness.toFixed(2)}</span>
        <input type="range" min={0.02} max={1} step={0.01} value={m.roughness} onChange={(e) => updateMaterial(id, { roughness: parseFloat(e.target.value) })} />
      </label>
      <p className="hint">Поворот сразу меняет раскладку во всех зонах с этой плиткой ({uses}) и в 3D.</p>
      <button
        className="danger small"
        onClick={() => confirm(`Удалить «${m.name}» из библиотеки${uses ? ` и снять с ${uses} зон` : ''}?`) && removeMaterial(id)}
      >
        Удалить из библиотеки
      </button>
    </Section>
  );
}

// ---------------- render ----------------

function RenderPanel() {
  const r = useStore((s) => s.project.render);
  const presets: [number, number][] = [
    [1280, 720],
    [1920, 1080],
    [2560, 1440],
    [1080, 1350],
  ];
  return (
    <Section title="Свет, камера, рендер">
      <label className="field">
        <span className="field-label">Экспозиция {r.exposure.toFixed(2)}</span>
        <input type="range" min={0.2} max={3} step={0.05} value={r.exposure} onChange={(e) => updateRender({ exposure: parseFloat(e.target.value) })} />
      </label>
      <label className="field">
        <span className="field-label">Солнце {r.sunIntensity.toFixed(1)}</span>
        <input type="range" min={0} max={8} step={0.1} value={r.sunIntensity} onChange={(e) => updateRender({ sunIntensity: parseFloat(e.target.value) })} />
      </label>
      <div className="grid2">
        <NumField label="Азимут" unit="°" value={r.sunAzimuthDeg} min={0} max={360} onCommit={(v) => updateRender({ sunAzimuthDeg: v })} width={56} />
        <NumField label="Высота" unit="°" value={r.sunElevationDeg} min={1} max={89} onCommit={(v) => updateRender({ sunElevationDeg: v })} width={56} />
      </div>
      <label className="field">
        <span className="field-label">Потолочный свет {r.ceilingLightIntensity.toFixed(2)}</span>
        <input type="range" min={0} max={4} step={0.05} value={r.ceilingLightIntensity} onChange={(e) => updateRender({ ceilingLightIntensity: parseFloat(e.target.value) })} />
      </label>
      <label className="field">
        <span className="field-label">Рассеянный / небо {r.ambientIntensity.toFixed(2)}</span>
        <input type="range" min={0} max={2} step={0.05} value={r.ambientIntensity} onChange={(e) => updateRender({ ambientIntensity: parseFloat(e.target.value) })} />
      </label>
      <div className="grid2">
        <label className="field">
          <span className="field-label">Стены</span>
          <input type="color" value={r.wallColor} onChange={(e) => updateRender({ wallColor: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Потолок</span>
          <input type="color" value={r.ceilingColor} onChange={(e) => updateRender({ ceilingColor: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Основа пола</span>
          <input type="color" value={r.floorBaseColor} onChange={(e) => updateRender({ floorBaseColor: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Разрешение экспорта</span>
        <select
          value={`${r.outputWidth}x${r.outputHeight}`}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            updateRender({ outputWidth: w, outputHeight: h });
          }}
        >
          {presets.map(([w, h]) => (
            <option key={`${w}x${h}`} value={`${w}x${h}`}>
              {w}×{h}
            </option>
          ))}
        </select>
      </label>
      <NumField label="Сэмплов Photo Render" unit="spp" value={r.maxSamples} min={8} max={4096} onCommit={(v) => updateRender({ maxSamples: Math.round(v) })} width={64} />
      <p className="hint">Свет и экспозиция не меняют геометрию плиток и швов.</p>
    </Section>
  );
}
