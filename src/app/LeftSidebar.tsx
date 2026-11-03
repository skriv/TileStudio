import { useState } from 'react';
import { ringArea } from '../core/geometry/polygon';
import { wallFrames } from '../core/geometry/room';
import { checkTileAspect } from '../core/tiling/material';
import { useStore, select, selectZone, setView, updatePlan, toast, findZone, assignMaterial } from '../state/store';
import { Section } from './fields';
import { AddTileModal } from './AddTileModal';

export function LeftSidebar() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);

  return (
    <aside className="sidebar left">
      <Section title="Помещения">
        <ul className="tree">
          {project.rooms.map((r) => {
            const open = selection.roomId === r.id;
            const status = !r.polygonMm.length ? 'нет контура' : !r.confirmed ? 'не подтверждён' : `${(ringArea(r.polygonMm) / 1e6).toFixed(2)} м²`;
            const frames = r.confirmed ? wallFrames(r) : [];
            const surfaces = r.confirmed ? [{ id: 'floor', name: 'Пол' }, ...frames.map((f) => ({ id: f.wallId, name: `${f.name} · ${Math.round(f.lengthMm)} мм` }))] : [];
            return (
              <li key={r.id} className={open ? 'open' : ''}>
                <div className={`node room ${open && !selection.surfaceId ? 'sel' : ''}`} onClick={() => select({ roomId: r.id, surfaceId: null, zoneId: null })}>
                  <span className={`dot ${r.id}`} />
                  {r.name}
                  <span className="meta">{status}</span>
                </div>
                {open && (
                  <ul>
                    {surfaces.map((s) => {
                      const zones = r.zones.filter((z) => z.surfaceId === s.id);
                      const ssel = selection.surfaceId === s.id;
                      const nOpen = r.openings.filter((o) => o.wallId === s.id).length;
                      return (
                        <li key={s.id}>
                          <div
                            className={`node surface ${ssel && !selection.zoneId ? 'sel' : ''}`}
                            onClick={() => {
                              select({ roomId: r.id, surfaceId: s.id, zoneId: null });
                              if (view === 'plan') setView('surface');
                            }}
                          >
                            {s.name}
                            <span className="meta">
                              {nOpen ? `${nOpen} пр. · ` : ''}
                              {zones.length ? `${zones.length} зон` : ''}
                            </span>
                          </div>
                          {zones.length > 0 && (
                            <ul>
                              {zones.map((z) => {
                                const a = project.assignments.find((x) => x.zoneId === z.id);
                                const m = a && project.materials.find((x) => x.id === a.materialId);
                                return (
                                  <li key={z.id}>
                                    <div className={`node zone ${selection.zoneId === z.id ? 'sel' : ''}`} onClick={() => selectZone(z.id)}>
                                      {z.name}
                                      <span className={`meta ${m ? '' : 'none'}`}>{m ? m.name : 'без материала'}</span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <p className="hint">Пилот: только Кухня, Туалет, Коридор. Другие помещения не моделируются.</p>
      </Section>

      <MaterialLibrary />

      {project.plan && (
        <Section title="Подложка">
          <label className="chk">
            <input type="checkbox" checked={project.plan.visible} onChange={(e) => updatePlan({ visible: e.target.checked })} /> Показывать план
          </label>
          <label className="field">
            <span className="field-label">Прозрачность</span>
            <input type="range" min={0.1} max={1} step={0.05} value={project.plan.opacity} onChange={(e) => updatePlan({ opacity: parseFloat(e.target.value) })} />
          </label>
        </Section>
      )}
    </aside>
  );
}

function MaterialLibrary() {
  const project = useStore((s) => s.project);
  const assetUrls = useStore((s) => s.assetUrls);
  const selection = useStore((s) => s.selection);
  const [adding, setAdding] = useState(false);
  const applyFromLibrary = (materialId: string) => {
    select({ materialId });
    const f = findZone(project, selection.zoneId);
    if (!f) {
      toast('Сначала обведите зону: 3D → «✏ Обвести зону», затем нажмите на плитку.');
      return;
    }
    assignMaterial(f.zone.id, materialId);
    const m = project.materials.find((x) => x.id === materialId);
    toast(`«${m?.name}» → ${f.zone.name}`, 'ok');
  };
  return (
    <Section
      title="Библиотека плитки"
      actions={
        <button className="small" onClick={() => setAdding(true)}>
          + Плитка
        </button>
      }
    >
      <div className="mat-grid">
        {project.materials.map((m) => {
          const ok = checkTileAspect(m.imageWidthPx, m.imageHeightPx, m.widthMm, m.heightMm).ok;
          return (
            <button key={m.id} className={`mat-card ${selection.materialId === m.id ? 'sel' : ''}`} onClick={() => applyFromLibrary(m.id)} title={selection.zoneId ? `Применить к выбранной зоне (${m.fileName})` : m.fileName}>
              <div className="thumb">{assetUrls[m.assetId] && <img src={assetUrls[m.assetId]} alt={m.name} />}</div>
              <div className="mat-name">{m.name}</div>
              <div className={`mat-size ${ok ? '' : 'warn'}`}>
                {m.widthMm}×{m.heightMm} мм{ok ? '' : ' ⚠'}
              </div>
            </button>
          );
        })}
        {!project.materials.length && <p className="hint">Нет плитки. Загрузите изображение одной плитки и задайте её размер в мм.</p>}
      </div>
      {adding && <AddTileModal onClose={() => setAdding(false)} />}
    </Section>
  );
}

