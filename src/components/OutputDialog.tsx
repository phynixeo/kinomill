import { useEffect, useMemo, useState } from 'react';
import { Cpu, Image as ImageIcon, Settings2, Type, Zap } from 'lucide-react';
import type { AudioOutput, OutputSpec, VideoOutput, Watermark } from '../../shared/types';
import { AUDIO_CODECS, FRAME_RATES, RESOLUTIONS, SAMPLE_RATES, VIDEO_CODECS, type OutputTarget } from '../../shared/presets';
import { outputFromPreset } from '../../shared/defaults';
import { call, go, toast, useStore, type ConvItem } from '../lib/store';
import { formatBytes, stripExt } from '../lib/format';
import { toInputs } from '../lib/media';
import { Check, Field, FolderField, Modal, NumberInput, Seg, Select, Toggle, pickMediaFiles, IMAGE_EXTS } from './ui';

const SIZE_PRESETS = [
  { label: '10 MB (email / Discord)', mb: 10 },
  { label: '25 MB', mb: 25 },
  { label: '50 MB', mb: 50 },
  { label: '100 MB', mb: 100 },
  { label: '700 MB (CD)', mb: 700 },
  { label: '1.4 GB (¼ DVD)', mb: 1400 },
  { label: '4.3 GB (DVD)', mb: 4300 },
];

