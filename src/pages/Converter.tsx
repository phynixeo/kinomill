import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Captions, ClipboardPaste, Disc3, Film, Image, Link2, Music, Scissors, Trash2, Upload, X } from 'lucide-react';
import type { MediaInfo } from '../../shared/types';
import { OUTPUT_TARGETS, type OutputTarget, type TargetGroup } from '../../shared/presets';
import { addPathsToConverter, go, setState, useStore, type ConvItem } from '../lib/store';
import { pasteLink } from '../lib/actions';
import { pathForFile } from '../lib/api';
import { formatBytes, formatDuration } from '../lib/format';
import { describeMedia, editBadges, editedDuration, frameUrl } from '../lib/media';
import { Empty, Select, Thumb, Toggle, pickMediaFiles, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS, SUB_EXTS } from '../components/ui';
import { Editor } from '../components/Editor';
import { OutputDialog } from '../components/OutputDialog';
import { DiscDialog } from '../components/DiscDialog';

const GROUPS: { id: TargetGroup | 'popular'; label: string }[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'device', label: 'Devices' },
  { id: 'web', label: 'Web' },
  { id: 'disc', label: 'DVD & Blu-ray' },
  { id: 'image', label: 'GIF' },
];
const POPULAR = ['mp4', 'avi', 'wmv', 'mkv', 'mov', 'mp3', 'apple', 'android', 'dvd', 'bluray', 'gif', 'webm'];

