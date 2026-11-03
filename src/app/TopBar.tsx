import { useRef, useState } from 'react';
import { listProjects } from '../storage/db';
import {
  openStoredProject,
  useStore,
  setView,
  undo,
  redo,
  saveNow,
  exportProjectFile,
  importProjectFile,
  newProject,
  loadPilotPlan,
  importPlan,
  toast,
  type ViewMode,
} from '../state/store';

const VIEWS: { id: ViewMode; label: string; key: string }[] = [
  { id: 'plan', label: 'План', key: '1' },
  { id: 'surface', label: 'Развёртка', key: '' },
  { id: '3d', label: '3D', key: '2' },
  { id: 'render', label: 'Рендер', key: '3' },
];

function ProjectPicker() {
  const [list, setList] = useState<{ id: string; name: string; updatedAt: number }[]>([]);
  const current = useStore((s) => s.project.id);
  return (
    <select
      value=""
      onFocus={() => listProjects().then(setList)}
      onMouseDown={() => listProjects().then(setList)}
      onChange={(e) => e.target.value && openStoredProject(e.target.value)}
      title="Проекты, сохранённые в этом браузере"
    >
      <option value="">Проекты…</option>
      {list.map((p) => (
        <option key={p.id} value={p.id} disabled={p.id === current}>
          {p.name} · {new Date(p.updatedAt).toLocaleString('ru-RU')}
        </option>
      ))}
    </select>
  );
}

export function TopBar({
  onOpenLeft,
  onOpenRight,
  onModelOnly,
}: {
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onModelOnly: () => void;
}) {
  const view = useStore((s) => s.view);
  const saveState = useStore((s) => s.saveState);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = useStore((s) => s.project.name);
  const busy = useStore((s) => s.busy);
  const projectInput = useRef<HTMLInputElement>(null);
  const planInput = useRef<HTMLInputElement>(null);

  return (
    <header className="topbar">
      <div className="brand">
        Tile<span>Studio</span>
      </div>
      <div className="menu">
        <button
          onClick={async () => {
            if (confirm('Создать новый проект? Текущий останется в списке проектов браузера.')) await newProject();
          }}
        >
          Новый
        </button>
        <button onClick={() => planInput.current?.click()}>Импорт плана</button>
        <button onClick={() => loadPilotPlan()} title="public/samples/room_scheme.pdf">
          Пилотный план
        </button>
        <ProjectPicker />
        <button onClick={() => projectInput.current?.click()} title="Файл .tilestudio.zip">
          Открыть файл
        </button>
        <button onClick={() => exportProjectFile().catch((e) => toast(String(e), 'error'))}>Экспорт проекта</button>
        <button onClick={saveNow}>Сохранить</button>
        <span className="sep" />
        <button onClick={undo} disabled={!canUndo} title="Cmd/Ctrl+Z">
          ↶
        </button>
        <button onClick={redo} disabled={!canRedo} title="Cmd/Ctrl+Shift+Z">
          ↷
        </button>
      </div>
      <button className="drawer-toggle" onClick={onOpenLeft}>
        Помещения
      </button>
      <nav className="views">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)} title={v.key ? `Клавиша ${v.key}` : undefined}>
            {v.label}
          </button>
        ))}
      </nav>
      <button className="drawer-toggle" onClick={onOpenRight}>
        Свойства
      </button>
      <button className="model-toggle" onClick={onModelOnly} title="Скрыть панели и оставить модель">
        Только модель
      </button>
      <div className="status">
        {busy && <span className="busy">{busy}</span>}
        <span className="proj-name">{name}</span>
        <span className={`save save-${saveState}`}>
          {saveState === 'saved' ? 'Сохранено' : saveState === 'saving' ? 'Сохранение…' : saveState === 'dirty' ? 'Есть изменения' : 'Ошибка сохранения'}
        </span>
      </div>
      <input
        ref={planInput}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importPlan(f);
          e.target.value = '';
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importProjectFile(f);
          e.target.value = '';
        }}
      />
    </header>
  );
}
