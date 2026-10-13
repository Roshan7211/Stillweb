import type { ReactNode } from 'react';

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  );
}

/** A settings row: a title, an optional explanation, and a control on the right. */
export function Row({ title, detail, children }: { title: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <p className="row-title">{title}</p>
        {detail ? <p className="muted">{detail}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      <div className="card">{children}</div>
    </section>
  );
}
