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

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel-section">
      <header>
        <h4>{title}</h4>
        {actions}
      </header>
      {children}
    </section>
  );
}
