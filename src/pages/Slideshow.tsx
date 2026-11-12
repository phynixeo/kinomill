import { useState } from 'react';
import { ArrowLeft, ArrowRight, Images, Music, Plus, Shuffle, Trash2, X, Zap } from 'lucide-react';
import type { OutputSpec } from '../../shared/types';
import { OUTPUT_TARGETS } from '../../shared/presets';
import { outputFromPreset } from '../../shared/defaults';
import { call, go, setState, toast, useStore } from '../lib/store';
import { pathForFile } from '../lib/api';
import { basename, formatDuration } from '../lib/format';
import { frameUrl } from '../lib/media';
import { Check, Empty, Field, FolderField, Select, pickMediaFiles, IMAGE_EXTS, AUDIO_EXTS } from '../components/ui';
import { WatermarkEditor } from '../components/OutputDialog';

const SIZES = [
  { value: '1920x1080', label: 'Full HD 1920×1080 (16:9)' },
  { value: '3840x2160', label: '4K 3840×2160 (16:9)' },
  { value: '1280x720', label: 'HD 1280×720 (16:9)' },
  { value: '1080x1920', label: 'Vertical 1080×1920 (Stories, Shorts, TikTok)' },
  { value: '1080x1080', label: 'Square 1080×1080 (Instagram)' },
  { value: '1440x1080', label: '4:3 1440×1080' },
];
const VIDEO_TARGETS = OUTPUT_TARGETS.filter((t) => t.videoCodecs.length > 0 && t.group !== 'disc' && t.special !== 'html5');

