import { useEffect, useState, type ReactNode } from 'react';

/** Numeric input that commits on blur/Enter (one undo step per edit, not per keystroke). */
export function NumField({
  label,
  value,
  onCommit,
  unit = 'мм',
  min,
  max,
  step = 1,
  width = 80,
  disabled,
  precision = 3,
}: {
  label?: ReactNode;
  value: number;
  onCommit: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  disabled?: boolean;
  precision?: number;
}) {
  const round = (v: number) => Math.round(v * 10 ** precision) / 10 ** precision;
  const [text, setText] = useState(String(round(value)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setText(String(round(value))), [value, precision]);
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      setText(String(round(value)));
      return;
    }
    if (v !== value) onCommit(v);
  };
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <span className="field-input">
        <input
          type="number"
          value={text}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          style={{ width }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
}

export function TextField({ value, onCommit, width = 160 }: { value: string; onCommit: (v: string) => void; width?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      value={text}
      style={{ width }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text !== value && onCommit(text.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Common tile-grout colours. Grey matches the project default so existing layouts stay selected. */
const GROUT_COLORS: { name: string; color: string }[] = [
  { name: 'Белая', color: '#f3f2ef' },
  { name: 'Светло-серая', color: '#d5d2cc' },
  { name: 'Серая', color: '#9a9893' },
  { name: 'Графит', color: '#6a6864' },
  { name: 'Антрацит', color: '#3e3d3b' },
  { name: 'Бежевая', color: '#d8c6a6' },
  { name: 'Песочная', color: '#c6a67a' },
  { name: 'Карамель', color: '#a67c52' },
  { name: 'Коричневая', color: '#6e4e38' },
  { name: 'Чёрная', color: '#22211f' },
];

export function GroutColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const current = value.toLowerCase();
  const named = GROUT_COLORS.find((c) => c.color === current);
  const custom = /^#[0-9a-f]{6}$/i.test(value) ? value : '#9a9893';
  return (
    <div className="field grout-field">
      <span className="field-label">Цвет затирки{named ? ` · ${named.name}` : ' · свой'}</span>
      <div className="grout-colors">
        {GROUT_COLORS.map((c) => (
          <button
            key={c.color}
            type="button"
            className={`grout-swatch ${current === c.color ? 'active' : ''}`}
            style={{ ['--grout' as string]: c.color }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={current === c.color}
            onClick={() => onChange(c.color)}
          />
        ))}
        <label className={`grout-custom ${named ? '' : 'active'}`} title="Свой цвет">
          <input type="color" aria-label="Свой цвет затирки" value={custom} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`panel-section ${open ? 'open' : 'collapsed'}`}>
      <header>
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <i className="chev" />
          <span className="section-title">{title}</span>
        </button>
        {actions}
      </header>
      <div className="section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
