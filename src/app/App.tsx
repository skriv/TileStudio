import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore, bootstrap, undo, redo, setView } from '../state/store';
import { TopBar } from './TopBar';
import { LeftSidebar } from './LeftSidebar';
import { RightPanel } from './RightPanel';
import { PlanEditor } from '../features/plan-editor/PlanEditor';
import { SurfaceEditor } from '../features/zones/SurfaceEditor';

const Viewport3D = lazy(() => import('../features/viewport/Viewport3D').then((m) => ({ default: m.Viewport3D })));
const PhotoRender = lazy(() => import('../features/render/PhotoRender').then((m) => ({ default: m.PhotoRender })));

export function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const toasts = useStore((s) => s.toasts);
  const [modelOnly, setModelOnly] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (!mod && e.key === '1') setView('plan');
      else if (!mod && e.key === '2') setView('3d');
      else if (!mod && e.key === '3') setView('render');
      else if (e.key === 'Escape') setModelOnly(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().saveState === 'dirty') e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (!ready) return <div className="boot">Загрузка проекта…</div>;

  return (
    <div className={`app ${modelOnly ? 'model-only' : ''} ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''}`}>
      <TopBar
        onOpenLeft={() => {
          setRightOpen(false);
          setLeftOpen(!leftOpen);
        }}
        onOpenRight={() => {
          setLeftOpen(false);
          setRightOpen(!rightOpen);
        }}
        onModelOnly={() => {
          setView('3d');
          setLeftOpen(false);
          setRightOpen(false);
          setModelOnly(true);
        }}
      />
      <div className="workspace">
        {(leftOpen || rightOpen) && <button className="drawer-backdrop" aria-label="Закрыть панель" onClick={() => (setLeftOpen(false), setRightOpen(false))} />}
        <LeftSidebar />
        <main className="stage">
          <Suspense fallback={<div className="empty-state">Загрузка 3D…</div>}>
            {view === 'plan' && <PlanEditor />}
            {view === 'surface' && <SurfaceEditor />}
            {view === '3d' && <Viewport3D />}
            {view === 'render' && <PhotoRender />}
          </Suspense>
        </main>
        <RightPanel />
      </div>
      {modelOnly && (
        <button className="model-only-exit" onClick={() => setModelOnly(false)}>
          Панели
        </button>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
