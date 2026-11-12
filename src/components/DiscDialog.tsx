import { useEffect, useMemo, useState } from 'react';
import { Disc3, FolderOpen, HardDrive, RefreshCw } from 'lucide-react';
import type { DiscDrive, DiscSpec } from '../../shared/types';
import type { OutputTarget } from '../../shared/presets';
import { call, go, toast, useStore, type ConvItem } from '../lib/store';
import { formatDuration } from '../lib/format';
import { editedDuration, toInputs } from '../lib/media';
import { Field, FolderField, Modal, Seg, Select } from './ui';

// Rough minutes that fit at "good" quality (DVD ≈ 5 Mbps total, Blu-ray ≈ 20 Mbps total)
const GOOD_MINUTES: Record<DiscSpec['discSize'], number> = { dvd5: 120, dvd9: 215, bd25: 165, bd50: 330 };
const MAX_MINUTES: Record<DiscSpec['discSize'], number> = { dvd5: 360, dvd9: 600, bd25: 700, bd50: 1400 };

export function DiscDialog(props: { target: OutputTarget; items: ConvItem[]; onClose: () => void }) {
  const isDvd = props.target.id === 'dvd';
  const app = useStore((s) => s.app)!;
  const [spec, setSpec] = useState<DiscSpec>({
    type: isDvd ? 'dvd' : 'bluray',
    standard: Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('America') ? 'ntsc' : 'pal',
    aspect: '16:9',
    title: props.items[0]?.info.name.replace(/\.[^.]+$/, '').slice(0, 32) || 'My disc',
    menu: 'none',
    resolution: '1080',
    output: 'folder',
    discSize: isDvd ? 'dvd5' : 'bd25',
  });
  const [dir, setDir] = useState(app.settings.convertDir);
  const [drives, setDrives] = useState<DiscDrive[] | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<DiscSpec>) => setSpec((s) => ({ ...s, ...p }));

  const minutes = useMemo(() => props.items.reduce((n, i) => n + editedDuration(i.info, i.edit), 0) / 60, [props.items]);
  const fill = minutes / MAX_MINUTES[spec.discSize];
  const quality = minutes <= GOOD_MINUTES[spec.discSize] ? 'High quality' : minutes <= GOOD_MINUTES[spec.discSize] * 1.8 ? 'Good quality' : fill <= 1 ? 'Low quality (consider a dual-layer disc)' : 'Too long for this disc';

  const loadDrives = async () => {
    setDrives(null);
    const d = await call('disc.drives');
    setDrives(d ?? []);
    if (d?.length && !spec.drive) set({ drive: d[0].id });
  };
  useEffect(() => {
    void loadDrives();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usable = (drives ?? []).filter((d) => (isDvd ? d.canWriteDvd : d.canWriteBd));
  const canBurn = drives === null || usable.length > 0;

  const create = async () => {
    setBusy(true);
    const job = await call('disc.create', { inputs: toInputs(props.items), spec, outputDir: dir });
    setBusy(false);
    if (job) {
      toast('success', `Creating ${isDvd ? 'DVD' : 'Blu-ray'} "${spec.title}"`);
      props.onClose();
      go('tasks');
    }
  };

  return (
    <Modal
      size="wide"
      title={
        <span className="row">
          <Disc3 size={20} style={{ color: props.target.color }} /> {isDvd ? 'Create a DVD' : 'Create a Blu-ray'}
        </span>
      }
      onClose={props.onClose}
      footer={
        <>
          <span className="muted small">
            {props.items.length} video{props.items.length > 1 ? 's' : ''} · {formatDuration(minutes * 60)}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || fill > 1 || (spec.output === 'burn' && !spec.drive)} onClick={create}>
            <Disc3 size={16} /> {spec.output === 'burn' ? 'Burn' : 'Create'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {props.target.description} Each video becomes a title with chapters every few minutes; the disc starts playing automatically when inserted.
      </p>
      <div className="form-grid">
        <Field label="Disc title">
          <input className="input" maxLength={32} value={spec.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Disc type">
          <Select
            value={spec.discSize}
            options={
              isDvd
                ? [
                    { value: 'dvd5', label: 'DVD-5 (4.7 GB, single layer)' },
                    { value: 'dvd9', label: 'DVD-9 (8.5 GB, dual layer)' },
                  ]
                : [
                    { value: 'bd25', label: 'BD-25 (25 GB, single layer)' },
                    { value: 'bd50', label: 'BD-50 (50 GB, dual layer)' },
                  ]
            }
            onChange={(discSize) => set({ discSize })}
          />
        </Field>
        {isDvd && (
          <Field label="TV standard" hint="PAL: Europe, Asia, Australia · NTSC: Americas, Japan">
            <Seg
              small
              value={spec.standard}
              onChange={(standard) => set({ standard })}
              options={[
                { value: 'pal', label: 'PAL' },
                { value: 'ntsc', label: 'NTSC' },
              ]}
            />
          </Field>
        )}
        <Field label="Aspect ratio">
          <Seg
            small
            value={spec.aspect}
            onChange={(aspect) => set({ aspect })}
            options={[
              { value: '16:9', label: '16:9 widescreen' },
              { value: '4:3', label: '4:3' },
            ]}
          />
        </Field>
        {!isDvd && (
          <Field label="Video resolution">
            <Select
              value={spec.resolution ?? '1080'}
              options={[
                { value: '1080', label: 'Full HD 1920×1080' },
                { value: '720', label: 'HD 1280×720' },
              ]}
              onChange={(resolution) => set({ resolution })}
            />
          </Field>
        )}
      </div>

      <div className="card flat col" style={{ marginTop: 14 }}>
        <div className="row">
          <b>Disc usage</b>
          <div className="spacer" />
          <span className="small" style={{ color: fill > 1 ? 'var(--danger)' : 'var(--text-2)' }}>{quality}</span>
        </div>
        <div className={`capacity ${fill > 1 ? 'over' : ''}`}>
          <div style={{ width: `${Math.min(100, fill * 100)}%` }} />
        </div>
      </div>

      <div className="col" style={{ marginTop: 14, gap: 12 }}>
        <Seg
          value={spec.output}
          onChange={(output) => set({ output })}
          options={[
            { value: 'folder' as const, label: (<><FolderOpen size={15} /> Save as folder</>) },
            { value: 'iso' as const, label: (<><HardDrive size={15} /> Save as ISO image</>) },
            ...(canBurn ? [{ value: 'burn' as const, label: (<><Disc3 size={15} /> Burn to disc</>) }] : []),
          ]}
        />
        {!canBurn && (
          <div className="tiny muted">
            No {isDvd ? 'DVD' : 'Blu-ray'} burner was found on this PC. Save an ISO image — you can burn it later on any PC with a burner (in Windows: right-click the .iso → Burn disc image).
          </div>
        )}
        {spec.output === 'burn' ? (
          <Field label="Burner">
            <div className="row">
              {drives === null ? (
                <span className="row muted small">
                  <span className="spinner" /> Looking for disc burners…
                </span>
              ) : usable.length ? (
                <Select value={spec.drive ?? ''} options={usable.map((d) => ({ value: d.id, label: `${d.letter ? d.letter + ' ' : ''}${d.name}${d.mediaPresent === false ? ' (no disc)' : ''}` }))} onChange={(drive) => set({ drive })} style={{ minWidth: 320 }} />
              ) : (
                <span className="small" style={{ color: 'var(--warning)' }}>
                  No {isDvd ? 'DVD' : 'Blu-ray'} burner was found. Save as an ISO image instead and burn it later.
                </span>
              )}
              <button className="icon-btn" onClick={() => void loadDrives()} title="Look again">
                <RefreshCw size={16} />
              </button>
            </div>
          </Field>
        ) : (
          <Field label="Save to">
            <FolderField value={dir} onChange={setDir} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