export function OutputDialog(props: { target: OutputTarget; items: ConvItem[]; join: boolean; onClose: () => void }) {
  const t = props.target;
  const app = useStore((s) => s.app)!;
  const [out, setOut] = useState<OutputSpec>(() => outputFromPreset(t.id));
  const [custom, setCustom] = useState(false);
  const [sizeOn, setSizeOn] = useState(false);
  const [dir, setDir] = useState(app.settings.convertDir);
  const [name, setName] = useState(stripExt(props.items[0]?.info.name ?? 'output') + (props.join ? ' (joined)' : ''));
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const audioOnly = t.videoCodecs.length === 0;
  const hwFor = (codec?: string) => {
    const c = codec ? VIDEO_CODECS[codec] : undefined;
    return c?.hw ? Object.values(c.hw).filter((e) => app.capabilities.hwEncoders.includes(e!)) : [];
  };
  const hwAvailable = !audioOnly && hwFor(out.video?.codec).length > 0 && app.settings.hwAccel !== 'none';
  const twoPassForced = !!out.targetSizeMB;

  const setVideo = (patch: Partial<VideoOutput>) => setOut((o) => ({ ...o, presetId: 'custom', video: o.video ? { ...o.video, ...patch } : null }));
  const setAudio = (patch: Partial<AudioOutput>) => setOut((o) => ({ ...o, presetId: 'custom', audio: o.audio ? { ...o.audio, ...patch } : { codec: t.audioCodecs[0], ...patch } }));

  const inputs = useMemo(() => toInputs(props.items), [props.items]);
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      call('convert.estimateSize', { inputs, join: props.join, output: out }).then((n) => alive && setEstimate(n ?? null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [inputs, props.join, out]);

  const start = async () => {
    setBusy(true);
    const jobs = await call('convert.add', {
      inputs,
      join: props.join,
      output: { ...out, targetSizeMB: sizeOn ? out.targetSizeMB : undefined },
      outputDir: dir,
      outputName: props.join || props.items.length === 1 ? name : undefined,
    });
    setBusy(false);
    if (jobs) {
      toast('success', `Converting ${jobs.length === 1 ? `"${jobs[0].title}"` : `${jobs.length} files`} to ${t.label}`);
      props.onClose();
      go('tasks');
    }
  };

  const v = out.video;
  const a = out.audio;
  const res = v?.width && v?.height ? `${v.width}x${v.height}` : 'source';

  return (
    <Modal
      size="wide"
      title={
        <span className="row">
          <span className="badge" style={{ background: t.color, color: 'white', height: 26, padding: '0 9px', fontSize: 12.5 }}>
            {t.badge}
          </span>
          Convert to {t.label}
        </span>
      }
      onClose={props.onClose}
      footer={
        <>
          <span className="muted small">
            {props.join ? `${props.items.length} files → 1 file` : `${props.items.length} file${props.items.length > 1 ? 's' : ''}`}
            {estimate ? ` · about ${formatBytes(estimate)}${props.join || props.items.length === 1 ? '' : ' in total'}` : ''}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={start}>
            <Zap size={16} /> Convert
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {t.description}
      </p>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr auto' }}>
        <Field label="Preset">
          <Select
            value={out.presetId}
            options={[...t.presets.map((p) => ({ value: p.id, label: p.label })), ...(out.presetId === 'custom' ? [{ value: 'custom', label: 'Custom settings' }] : [])]}
            onChange={(id) => id !== 'custom' && setOut((o) => ({ ...outputFromPreset(t.id, id), watermark: o.watermark, hwAccel: o.hwAccel, targetSizeMB: o.targetSizeMB }))}
          />
        </Field>
        <div className="field">
          <label>&nbsp;</label>
          <button className={`btn ${custom ? 'primary' : ''}`} onClick={() => setCustom((c) => !c)}>
            <Settings2 size={16} /> {custom ? 'Hide' : 'Edit'} settings
          </button>
        </div>
      </div>

      {custom && (
        <div className="card flat col gap-16" style={{ marginTop: 14 }}>
          {v && (
            <>
              <h3>Video</h3>
              <div className="form-grid">
                <Field label="Codec">
                  <Select value={v.codec} options={t.videoCodecs.map((c) => ({ value: c, label: VIDEO_CODECS[c]?.label ?? c }))} onChange={(codec) => setVideo({ codec })} />
                </Field>
                <Field label="Frame size">
                  <Select
                    value={res}
                    options={[{ value: 'source', label: 'Same as source' }, ...RESOLUTIONS.map((r) => ({ value: `${r.width}x${r.height}`, label: r.label })), ...(res !== 'source' && !RESOLUTIONS.some((r) => `${r.width}x${r.height}` === res) ? [{ value: res, label: res.replace('x', '×') }] : [])]}
                    onChange={(val) => {
                      if (val === 'source') setVideo({ width: undefined, height: undefined });
                      else {
                        const [w, h] = val.split('x').map(Number);
                        setVideo({ width: w, height: h });
                      }
                    }}
                  />
                </Field>
                {v.width && (
                  <Field label="When the shape differs">
                    <Select
                      value={v.fit}
                      options={[
                        { value: 'pad', label: 'Add black bars' },
                        { value: 'crop', label: 'Crop to fill' },
                        { value: 'stretch', label: 'Stretch' },
                      ]}
                      onChange={(fit) => setVideo({ fit })}
                    />
                  </Field>
                )}
                <Field label="Frame rate">
                  <Select value={v.fps ?? 0} options={[{ value: 0, label: 'Same as source' }, ...FRAME_RATES.map((f) => ({ value: f, label: `${f} fps` }))]} onChange={(fps) => setVideo({ fps: fps || undefined })} />
                </Field>
              </div>
              <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
                <Seg
                  small
                  value={v.bitrateKbps ? 'bitrate' : 'quality'}
                  onChange={(m) => (m === 'bitrate' ? setVideo({ bitrateKbps: v.bitrateKbps ?? 5000, quality: undefined }) : setVideo({ bitrateKbps: undefined, quality: v.quality ?? 75, twoPass: false }))}
                  options={[
                    { value: 'quality', label: 'Constant quality' },
                    { value: 'bitrate', label: 'Bitrate' },
                  ]}
                />
                {v.bitrateKbps ? (
                  <>
                    <Field label="Video bitrate">
                      <NumberInput value={v.bitrateKbps} min={50} max={200000} suffix="kbps" onChange={(n) => setVideo({ bitrateKbps: n ?? 5000 })} style={{ width: 160 }} />
                    </Field>
                    {t.supportsTwoPass && <Check checked={!!v.twoPass || twoPassForced} disabled={twoPassForced} onChange={(twoPass) => setVideo({ twoPass })} label="Two-pass encoding (better quality, slower)" />}
                  </>
                ) : (
                  <Field label={`Quality: ${v.quality ?? 75}`} style={{ flex: 1 }}>
                    <div className="row">
                      <span className="tiny muted">Smaller file</span>
                      <input type="range" min={10} max={100} value={v.quality ?? 75} onChange={(e) => setVideo({ quality: Number(e.target.value) })} className="grow" />
                      <span className="tiny muted">Better quality</span>
                    </div>
                  </Field>
                )}
              </div>
            </>
          )}
          {t.audioCodecs.length > 0 && (
            <>
              <h3>Audio</h3>
              <div className="form-grid">
                <Field label="Codec">
                  <Select
                    value={a ? a.codec : 'none'}
                    options={[...t.audioCodecs.map((c) => ({ value: c, label: AUDIO_CODECS[c]?.label ?? c })), ...(audioOnly ? [] : [{ value: 'none', label: 'No audio' }])]}
                    onChange={(codec) => (codec === 'none' ? setOut((o) => ({ ...o, presetId: 'custom', audio: null })) : setAudio({ codec }))}
                  />
                </Field>
                {a && !['flac', 'pcm', 'pcm_be', 'alac'].includes(a.codec) && (
                  <Field label="Bitrate">
                    <Select value={a.bitrateKbps ?? 192} options={[32, 48, 64, 96, 128, 160, 192, 224, 256, 320, 384, 448, 640].map((b) => ({ value: b, label: `${b} kbps` }))} onChange={(bitrateKbps) => setAudio({ bitrateKbps })} />
                  </Field>
                )}
                {a && (
                  <>
                    <Field label="Sample rate">
                      <Select value={a.sampleRate ?? 0} options={[{ value: 0, label: 'Same as source' }, ...SAMPLE_RATES.map((r) => ({ value: r, label: `${r / 1000} kHz` }))]} onChange={(r) => setAudio({ sampleRate: r || undefined })} />
                    </Field>
                    <Field label="Channels">
                      <Select
                        value={a.channels ?? 0}
                        options={[
                          { value: 0, label: 'Same as source' },
                          { value: 1, label: 'Mono' },
                          { value: 2, label: 'Stereo' },
                          { value: 6, label: '5.1 surround' },
                        ]}
                        onChange={(c) => setAudio({ channels: c || undefined })}
                      />
                    </Field>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!audioOnly && t.supportsTwoPass && (
        <div className="card flat col" style={{ marginTop: 12 }}>
          <div className="row">
            <Check checked={sizeOn} onChange={(on) => { setSizeOn(on); if (on && !out.targetSizeMB) setOut((o) => ({ ...o, targetSizeMB: 100 })); }} label={<b>Limit the output file size</b>} />
            {sizeOn && (
              <>
                <NumberInput value={out.targetSizeMB} min={1} max={100000} suffix="MB" onChange={(n) => setOut((o) => ({ ...o, targetSizeMB: n }))} style={{ width: 140 }} />
                <Select value={0} options={[{ value: 0, label: 'Quick pick…' }, ...SIZE_PRESETS.map((s) => ({ value: s.mb, label: s.label }))]} onChange={(mb) => mb && setOut((o) => ({ ...o, targetSizeMB: mb }))} />
              </>
            )}
          </div>
          {sizeOn && <div className="tiny muted">The bitrate is calculated automatically and two-pass encoding is used to hit the size.{props.join ? '' : ' The limit applies to each output file.'}</div>}
        </div>
      )}

      {!audioOnly && t.special !== 'gif' && <WatermarkEditor value={out.watermark} onChange={(watermark) => setOut((o) => ({ ...o, watermark }))} />}

      <div className="form-grid" style={{ marginTop: 14, gridTemplateColumns: props.join || props.items.length === 1 ? '2fr 1fr' : '1fr' }}>
        <Field label="Save to">
          <FolderField value={dir} onChange={setDir} />
        </Field>
        {(props.join || props.items.length === 1) && (
          <Field label="File name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
      </div>

      {!audioOnly && (
        <div className="row" style={{ marginTop: 14 }}>
          <Toggle
            checked={out.hwAccel && hwAvailable}
            disabled={!hwAvailable || (!!v?.twoPass && !twoPassForced)}
            onChange={(hwAccel) => setOut((o) => ({ ...o, hwAccel }))}
            label={
              <span className="row gap-4">
                <Cpu size={15} /> GPU acceleration {hwAvailable ? <span className="muted small">({hwFor(v?.codec).join(', ')})</span> : <span className="muted small">(not available for this codec)</span>}
              </span>
            }
          />
        </div>
      )}
    </Modal>
  );
}

export function WatermarkEditor(props: { value: Watermark | null; onChange: (w: Watermark | null) => void }) {
  const w = props.value;
  const set = (patch: Partial<Watermark>) => props.onChange(w ? { ...w, ...patch } : null);
  return (
    <div className="card flat col" style={{ marginTop: 12 }}>
      <div className="row">
        <Check
          checked={!!w}
          onChange={(on) => props.onChange(on ? { type: 'text', text: '© My video', position: 'br', opacity: 0.7, scale: 0.045, color: '#FFFFFF', margin: 24 } : null)}
          label={<b>Add a watermark</b>}
        />
        {w && (
          <Seg
            small
            value={w.type}
            onChange={(type) => set({ type, scale: type === 'image' ? 0.15 : 0.045 })}
            options={[
              { value: 'text', label: (<><Type size={14} /> Text</>) },
              { value: 'image', label: (<><ImageIcon size={14} /> Logo image</>) },
            ]}
          />
        )}
      </div>
      {w && (
        <div className="form-grid">
          {w.type === 'text' ? (
            <>
              <Field label="Text">
                <input className="input" value={w.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
              </Field>
              <Field label="Color">
                <input type="color" className="input" style={{ padding: 2, width: 60 }} value={w.color ?? '#ffffff'} onChange={(e) => set({ color: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="Image (PNG with transparency works best)">
              <div className="row">
                <input className="input grow" value={w.imagePath ?? ''} onChange={(e) => set({ imagePath: e.target.value })} placeholder="C:\…\logo.png" />
                <button
                  className="btn"
                  onClick={async () => {
                    const f = await pickMediaFiles({ title: 'Choose a logo image', filters: [{ name: 'Images', extensions: IMAGE_EXTS }] });
                    if (f[0]) set({ imagePath: f[0] });
                  }}
                >
                  Browse…
                </button>
              </div>
            </Field>
          )}
          <Field label="Position">
            <Select
              value={w.position}
              options={[
                { value: 'tl', label: 'Top left' },
                { value: 'tr', label: 'Top right' },
                { value: 'bl', label: 'Bottom left' },
                { value: 'br', label: 'Bottom right' },
                { value: 'center', label: 'Center' },
              ]}
              onChange={(position) => set({ position })}
            />
          </Field>
          <Field label={`Size: ${Math.round(w.scale * 100)}%`}>
            <input type="range" min={w.type === 'image' ? 2 : 1} max={w.type === 'image' ? 50 : 20} value={Math.round(w.scale * 100)} onChange={(e) => set({ scale: Number(e.target.value) / 100 })} />
          </Field>
          <Field label={`Opacity: ${Math.round(w.opacity * 100)}%`}>
            <input type="range" min={10} max={100} value={Math.round(w.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} />
          </Field>
        </div>
      )}
    </div>
  );
}
