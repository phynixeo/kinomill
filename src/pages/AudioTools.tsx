import { useState } from 'react';
import { AudioLines, Download, Gauge, Layers, Link2, MicVocal, Music, Plus, Sparkles, Trash2, Volume2, Waves, Zap } from 'lucide-react';
import type { AudioToolOp, AudioToolSpec } from '../../shared/types';
import { call, go, setState, toast, useStore } from '../lib/store';
import { pasteLink } from '../lib/actions';
import { pathForFile } from '../lib/api';
import { basename } from '../lib/format';
import { Check, Empty, Field, FolderField, Select, pickMediaFiles, AUDIO_EXTS, VIDEO_EXTS } from '../components/ui';

const TOOLS: { op: AudioToolOp; title: string; desc: string; icon: typeof Music; ai?: boolean }[] = [
  { op: 'vocals', title: 'Isolate vocals', desc: 'Keep only the singing or speech, remove the music.', icon: MicVocal, ai: true },
  { op: 'instrumental', title: 'Remove vocals (karaoke)', desc: 'Make a backing track / sing-along version without vocals.', icon: Music, ai: true },
  { op: 'stems', title: 'Split into stems', desc: 'Separate vocals, drums, bass and other instruments into 4 files.', icon: Layers, ai: true },
  { op: 'denoise', title: 'Reduce noise', desc: 'Remove hiss, hum and steady background noise.', icon: Waves },
  { op: 'voice', title: 'Clean up voice', desc: 'Make speech clearer: less noise, softer "s" sounds, more presence.', icon: AudioLines },
  { op: 'dereverb', title: 'Reduce echo', desc: 'Make a roomy, echoey recording sound drier (best-effort).', icon: Sparkles },
  { op: 'normalize', title: 'Normalize loudness', desc: 'Even out the volume to the broadcast standard (EBU R128).', icon: Gauge },
];