export function ConverterPage() {
  const items = useStore((s) => s.conv);
  const join = useStore((s) => s.join);
  const [group, setGroup] = useState<TargetGroup | 'popular'>('popular');
  const [editing, setEditing] = useState<string | null>(null);
  const [target, setTarget] = useState<OutputTarget | null>(null);
  const [over, setOver] = useState(false);

  const hasVideo = items.some((i) => i.info.video && !i.info.isAudioOnly);
  const totalDuration = useMemo(() => items.reduce((n, i) => n + editedDuration(i.info, i.edit), 0), [items]);
  const targets = group === 'popular' ? POPULAR.map((id) => OUTPUT_TARGETS.find((t) => t.id === id)!).filter(Boolean) : OUTPUT_TARGETS.filter((t) => t.group === group);

  const addVideo = async () => addPathsToConverter(await pickMediaFiles({ title: 'Add video files', multi: true, filters: [{ name: 'Video files', extensions: VIDEO_EXTS }, { name: 'All files', extensions: ['*'] }] }));
  const addAudio = async () => addPathsToConverter(await pickMediaFiles({ title: 'Add audio files', multi: true, filters: [{ name: 'Audio files', extensions: AUDIO_EXTS }, { name: 'All files', extensions: ['*'] }] }));
  const addDvd = async () => {
    // pick the DVD drive or a DVD folder; the engine finds the main title and reads its VOBs as one video
    const dir = await pickMediaFiles({ title: 'Choose a DVD drive or a DVD folder (with VIDEO_TS inside)', folders: true });
    if (dir[0]) await addPathsToConverter([dir[0]]);
  };
  const update = (key: string, patch: Partial<ConvItem>) => setState((s) => ({ conv: s.conv.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const move = (key: string, dir: -1 | 1) =>
    setState((s) => {
      const i = s.conv.findIndex((c) => c.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.conv.length) return {};
      const copy = s.conv.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return { conv: copy };
    });

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
    const images = paths.filter((p) => IMAGE_EXTS.includes(p.split('.').pop()!.toLowerCase()));
    const media = paths.filter((p) => !images.includes(p));
    if (media.length) await addPathsToConverter(media);
    if (images.length) {
      setState((s) => ({ slideshow: { ...s.slideshow, images: [...s.slideshow.images, ...images] }, page: 'slideshow' }));
    }
  };

  const editItem = items.find((i) => i.key === editing);

  return (
    <div
      className="page"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="page-head">
        <h1>Converter</h1>
        <div className="add-bar">
          <button className="add-btn" onClick={addVideo}>
            <span className="ic" style={{ background: '#2f80ed' }}>
              <Film size={16} />
            </span>
            Video
          </button>
          <button className="add-btn" onClick={addAudio}>
            <span className="ic" style={{ background: '#e84393' }}>
              <Music size={16} />
            </span>
            Audio
          </button>
          <button className="add-btn" onClick={addDvd}>
            <span className="ic" style={{ background: '#6c5ce7' }}>
              <Disc3 size={16} />
            </span>
            DVD
          </button>
          <button className="add-btn" onClick={() => go('slideshow')}>
            <span className="ic" style={{ background: '#00b894' }}>
              <Image size={16} />
            </span>
            Photo
          </button>
          <button className="add-btn" onClick={() => void pasteLink('converter')}>
            <span className="ic" style={{ background: '#e2551f' }}>
              <Link2 size={16} />
            </span>
            Paste URL
          </button>
        </div>
        <div className="spacer" />
        {items.length > 0 && (
          <>
            <Toggle checked={join} onChange={(v) => setState({ join: v })} disabled={items.length < 2} label={<b>Join files</b>} title="Merge all files into one video" />
            <button className="btn ghost" onClick={() => setState({ conv: [] })}>
              <X size={16} /> Clear
            </button>
          </>
        )}
      </div>

      <div className={`page-body ${over ? 'dropzone over' : ''}`} style={over ? { margin: '0 22px 10px', padding: 10 } : undefined}>
        {items.length === 0 ? (
          <Empty icon={<Upload size={38} />} title="Convert, trim and join videos">
            <p>Add video or audio files — or drag and drop them here. Convert to MP4, AVI, MP3, DVD, iPhone, Android and 40+ formats. Cut out parts, rotate, crop, add subtitles and more.</p>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary lg" onClick={addVideo}>
                <Film size={18} /> Add video
              </button>
              <button className="btn lg" onClick={() => void pasteLink('converter')}>
                <ClipboardPaste size={18} /> Paste URL
              </button>
            </div>
          </Empty>
        ) : (
          <div className="list">
            {items.map((it, idx) => (
              <ConvRow
                key={it.key}
                item={it}
                index={idx}
                count={items.length}
                join={join}
                onEdit={() => setEditing(it.key)}
                onRemove={() => setState((s) => ({ conv: s.conv.filter((c) => c.key !== it.key) }))}
                onMove={(d) => move(it.key, d)}
                onChange={(p) => update(it.key, p)}
              />
            ))}
            {join && items.length > 1 && (
              <div className="notice" style={{ marginTop: 10 }}>
                <Film size={16} />
                <span>
                  All {items.length} files will be joined into one, in this order. Total length: <b>{formatDuration(totalDuration)}</b>.
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="formats">
        <div className="row">
          <b>Convert to</b>
          <div className="row gap-4 wrap" style={{ marginLeft: 8 }}>
            {GROUPS.map((g) => (
              <button key={g.id} className={`chip ${group === g.id ? 'on' : ''}`} onClick={() => setGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          {items.length > 0 && <span className="muted small">{items.length} file{items.length > 1 ? 's' : ''} · {formatDuration(totalDuration)}</span>}
        </div>
        <div className="format-grid">
          {targets.map((t) => {
            const needsVideo = t.videoCodecs.length > 0 && t.audioCodecs.length === 0;
            const disabled = items.length === 0 || (needsVideo && !hasVideo) || ((t.group === 'disc' || t.special === 'html5') && !hasVideo);
            return (
              <button key={t.id} className="fmt" disabled={disabled} onClick={() => setTarget(t)} title={t.description} aria-label={`Convert to ${t.label}`}>
                <span className="chipfmt" style={{ background: t.color }}>
                  {t.badge}
                </span>
                <span className="to">to {t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {editItem && (
        <Editor
          info={editItem.info}
          edit={editItem.edit}
          onClose={() => setEditing(null)}
          onSave={(edit) => {
            update(editItem.key, { edit });
            setEditing(null);
          }}
        />
      )}
      {target && (target.group === 'disc' ? <DiscDialog target={target} items={items} onClose={() => setTarget(null)} /> : <OutputDialog target={target} items={items} join={join && items.length > 1} onClose={() => setTarget(null)} />)}
    </div>
  );
}

function ConvRow(props: {
  item: ConvItem;
  index: number;
  count: number;
  join: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  onChange: (p: Partial<ConvItem>) => void;
}) {
  const { info, edit } = props.item;
  const badges = editBadges(info, edit);
  const dur = editedDuration(info, edit);
  const subOptions: { value: string; label: string }[] = [
    { value: 'none', label: 'No subtitles' },
    ...info.subtitleTracks.map((s) => ({ value: `s${s.order}`, label: `Burn in: ${s.title || s.language || 'Track ' + (s.order + 1)}` })),
    ...(edit.subtitles?.path ? [{ value: 'file', label: `Burn in: ${edit.subtitles.path.split(/[\\/]/).pop()}` }] : []),
    { value: 'add', label: 'Add subtitle file…' },
  ];
  const subValue = !edit.subtitles ? 'none' : edit.subtitles.path ? 'file' : `s${edit.subtitles.streamOrder ?? 0}`;

  const setSubs = async (v: string) => {
    const base = edit.subtitles ?? { fontName: 'Arial', fontSize: 22, primaryColor: '#FFFFFF', outlineColor: '#000000', outline: 2, bold: false, position: 'bottom' as const, marginV: 20 };
    if (v === 'none') props.onChange({ edit: { ...edit, subtitles: null } });
    else if (v === 'add') {
      const f = await pickMediaFiles({ title: 'Choose a subtitle file', filters: [{ name: 'Subtitles', extensions: SUB_EXTS }] });
      if (f[0]) props.onChange({ edit: { ...edit, subtitles: { ...base, path: f[0], streamOrder: undefined } } });
    } else if (v.startsWith('s')) props.onChange({ edit: { ...edit, subtitles: { ...base, path: undefined, streamOrder: Number(v.slice(1)) } } });
  };

  return (
    <div className="item conv-row">
      {props.join && (
        <div className="col gap-4">
          <button className="icon-btn sm" disabled={props.index === 0} onClick={() => props.onMove(-1)} aria-label="Move up">
            <ArrowUp size={15} />
          </button>
          <button className="icon-btn sm" disabled={props.index === props.count - 1} onClick={() => props.onMove(1)} aria-label="Move down">
            <ArrowDown size={15} />
          </button>
        </div>
      )}
      <Thumb
        src={info.video && !info.isAudioOnly ? frameUrl(info.path, Math.min(info.duration * 0.1, 30), 240) : undefined}
        duration={formatDuration(dur)}
        fallback={info.isAudioOnly ? <Music size={22} /> : <Film size={22} />}
      />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title" title={info.path}>
          {info.name}
        </div>
        <div className="meta">
          <span className="ellipsis">{describeMedia(info)}</span>
          <span className="dot">{formatBytes(info.size)}</span>
        </div>
        {badges.length > 0 && (
          <div className="edits" style={{ marginTop: 6 }}>
            {badges.map((b) => (
              <span key={b} className="badge accent">
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
      {info.audioTracks.length > 1 && (
        <Select
          style={{ width: 170 }}
          title="Audio track"
          value={edit.audioTrack}
          options={[...info.audioTracks.map((a) => ({ value: a.order, label: `Audio: ${a.title || a.language || 'Track ' + (a.order + 1)} (${a.codec})` })), { value: -1, label: 'No audio' }]}
          onChange={(audioTrack) => props.onChange({ edit: { ...edit, audioTrack } })}
        />
      )}
      {info.video && !info.isAudioOnly && (
        <div className="row gap-4">
          <Captions size={16} className="faint" />
          <Select style={{ width: 170 }} title="Subtitles" value={subValue} options={subOptions} onChange={(v) => void setSubs(v)} />
        </div>
      )}
      <button className="btn" onClick={props.onEdit} title="Cut, rotate, crop, effects">
        <Scissors size={16} /> Edit
      </button>
      <button className="icon-btn danger" onClick={props.onRemove} aria-label="Remove from list">
        <Trash2 size={17} />
      </button>
    </div>
  );
}

export type { MediaInfo };
