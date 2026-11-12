import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, Info, X, XCircle } from 'lucide-react';
import { call, dismissToast, useStore } from '../lib/store';
import { isDesktop } from '../lib/api';

/* ───────── Modal ───────── */
export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'normal' | 'wide' | 'xwide';
  headExtra?: ReactNode;
  closeOnBackdrop?: boolean;
  bodyClass?: string;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const downOnBackdrop = useRef(false);

  // The dialog opens centred; dragging its header moves it (offset from the centre).
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const [dragging, setDragging] = useState(false);

  /** Keeps the header reachable: inside the area vertically, and at least 120 px visible sideways. */
  const clampPos = (p: { x: number; y: number }) => {
    const box = boxRef.current;
    const area = box?.parentElement;
    if (!box || !area) return p;
    const b = box.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    const left0 = b.left - posRef.current.x;
    const top0 = b.top - posRef.current.y;
    const keep = Math.min(120, b.width);
    const head = (box.firstElementChild as HTMLElement | null)?.offsetHeight ?? 48;
    const x = Math.min(Math.max(p.x, a.left + keep - b.width - left0), a.right - keep - left0);
    const y = Math.min(Math.max(p.y, a.top - top0), a.bottom - head - top0);
    return x === p.x && y === p.y ? p : { x, y };
  };

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, textarea, a, label, [data-no-drag]')) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX - posRef.current.x;
    const sy = e.clientY - posRef.current.y;
    setDragging(true);
    const move = (ev: PointerEvent) => setPos(clampPos({ x: ev.clientX - sx, y: ev.clientY - sy }));
    const end = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', end);
      head.removeEventListener('pointercancel', end);
      setDragging(false);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (props.closeOnBackdrop !== false && downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className={`modal ${props.size && props.size !== 'normal' ? props.size : ''} ${dragging ? 'dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        style={pos.x || pos.y ? { translate: `${pos.x}px ${pos.y}px` } : undefined}
      >
        <div
          className="modal-head"
          onPointerDown={startDrag}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest('button, input, select, textarea, a, label, [data-no-drag]')) setPos({ x: 0, y: 0 });
          }}
        >
          <h2>{props.title}</h2>
          {props.headExtra}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className={`modal-body ${props.bodyClass ?? ''}`}>{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/* ───────── Form controls ───────── */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="toggle" title={props.title}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; indeterminate?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate;
  }, [props.indeterminate]);
  return (
    <label className="check">
      <input ref={ref} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label !== undefined && <span className="ellipsis">{props.label}</span>}
    </label>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`seg ${props.small ? 'sm' : ''}`} role="radiogroup">
      {props.options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === props.value} className={o.value === props.value ? 'on' : ''} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      className="select"
      style={props.style}
      value={String(props.value)}
      disabled={props.disabled}
      title={props.title}
      onChange={(e) => {
        const o = props.options.find((x) => String(x.value) === e.target.value);
        if (o) props.onChange(o.value);
      }}
    >
      {props.options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field(props: { label: ReactNode; hint?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="field" style={props.style}>
      <label>{props.label}</label>
      {props.children}
      {props.hint && <div className="hint">{props.hint}</div>}
    </div>
  );
}

export function NumberInput(props: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; placeholder?: string; style?: React.CSSProperties; suffix?: string }) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  useEffect(() => {
    setText(props.value === undefined ? '' : String(props.value));
  }, [props.value]);
  return (
    <div className="row gap-4" style={props.style}>
      <input
        className="input grow"
        inputMode="decimal"
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === '') return props.onChange(undefined);
          let n = Number(text.replace(',', '.'));
          if (!Number.isFinite(n)) return setText(props.value === undefined ? '' : String(props.value));
          if (props.min !== undefined) n = Math.max(props.min, n);
          if (props.max !== undefined) n = Math.min(props.max, n);
          props.onChange(n);
          setText(String(n));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {props.suffix && <span className="muted small">{props.suffix}</span>}
    </div>
  );
}

/** Text input + "Change…" button that opens the native folder picker. */
export function FolderField(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="row">
      <input className="input grow" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
      <button
        className="btn"
        onClick={async () => {
          const p = await call('app.pickFolder', { title: 'Choose a folder', defaultPath: props.value || undefined });
          if (p) props.onChange(p);
        }}
      >
        <FolderOpen size={16} /> Change…
      </button>
    </div>
  );
}

export function Progress(props: { value: number; variant?: 'success' | 'paused'; indeterminate?: boolean; style?: React.CSSProperties }) {
  const pct = Math.max(0, Math.min(1, props.value)) * 100;
  return (
    <div className={`progress ${props.variant ?? ''} ${props.indeterminate ? 'indeterminate' : ''}`} style={props.style} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ───────── Dropdown menu ───────── */
export function Menu(props: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {props.trigger(() => setOpen((o) => !o))}
      {open && <div className={`menu ${props.align === 'left' ? 'left' : ''}`}>{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ───────── Media bits ───────── */
export function Thumb(props: { src?: string; duration?: string; className?: string; fallback?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`thumb ${props.className ?? ''}`}>
      {props.src && !failed ? <img src={props.src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : props.fallback}
      {props.duration && <span className="dur">{props.duration}</span>}
    </div>
  );
}

export function Empty(props: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="art">{props.icon}</div>
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}

/* ───────── Toasts ───────── */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="ic">
            {t.level === 'success' ? <CheckCircle2 size={18} /> : t.level === 'error' ? <XCircle size={18} /> : t.level === 'warning' ? <AlertTriangle size={18} /> : <Info size={18} />}
          </span>
          <div className="grow selectable" style={{ whiteSpace: 'pre-line' }}>
            {t.message}
            {t.action && (
              <div style={{ marginTop: 8 }}>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    t.action!.run();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              </div>
            )}
          </div>
          <button className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Ask for file paths when running in a plain browser (no native file dialogs there). */
export async function pickMediaFiles(opts: { title: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean; folders?: boolean }): Promise<string[]> {
  if (!isDesktop) {
    const r = await call('app.pickFiles', opts);
    if (r && r.length) return r;
    const typed = window.prompt(`${opts.title}\nPaste full file path(s), one per line or separated by |`);
    return typed ? typed.split(/\r?\n|\|/).map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
  }
  return (await call('app.pickFiles', opts)) ?? [];
}

export const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'mpg', 'mpeg', 'm4v', '3gp', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'divx', 'xvid', 'asf', 'rm', 'rmvb', 'f4v', 'swf', 'dv', 'mxf', 'gif'];
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'ac3', 'aiff', 'aif', 'ape', 'alac', 'amr', 'mka', 'dts', 'mp2'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif', 'tif', 'tiff', 'heic'];
export const SUB_EXTS = ['srt', 'ass', 'ssa', 'vtt', 'sub'];