export function AudioToolsPage() {
  const files = useStore((s) => s.audioFiles);
  const app = useStore((s) => s.app)!;
  const caps = app.capabilities;
  const [spec, setSpec] = useState<AudioToolSpec>({ op: 'instrumental', strength: 0.6, outputFormat: 'mp3', keepVideo: false });
  const [dir, setDir] = useState(app.settings.convertDir);
  const [busy, setBusy] = useState(false);
  const tool = TOOLS.find((t) => t.op === spec.op)!;
  const anyVideo = files.some((f) => VIDEO_EXTS.includes(f.split('.').pop()!.toLowerCase()));

  const add = async () => {
    const f = await pickMediaFiles({ title: 'Add audio or video files', multi: true, filters: [{ name: 'Audio & video', extensions: [...AUDIO_EXTS, ...VIDEO_EXTS] }] });
    if (f.length) setState((s) => ({ audioFiles: [...s.audioFiles, ...f] }));
  };

  const run = async () => {
    setBusy(true);
    const jobs = await call('audio.process', { inputs: files, spec, outputDir: dir });
    setBusy(false);
    if (jobs) {
      toast('success', `${tool.title}: processing ${jobs.length} file${jobs.length > 1 ? 's' : ''}`);
      go('tasks');
    }
  };

  return (
    <div
      className="page"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
        if (paths.length) setState((s) => ({ audioFiles: [...s.audioFiles, ...paths] }));
      }}
    >
      <div className="page-head">
        <h1>Audio tools</h1>
        <button className="btn primary" onClick={add}>
          <Plus size={17} /> Add files
        </button>
        <button className="btn" onClick={() => void pasteLink('audio')}>
          <Link2 size={16} /> Paste URL
        </button>
        <div className="spacer" />
      </div>
      <div className="page-body">
        <div className="section">
          <div className="tool-grid">
            {TOOLS.map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.op} className={`tool ${spec.op === t.op ? 'on' : ''}`} aria-label={t.title} aria-pressed={spec.op === t.op} onClick={() => setSpec((s) => ({ ...s, op: t.op }))}>
                  <div className="row">
                    <span className="ic">
                      <Icon size={18} />
                    </span>
                    <div className="spacer" />
                    {t.ai && <span className={`badge ${caps.aiAudioAvailable ? 'success' : ''}`}>AI</span>}
                  </div>
                  <b>{t.title}</b>
                  <span className="desc">{t.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {tool.ai && !caps.aiAudioAvailable && (
          <div className="notice warning section" style={{ alignItems: 'center' }}>
            <Sparkles size={18} />
            <div className="grow">
              <b>AI separation pack not installed.</b>{' '}
              {spec.op === 'instrumental'
                ? 'Without it, vocals are removed with a basic method that works best on studio songs with centered vocals.'
                : 'This tool needs the AI pack (Demucs, about 2–3 GB download, one time).'}
            </div>
            <button
              className="btn primary"
              disabled={caps.aiAudioInstalling}
              onClick={async () => {
                if (window.confirm('Install the AI separation pack? It downloads about 2–3 GB (PyTorch + Demucs) and needs Python 3.9–3.12 on this PC.')) {
                  await call('audio.installAi');
                }
              }}
            >
              <Download size={16} /> {caps.aiAudioInstalling ? 'Installing…' : 'Install AI pack'}
            </button>
          </div>
        )}

        {files.length === 0 ? (
          <Empty icon={<Volume2 size={38} />} title="Separate and clean up audio">
            <p>Add songs, podcasts or videos (or drop them here). Remove vocals for karaoke, isolate a voice, reduce background noise, or even out the volume.</p>
            <button className="btn primary lg" style={{ marginTop: 14 }} onClick={add}>
              <Plus size={18} /> Add files
            </button>
          </Empty>
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <div className="grow entries" style={{ maxHeight: 'none' }}>
              {files.map((f, i) => (
                <div key={f + i} className="entry">
                  {VIDEO_EXTS.includes(f.split('.').pop()!.toLowerCase()) ? <Volume2 size={15} className="faint" /> : <Music size={15} className="faint" />}
                  <span className="grow ellipsis" title={f}>
                    {basename(f)}
                  </span>
                  <button className="icon-btn sm danger" onClick={() => setState((s) => ({ audioFiles: s.audioFiles.filter((_, j) => j !== i) }))} aria-label="Remove">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="card col gap-12" style={{ width: 320, flex: 'none' }}>
              <h3>{tool.title}</h3>
              {(spec.op === 'denoise' || spec.op === 'voice' || spec.op === 'dereverb') && (
                <Field label={`Strength: ${Math.round(spec.strength * 100)}%`}>
                  <input type="range" min={10} max={100} value={Math.round(spec.strength * 100)} onChange={(e) => setSpec((s) => ({ ...s, strength: Number(e.target.value) / 100 }))} />
                </Field>
              )}
              <Field label="Save as">
                <Select
                  value={spec.outputFormat}
                  options={[
                    { value: 'mp3', label: 'MP3' },
                    { value: 'm4a', label: 'M4A (AAC)' },
                    { value: 'flac', label: 'FLAC (lossless)' },
                    { value: 'wav', label: 'WAV (lossless)' },
                  ]}
                  onChange={(outputFormat) => setSpec((s) => ({ ...s, outputFormat }))}
                />
              </Field>
              {anyVideo && spec.op !== 'stems' && <Check checked={spec.keepVideo} onChange={(keepVideo) => setSpec((s) => ({ ...s, keepVideo }))} label="For videos: put the new audio back into the video" />}
              <Field label="Save to">
                <FolderField value={dir} onChange={setDir} />
              </Field>
              <button className="btn primary lg" disabled={busy || (tool.ai && spec.op !== 'instrumental' && !caps.aiAudioAvailable)} onClick={run}>
                <Zap size={17} /> Process {files.length} file{files.length > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