export function SlideshowPage() {
  const spec = useStore((s) => s.slideshow);
  const settings = useStore((s) => s.app!.settings);
  const [targetId, setTargetId] = useState('mp4');
  const [out, setOut] = useState<OutputSpec>(() => outputFromPreset('mp4', '1080p'));
  const [dir, setDir] = useState(settings.convertDir);
  const [name, setName] = useState('My slideshow');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const set = (patch: Partial<typeof spec>) => setState((s) => ({ slideshow: { ...s.slideshow, ...patch } }));

  const addPhotos = async () => {
    const f = await pickMediaFiles({ title: 'Add photos', multi: true, filters: [{ name: 'Images', extensions: IMAGE_EXTS }] });
    if (f.length) set({ images: [...spec.images, ...f] });
  };
  const addMusic = async () => {
    const f = await pickMediaFiles({ title: 'Add music', multi: true, filters: [{ name: 'Audio', extensions: AUDIO_EXTS }] });
    if (f.length) set({ music: [...spec.music, ...f] });
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= spec.images.length) return;
    const copy = spec.images.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    set({ images: copy });
  };
  const total = spec.images.length * spec.secondsPerImage;

  const create = async () => {
    setBusy(true);
    const job = await call('convert.slideshow', { spec, output: out, outputDir: dir, outputName: name });
    setBusy(false);
    if (job) {
      toast('success', `Creating slideshow "${name}"`);
      go('tasks');
    }
  };

  return (
    <div
      className="page"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
        const imgs = paths.filter((p) => IMAGE_EXTS.includes(p.split('.').pop()!.toLowerCase()));
        const music = paths.filter((p) => AUDIO_EXTS.includes(p.split('.').pop()!.toLowerCase()));
        set({ images: [...spec.images, ...imgs], music: [...spec.music, ...music] });
      }}
    >
      <div className="page-head">
        <h1>Photo slideshow</h1>
        <button className="btn primary" onClick={addPhotos}>
          <Plus size={17} /> Add photos
        </button>
        <button className="btn" onClick={addMusic}>
          <Music size={16} /> Add music
        </button>
        <div className="spacer" />
        {spec.images.length > 0 && (
          <>
            <span className="muted small">
              {spec.images.length} photos · {formatDuration(total)}
            </span>
            <button className="btn ghost" onClick={() => set({ images: [], music: [] })}>
              <X size={16} /> Clear
            </button>
          </>
        )}
      </div>
      <div className="page-body">
        {spec.images.length === 0 ? (
          <div className={`dropzone ${over ? 'over' : ''}`} style={{ height: '100%' }}>
            <Empty icon={<Images size={38} />} title="Turn photos into a video">
              <p>Add photos (or drop them here), pick music, and Kinomill makes a video with smooth transitions and a gentle pan-and-zoom effect.</p>
              <button className="btn primary lg" style={{ marginTop: 14 }} onClick={addPhotos}>
                <Plus size={18} /> Add photos
              </button>
            </Empty>
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <div className="grow">
              <div className="photo-grid">
                {spec.images.map((p, i) => (
                  <div key={p + i} className="photo" title={basename(p)}>
                    <img src={frameUrl(p, 0, 320)} alt="" loading="lazy" />
                    <span className="idx">{i + 1}</span>
                    <div className="tools">
                      <button onClick={() => move(i, -1)} aria-label="Move earlier">
                        <ArrowLeft size={14} />
                      </button>
                      <button onClick={() => move(i, 1)} aria-label="Move later">
                        <ArrowRight size={14} />
                      </button>
                      <button onClick={() => set({ images: spec.images.filter((_, j) => j !== i) })} aria-label="Remove">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                <button className="photo" style={{ border: '2px dashed var(--border-strong)', background: 'transparent', cursor: 'pointer', color: 'var(--text-2)' }} onClick={addPhotos}>
                  <Plus size={22} />
                </button>
              </div>
              <h3 style={{ margin: '20px 0 8px' }}>Music</h3>
              {spec.music.length === 0 ? (
                <button className="btn" onClick={addMusic}>
                  <Music size={16} /> Add a song
                </button>
              ) : (
                <div className="entries">
                  {spec.music.map((m, i) => (
                    <div key={m + i} className="entry">
                      <Music size={15} className="faint" />
                      <span className="grow ellipsis">{basename(m)}</span>
                      <button className="icon-btn sm danger" onClick={() => set({ music: spec.music.filter((_, j) => j !== i) })} aria-label="Remove song">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {spec.music.length > 0 && <div className="tiny muted" style={{ marginTop: 6 }}>Songs play one after another and fade out when the slideshow ends.</div>}
            </div>

            <div className="card col gap-12" style={{ width: 340, flex: 'none' }}>
              <h3>Slideshow settings</h3>
              <Field label={`Each photo shows for ${spec.secondsPerImage} s`}>
                <input type="range" min={1} max={15} step={0.5} value={spec.secondsPerImage} onChange={(e) => set({ secondsPerImage: Number(e.target.value) })} />
              </Field>
              <Field label="Transition">
                <Select
                  value={spec.transition}
                  options={[
                    { value: 'fade', label: 'Fade' },
                    { value: 'dissolve', label: 'Dissolve' },
                    { value: 'slide', label: 'Slide' },
                    { value: 'wipe', label: 'Wipe' },
                    { value: 'none', label: 'None (cut)' },
                  ]}
                  onChange={(transition) => set({ transition })}
                />
              </Field>
              <Check checked={spec.panZoom} onChange={(panZoom) => set({ panZoom })} label="Pan & zoom effect (Ken Burns)" />
              <Check checked={spec.shuffle} onChange={(shuffle) => set({ shuffle })} label={<span className="row gap-4"><Shuffle size={14} /> Shuffle photos</span>} />
              <Field label="Video size">
                <Select
                  value={`${spec.width}x${spec.height}`}
                  options={SIZES}
                  onChange={(v) => {
                    const [w, h] = v.split('x').map(Number);
                    set({ width: w, height: h });
                  }}
                />
              </Field>
              <Field label="Format">
                <Select
                  value={targetId}
                  options={VIDEO_TARGETS.map((t) => ({ value: t.id, label: t.label }))}
                  onChange={(id) => {
                    setTargetId(id);
                    const t = OUTPUT_TARGETS.find((x) => x.id === id)!;
                    setOut((o) => ({ ...outputFromPreset(id, t.presets.find((p) => p.id === '1080p') ? '1080p' : t.defaultPreset), watermark: o.watermark }));
                  }}
                />
              </Field>
              <WatermarkEditor value={out.watermark} onChange={(watermark) => setOut((o) => ({ ...o, watermark }))} />
              <Field label="File name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Save to">
                <FolderField value={dir} onChange={setDir} />
              </Field>
              <button className="btn primary lg" disabled={busy || spec.images.length === 0} onClick={create}>
                <Zap size={17} /> Create slideshow
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
