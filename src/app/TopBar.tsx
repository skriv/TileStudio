import { useEffect, useRef, useState } from 'react';
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

function ProjectPicker({ onPicked }: { onPicked?: () => void }) {
  const [list, setList] = useState<{ id: string; name: string; updatedAt: number }[]>([]);
  const current = useStore((s) => s.project.id);
  return (
    <select
      value=""
      onFocus={() => listProjects().then(setList)}
      onMouseDown={() => listProjects().then(setList)}
      onChange={(e) => {
        if (!e.target.value) return;
        onPicked?.();
        void openStoredProject(e.target.value);
      }}
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
  const barRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggleFullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
    const active = document.fullscreenElement || doc.webkitFullscreenElement;
    if (active) {
      if (document.exitFullscreen) void document.exitFullscreen();
      else void doc.webkitExitFullscreen?.();
      return;
    }
    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!request) {
      toast('Этот браузер не открывает страницу на весь экран.', 'error');
      return;
    }
    void Promise.resolve(request()).catch(() => toast('Не удалось включить полный экран.', 'error'));
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className={`topbar ${menuOpen ? 'menu-open' : ''}`} ref={barRef}>
      <button type="button" className="menu-toggle" aria-label="Меню" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
        <span />
        <span />
        <span />
      </button>
      <div className="brand">
        Tile<span>Studio</span>
      </div>
      <div className="view-switch">
        <nav className="views">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)} title={v.key ? `Клавиша ${v.key}` : undefined}>
              {v.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="model-toggle"
          onClick={onModelOnly}
          title="Скрыть панели и оставить модель"
        >
          Только модель
        </button>
        <button type="button" className={`fullscreen-toggle ${fullscreen ? 'active' : ''}`} onClick={toggleFullscreen}>
          {fullscreen ? 'Exit' : 'Full screen'}
        </button>
      </div>
      <div className="top-menu">
        <div className="status">
          {busy && <span className="busy">{busy}</span>}
          <span className="proj-name">{name}</span>
          <span className={`save save-${saveState}`}>
            {saveState === 'saved' ? 'Сохранено' : saveState === 'saving' ? 'Сохранение…' : saveState === 'dirty' ? 'Есть изменения' : 'Ошибка сохранения'}
          </span>
        </div>
        <button
          className="drawer-toggle"
          onClick={() => {
            closeMenu();
            onOpenLeft();
          }}
        >
          Помещения
        </button>
        <button
          className="drawer-toggle"
          onClick={() => {
            closeMenu();
            onOpenRight();
          }}
        >
          Свойства
        </button>
        <div className="menu">
          <button
            onClick={async () => {
              closeMenu();
              if (confirm('Создать новый проект? Текущий останется в списке проектов браузера.')) await newProject();
            }}
          >
            Новый
          </button>
          <button
            onClick={() => {
              closeMenu();
              planInput.current?.click();
            }}
          >
            Импорт плана
          </button>
          <button
            onClick={() => {
              closeMenu();
              void loadPilotPlan();
            }}
            title="public/samples/room_scheme.pdf"
          >
            Пилотный план
          </button>
          <ProjectPicker onPicked={closeMenu} />
          <button
            onClick={() => {
              closeMenu();
              projectInput.current?.click();
            }}
            title="Файл .tilestudio.zip"
          >
            Открыть файл
          </button>
          <button
            onClick={() => {
              closeMenu();
              exportProjectFile().catch((e) => toast(String(e), 'error'));
            }}
          >
            Экспорт проекта
          </button>
          <button
            onClick={() => {
              closeMenu();
              void saveNow();
            }}
          >
            Сохранить
          </button>
          <div className="row">
            <button onClick={undo} disabled={!canUndo} title="Cmd/Ctrl+Z">
              ↶ Отменить
            </button>
            <button onClick={redo} disabled={!canRedo} title="Cmd/Ctrl+Shift+Z">
              ↷ Вернуть
            </button>
          </div>
        </div>
        <div id="app-menu-tools" />
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
