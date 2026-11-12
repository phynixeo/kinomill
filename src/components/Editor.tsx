import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronFirst, ChevronLast, Crop as CropIcon, FlipHorizontal2, FlipVertical2, Music, Pause, Play, RotateCcw, RotateCw, Scan, Scissors,
  SkipBack, SkipForward, Sparkles, Trash2, Captions, Volume2, Undo2,
} from 'lucide-react';
import type { Crop, EditSpec, Interval, MediaInfo, SubtitleBurn } from '../../shared/types';
import { defaultEdit } from '../../shared/defaults';
import { call, toast } from '../lib/store';
import { formatTimecode, parseTimecode } from '../lib/format';
import { editedDuration, frameUrl, liveUrl } from '../lib/media';
import { Check, Field, Modal, Select, pickMediaFiles, SUB_EXTS } from './ui';

type Tab = 'trim' | 'crop' | 'subs' | 'audio' | 'effects';

export function mergeIntervals(list: Interval[], duration: number): Interval[] {
  const sorted = list
    .map((c) => ({ start: Math.max(0, Math.min(c.start, c.end)), end: Math.min(duration, Math.max(c.start, c.end)) }))
    .filter((c) => c.end - c.start > 0.01)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 0.001) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Calibri', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Consolas'];

export function Editor(props: { info: MediaInfo; edit: EditSpec; onClose: () => void; onSave: (e: EditSpec) => void }) {
  const info = props.info;
  const dur = info.duration || 0;
  const fps = info.video?.fps || 25;
  const hasVideo = !!info.video && !info.isAudioOnly;
  /** The built-in player can decode this file directly (MP4/WebM with H.264/VP9/AV1 …). */
  const native = info.browserPlayable && !!info.mediaUrl;
  const canPlay = hasVideo || info.audioTracks.length > 0;
  const stillWidth = Math.min(1280, info.video?.width ?? 1280);

  const [edit, setEdit] = useState<EditSpec>(props.edit);
  const [tab, setTab] = useState<Tab>('trim');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [frameT, setFrameT] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // Other formats (AVI, MKV, WMV, HEVC …) play through a live preview stream that starts at `live.start`.
  const [live, setLive] = useState<{ start: number; src: string } | null>(null);
  const liveSeekTimer = useRef<number | undefined>(undefined);
  const offset = live?.start ?? 0;

  const set = (patch: Partial<EditSpec>) => setEdit((e) => ({ ...e, ...patch }));

  // still frame for formats the browser can't play directly (shown while paused)
  useEffect(() => {
    if (native) return;
    const h = setTimeout(() => setFrameT(t), 120);
    return () => clearTimeout(h);
  }, [t, native]);

  const startLive = useCallback(
    (from: number) => {
      window.clearTimeout(liveSeekTimer.current);
      const start = from >= dur - 0.1 ? 0 : Math.max(0, from);
      setT(start);
      setLive({ start, src: liveUrl(info.path, start, edit.audioTrack, hasVideo ? 'video' : 'audio') });
    },
    [dur, info.path, edit.audioTrack, hasVideo],
  );

  const stopLive = useCallback(
    (at?: number) => {
      window.clearTimeout(liveSeekTimer.current);
      const m = mediaRef.current;
      const now = at ?? (m && live ? live.start + m.currentTime : t);
      m?.pause();
      setLive(null);
      setPlaying(false);
      setT(Math.max(0, Math.min(dur, now)));
    },
    [live, t, dur],
  );

  // smooth playhead while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (mediaRef.current) setT(offset + mediaRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, offset]);

  // skip over deleted parts while previewing
  useEffect(() => {
    if (!playing || !mediaRef.current) return;
    const c = edit.cuts.find((x) => t >= x.start && t < x.end - 0.05);
    if (!c) return;
    if (native) mediaRef.current.currentTime = Math.min(dur, c.end);
    else startLive(c.end);
  }, [t, playing, edit.cuts, dur, native, startLive]);

  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.playbackRate = edit.speed;
      mediaRef.current.volume = Math.min(1, edit.volume);
      mediaRef.current.muted = edit.audioTrack === -1;
    }
  }, [edit.speed, edit.volume, edit.audioTrack, live]);

  const seek = useCallback(
    (time: number) => {
      const v = Math.max(0, Math.min(dur, time));
      setT(v);
      if (native) {
        if (mediaRef.current) mediaRef.current.currentTime = v;
      } else if (live) {
        // restart the preview stream at the new position (debounced while dragging the timeline)
        mediaRef.current?.pause();
        window.clearTimeout(liveSeekTimer.current);
        liveSeekTimer.current = window.setTimeout(() => startLive(v), 250);
      }
    },
    [dur, native, live, startLive],
  );

  const togglePlay = useCallback(() => {
    if (native) {
      const m = mediaRef.current;
      if (!m) return;
      if (m.paused) void m.play();
      else m.pause();
      return;
    }
    if (live) stopLive();
    else startLive(t);
  }, [native, live, stopLive, startLive, t]);

  // stop the preview stream when the editor closes
  useEffect(() => () => window.clearTimeout(liveSeekTimer.current), []);

  const cutSelection = useCallback(() => {
    if (selStart === null || selEnd === null) return;
    set({ cuts: mergeIntervals([...edit.cuts, { start: selStart, end: selEnd }], dur) });
    setSelStart(null);
    setSelEnd(null);
  }, [selStart, selEnd, edit.cuts, dur]);

  const keepSelection = () => {
    if (selStart === null || selEnd === null) return;
    const a = Math.min(selStart, selEnd);
    const b = Math.max(selStart, selEnd);
    set({ cuts: mergeIntervals([...edit.cuts, { start: 0, end: a }, { start: b, end: dur }], dur) });
    setSelStart(null);
    setSelEnd(null);
  };

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        // a focused button would also "click" on Space and toggle a second time
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
        togglePlay();
      } else if (e.key === 'ArrowLeft') seek(t - (e.shiftKey ? 5 : 1 / fps));
      else if (e.key === 'ArrowRight') seek(t + (e.shiftKey ? 5 : 1 / fps));
      else if (e.key === '[' || e.key === 'i') setSelStart(t);
      else if (e.key === ']' || e.key === 'o') setSelEnd(t);
      else if (e.key === 'Delete') cutSelection();
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(dur);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, fps, dur, seek, togglePlay, cutSelection]);

  const resultDuration = editedDuration(info, edit);
  const cssFilter = `brightness(${1 + edit.brightness * 0.6}) contrast(${1 + edit.contrast}) saturate(${1 + edit.saturation})`;
  const transform = `rotate(${edit.rotate}deg) scale(${edit.flipH ? -1 : 1}, ${edit.flipV ? -1 : 1})`;

  return (
    <Modal
      size="xwide"
      title={<span className="ellipsis">Edit — {info.name}</span>}
      onClose={props.onClose}
      bodyClass="editor-body"
      closeOnBackdrop={false}
      footer={
        <>
          <button className="btn ghost" onClick={() => setEdit({ ...defaultEdit(), audioTrack: info.audioTracks.length ? 0 : -1 })}>
            <Undo2 size={16} /> Reset all
          </button>
          <span className="muted small">
            Result length: <b>{formatTimecode(resultDuration)}</b> {edit.cuts.length > 0 && `(${edit.cuts.length} part${edit.cuts.length > 1 ? 's' : ''} removed)`}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => props.onSave(edit)}>
            Save changes
          </button>
        </>
      }
    >
      <div className="editor">
        <div className="stage-col">
          <div className="stage">
            <div className={`viewport ${edit.rotate % 180 ? 'sideways' : ''}`} style={{ transform, filter: cssFilter, transition: 'transform 0.2s' }}>
              {hasVideo ? (
                native ? (
                  <video
                    ref={mediaRef}
                    src={info.mediaUrl}
                    preload="auto"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    onTimeUpdate={(e) => !playing && setT(e.currentTarget.currentTime)}
                  />
                ) : live ? (
                  <video
                    ref={mediaRef}
                    key={live.src}
                    src={live.src}
                    autoPlay
                    poster={frameUrl(info.path, live.start, stillWidth)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => stopLive(dur)}
                    onError={() => {
                      stopLive();
                      toast('error', 'This file could not be played. You can still drag the timeline to see frames.');
                    }}
                  />
                ) : (
                  <img className="frame" src={frameUrl(info.path, frameT, stillWidth)} alt="" draggable={false} />
                )
              ) : (
                <div className="col" style={{ alignItems: 'center', color: '#9aa3b2', padding: 40 }}>
                  <Music size={64} />
                  {native && (
                    <audio
                      ref={mediaRef}
                      src={info.mediaUrl}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onEnded={() => setPlaying(false)}
                      onTimeUpdate={(e) => !playing && setT(e.currentTarget.currentTime)}
                    />
                  )}
                  {!native && live && (
                    <audio ref={mediaRef} key={live.src} src={live.src} autoPlay onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => stopLive(dur)} />
                  )}
                </div>
              )}
              {hasVideo && tab === 'crop' && edit.crop && info.video && <CropBox crop={edit.crop} srcW={info.video.width} srcH={info.video.height} onChange={(crop) => set({ crop })} />}
            </div>
            {!native && live && (
              <div className="tiny" style={{ position: 'absolute', left: 10, top: 8, color: '#c9ced8', background: 'rgba(0,0,0,.55)', padding: '2px 8px', borderRadius: 5 }}>
                Preview quality — the converted file keeps full quality
              </div>
            )}
          </div>

          <Timeline info={info} t={t} cuts={edit.cuts} selStart={selStart} selEnd={selEnd} onSeek={seek} />

          <div className="transport">
            <button className="icon-btn" title="Go to start (Home)" onClick={() => seek(0)}>
              <ChevronFirst size={18} />
            </button>
            <button className="icon-btn" title="Back 5 s (Shift+←)" onClick={() => seek(t - 5)}>
              <SkipBack size={17} />
            </button>
            <button className="icon-btn" title="Previous frame (←)" onClick={() => seek(t - 1 / fps)}>
              ‹
            </button>
            <button className="btn primary sm" style={{ width: 38 }} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={!canPlay}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button className="icon-btn" title="Next frame (→)" onClick={() => seek(t + 1 / fps)}>
              ›
            </button>
            <button className="icon-btn" title="Forward 5 s (Shift+→)" onClick={() => seek(t + 5)}>
              <SkipForward size={17} />
            </button>
            <button className="icon-btn" title="Go to end (End)" onClick={() => seek(dur)}>
              <ChevronLast size={18} />
            </button>
            <TimeInput value={t} max={dur} onChange={seek} />
            <span className="muted small">/ {formatTimecode(dur)}</span>
            <div className="spacer" />
            <button className="btn sm" title="Mark selection start ([)" onClick={() => setSelStart(t)}>
              [ Start
            </button>
            <button className="btn sm" title="Mark selection end (])" onClick={() => setSelEnd(t)}>
              End ]
            </button>
            <button className="btn sm primary" title="Delete the selected part (Del)" disabled={selStart === null || selEnd === null} onClick={cutSelection}>
              <Scissors size={14} /> Cut out
            </button>
            <button className="btn sm" title="Delete everything outside the selection" disabled={selStart === null || selEnd === null} onClick={keepSelection}>
              Keep only this
            </button>
          </div>
        </div>

        <div className="side">
          <div className="seg" style={{ alignSelf: 'stretch', display: 'grid', gridTemplateColumns: hasVideo ? 'repeat(5, 1fr)' : 'repeat(3, 1fr)' }}>
            <button className={tab === 'trim' ? 'on' : ''} onClick={() => setTab('trim')} title="Trim">
              <Scissors size={15} />
            </button>
            {hasVideo && (
              <button className={tab === 'crop' ? 'on' : ''} onClick={() => setTab('crop')} title="Crop & rotate">
                <CropIcon size={15} />
              </button>
            )}
            {hasVideo && (
              <button className={tab === 'subs' ? 'on' : ''} onClick={() => setTab('subs')} title="Subtitles">
                <Captions size={15} />
              </button>
            )}
            <button className={tab === 'audio' ? 'on' : ''} onClick={() => setTab('audio')} title="Audio">
              <Volume2 size={15} />
            </button>
            <button className={tab === 'effects' ? 'on' : ''} onClick={() => setTab('effects')} title="Effects">
              <Sparkles size={15} />
            </button>
          </div>

          {tab === 'trim' && (
            <>
              <h3>Cut out parts</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Move to where a part starts and click <b>[ Start</b>, then to where it ends and click <b>End ]</b>. Then <b>Cut out</b> removes it, or <b>Keep only this</b> removes everything else.
              </p>
              {selStart !== null && (
                <div className="notice" style={{ padding: '8px 10px' }}>
                  Selection: {formatTimecode(selStart)} → {selEnd !== null ? formatTimecode(selEnd) : '…'}
                  <div className="spacer" />
                  <button className="btn sm ghost" onClick={() => { setSelStart(null); setSelEnd(null); }}>
                    Clear
                  </button>
                </div>
              )}
              <div className="col gap-4">
                {edit.cuts.length === 0 && <div className="faint small">Nothing removed yet.</div>}
                {edit.cuts.map((c, i) => (
                  <div key={i} className="row card flat" style={{ padding: '6px 10px' }}>
                    <Scissors size={14} style={{ color: 'var(--danger)' }} />
                    <button className="btn ghost sm mono" onClick={() => seek(c.start)}>
                      {formatTimecode(c.start)}
                    </button>
                    →
                    <button className="btn ghost sm mono" onClick={() => seek(c.end)}>
                      {formatTimecode(c.end)}
                    </button>
                    <div className="spacer" />
                    <button className="icon-btn sm danger" onClick={() => set({ cuts: edit.cuts.filter((_, j) => j !== i) })} aria-label="Restore this part">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="tiny faint">Shortcuts: Space play · ←/→ frame · Shift+←/→ 5 s · [ ] mark · Del cut</div>
            </>
          )}

          {tab === 'crop' && info.video && (
            <>
              <h3>Rotate & flip</h3>
              <div className="row wrap gap-4">
                <button className="btn sm" onClick={() => set({ rotate: (((edit.rotate + 270) % 360) as EditSpec['rotate']) })}>
                  <RotateCcw size={15} /> Left
                </button>
                <button className="btn sm" onClick={() => set({ rotate: (((edit.rotate + 90) % 360) as EditSpec['rotate']) })}>
                  <RotateCw size={15} /> Right
                </button>
                <button className={`btn sm ${edit.flipH ? 'primary' : ''}`} onClick={() => set({ flipH: !edit.flipH })}>
                  <FlipHorizontal2 size={15} /> Mirror
                </button>
                <button className={`btn sm ${edit.flipV ? 'primary' : ''}`} onClick={() => set({ flipV: !edit.flipV })}>
                  <FlipVertical2 size={15} /> Upside down
                </button>
              </div>
              <h3 style={{ marginTop: 6 }}>Crop & zoom</h3>
              <div className="row wrap gap-4">
                {[
                  ['Free', 0],
                  ['16:9', 16 / 9],
                  ['4:3', 4 / 3],
                  ['1:1', 1],
                  ['9:16', 9 / 16],
                  ['21:9', 21 / 9],
                ].map(([label, ratio]) => (
                  <button key={label as string} className="chip" onClick={() => set({ crop: cropForRatio(info.video!.width, info.video!.height, ratio as number) })}>
                    {label}
                  </button>
                ))}
              </div>
              {edit.crop && (
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {(['x', 'y', 'w', 'h'] as const).map((k) => (
                    <Field key={k} label={{ x: 'Left', y: 'Top', w: 'Width', h: 'Height' }[k]}>
                      <input
                        className="input"
                        type="number"
                        value={edit.crop![k]}
                        onChange={(e) => set({ crop: clampCrop({ ...edit.crop!, [k]: Number(e.target.value) || 0 }, info.video!.width, info.video!.height) })}
                      />
                    </Field>
                  ))}
                </div>
              )}
              <div className="row wrap gap-4">
                <button
                  className="btn sm"
                  disabled={detecting}
                  onClick={async () => {
                    setDetecting(true);
                    const c = await call('convert.detectCrop', { path: info.path });
                    setDetecting(false);
                    if (c) set({ crop: c });
                  }}
                >
                  <Scan size={15} /> {detecting ? 'Detecting…' : 'Detect black bars'}
                </button>
                {edit.crop && (
                  <button className="btn sm ghost" onClick={() => set({ crop: null })}>
                    Remove crop
                  </button>
                )}
              </div>
              <Check checked={edit.autoRemoveBlackBars} onChange={(v) => set({ autoRemoveBlackBars: v })} label="Remove black bars automatically when converting" />
              <div className="tiny faint">Drag the orange frame on the video to choose what to keep.</div>
            </>
          )}

          {tab === 'subs' && <SubtitlePanel info={info} value={edit.subtitles} onChange={(subtitles) => set({ subtitles })} />}

          {tab === 'audio' && (
            <>
              <h3>Audio</h3>
              {info.audioTracks.length > 0 ? (
                <Field label="Audio track">
                  <Select
                    value={edit.audioTrack}
                    options={[...info.audioTracks.map((a) => ({ value: a.order, label: `${a.title || a.language || 'Track ' + (a.order + 1)} — ${a.codec}, ${a.channels}ch` })), { value: -1, label: 'No audio (mute)' }]}
                    onChange={(audioTrack) => set({ audioTrack })}
                  />
                </Field>
              ) : (
                <div className="muted small">This file has no audio.</div>
              )}
              <Field label={`Volume: ${Math.round(edit.volume * 100)}%`}>
                <input type="range" min={0} max={300} step={5} value={Math.round(edit.volume * 100)} onChange={(e) => set({ volume: Number(e.target.value) / 100 })} />
              </Field>
              <Check checked={edit.normalizeAudio} onChange={(normalizeAudio) => set({ normalizeAudio })} label="Normalize loudness (even out quiet and loud parts)" />
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="Fade in (s)">
                  <input className="input" type="number" min={0} step={0.5} value={edit.fadeIn} onChange={(e) => set({ fadeIn: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
                <Field label="Fade out (s)">
                  <input className="input" type="number" min={0} step={0.5} value={edit.fadeOut} onChange={(e) => set({ fadeOut: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
              </div>
            </>
          )}

          {tab === 'effects' && (
            <>
              <h3>Speed</h3>
              <div className="row wrap gap-4">
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => (
                  <button key={s} className={`chip ${edit.speed === s ? 'on' : ''}`} onClick={() => set({ speed: s })}>
                    {s}×
                  </button>
                ))}
              </div>
              {hasVideo && (
                <>
                  <h3 style={{ marginTop: 6 }}>Color</h3>
                  {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
                    <Field key={k} label={`${k[0].toUpperCase() + k.slice(1)}: ${edit[k] > 0 ? '+' : ''}${Math.round(edit[k] * 100)}`}>
                      <input type="range" min={-100} max={100} value={Math.round(edit[k] * 100)} onChange={(e) => set({ [k]: Number(e.target.value) / 100 } as Partial<EditSpec>)} onDoubleClick={() => set({ [k]: 0 } as Partial<EditSpec>)} />
                    </Field>
                  ))}
                  <Check checked={edit.deinterlace} onChange={(deinterlace) => set({ deinterlace })} label="Deinterlace (fixes comb lines in old TV / DVD video)" />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ───────── Timeline ───────── */
function Timeline(props: { info: MediaInfo; t: number; cuts: Interval[]; selStart: number | null; selEnd: number | null; onSeek: (t: number) => void }) {
  const dur = props.info.duration || 1;
  const ref = useRef<HTMLDivElement>(null);
  const thumbs = useMemo(() => {
    if (!props.info.video || props.info.isAudioOnly) return [];
    const n = 12;
    return Array.from({ length: n }, (_, i) => frameUrl(props.info.path, ((i + 0.5) / n) * dur, 160));
  }, [props.info, dur]);
  const pct = (x: number) => `${(Math.max(0, Math.min(dur, x)) / dur) * 100}%`;
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * dur;
  };
  const a = props.selStart;
  const b = props.selEnd;
  return (
    <div
      ref={ref}
      className="timeline"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        props.onSeek(fromEvent(e));
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) props.onSeek(fromEvent(e));
      }}
      role="slider"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={dur}
      aria-valuenow={props.t}
    >
      <div className="strip">{thumbs.map((src, i) => <img key={i} src={src} alt="" draggable={false} />)}</div>
      {props.cuts.map((c, i) => (
        <div key={i} className="cut" style={{ left: pct(c.start), width: `calc(${pct(c.end)} - ${pct(c.start)})` }} />
      ))}
      {a !== null && (
        <div className="sel" style={{ left: pct(Math.min(a, b ?? a)), width: b !== null ? `calc(${pct(Math.max(a, b))} - ${pct(Math.min(a, b))})` : '2px' }} />
      )}
      <div className="playhead" style={{ left: pct(props.t) }} />
    </div>
  );
}

function TimeInput(props: { value: number; max: number; onChange: (t: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="timecode"
      style={{ width: 118, border: 0 }}
      value={text ?? formatTimecode(props.value)}
      onFocus={() => setText(formatTimecode(props.value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = parseTimecode(text ?? '');
        if (v !== null) props.onChange(Math.min(props.max, v));
        setText(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="Current time"
    />
  );
}

/* ───────── Crop box ───────── */
function clampCrop(c: Crop, W: number, H: number): Crop {
  const w = Math.max(16, Math.min(W, Math.round(c.w / 2) * 2));
  const h = Math.max(16, Math.min(H, Math.round(c.h / 2) * 2));
  const x = Math.max(0, Math.min(W - w, Math.round(c.x)));
  const y = Math.max(0, Math.min(H - h, Math.round(c.y)));
  return { x, y, w, h };
}

function cropForRatio(W: number, H: number, ratio: number): Crop {
  if (!ratio) return clampCrop({ x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.8 }, W, H);
  let w = W;
  let h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  return clampCrop({ x: (W - w) / 2, y: (H - h) / 2, w, h }, W, H);
}

function CropBox(props: { crop: Crop; srcW: number; srcH: number; onChange: (c: Crop) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const media = boxRef.current?.parentElement?.querySelector('video, img') as HTMLElement | null;
    if (!media) return;
    const ro = new ResizeObserver(() => setScale(media.clientWidth / props.srcW));
    ro.observe(media);
    setScale(media.clientWidth / props.srcW);
    return () => ro.disconnect();
  }, [props.srcW]);
  const c = props.crop;
  const start = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const c0 = { ...c };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / scale;
      const dy = (ev.clientY - y0) / scale;
      let n = { ...c0 };
      if (mode === 'move') n = { ...c0, x: c0.x + dx, y: c0.y + dy };
      if (mode === 'nw') n = { x: c0.x + dx, y: c0.y + dy, w: c0.w - dx, h: c0.h - dy };
      if (mode === 'ne') n = { x: c0.x, y: c0.y + dy, w: c0.w + dx, h: c0.h - dy };
      if (mode === 'sw') n = { x: c0.x + dx, y: c0.y, w: c0.w - dx, h: c0.h + dy };
      if (mode === 'se') n = { ...c0, w: c0.w + dx, h: c0.h + dy };
      props.onChange(clampCrop(n, props.srcW, props.srcH));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const hs = 12;
  return (
    <div ref={boxRef} className="crop-box" style={{ left: c.x * scale, top: c.y * scale, width: c.w * scale, height: c.h * scale }} onPointerDown={start('move')}>
      <div className="h" style={{ left: -hs / 2, top: -hs / 2, cursor: 'nwse-resize' }} onPointerDown={start('nw')} />
      <div className="h" style={{ right: -hs / 2, top: -hs / 2, cursor: 'nesw-resize' }} onPointerDown={start('ne')} />
      <div className="h" style={{ left: -hs / 2, bottom: -hs / 2, cursor: 'nesw-resize' }} onPointerDown={start('sw')} />
      <div className="h" style={{ right: -hs / 2, bottom: -hs / 2, cursor: 'nwse-resize' }} onPointerDown={start('se')} />
    </div>
  );
}

/* ───────── Subtitles ───────── */
function SubtitlePanel(props: { info: MediaInfo; value: SubtitleBurn | null; onChange: (v: SubtitleBurn | null) => void }) {
  const s = props.value;
  const base: SubtitleBurn = s ?? { fontName: 'Arial', fontSize: 22, primaryColor: '#FFFFFF', outlineColor: '#000000', outline: 2, bold: false, position: 'bottom', marginV: 20 };
  const set = (patch: Partial<SubtitleBurn>) => props.onChange({ ...base, ...patch });
  const source = !s ? 'none' : s.path ? 'file' : `s${s.streamOrder ?? 0}`;
  return (
    <>
      <h3>Burn in subtitles</h3>
      <Field label="Subtitles">
        <Select
          value={source}
          options={[
            { value: 'none', label: 'None' },
            ...props.info.subtitleTracks.map((t) => ({ value: `s${t.order}`, label: `Built-in: ${t.title || t.language || 'Track ' + (t.order + 1)} (${t.codec})` })),
            ...(s?.path ? [{ value: 'file', label: s.path.split(/[\\/]/).pop()! }] : []),
          ]}
          onChange={(v) => {
            if (v === 'none') props.onChange(null);
            else if (v.startsWith('s')) set({ path: undefined, streamOrder: Number(v.slice(1)) });
          }}
        />
      </Field>
      <button
        className="btn sm"
        onClick={async () => {
          const f = await pickMediaFiles({ title: 'Choose a subtitle file', filters: [{ name: 'Subtitles', extensions: SUB_EXTS }] });
          if (f[0]) set({ path: f[0], streamOrder: undefined });
        }}
      >
        Add subtitle file (.srt, .ass, .vtt)…
      </button>
      {s && (
        <>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Font">
              <Select value={base.fontName} options={FONTS.map((f) => ({ value: f, label: f }))} onChange={(fontName) => set({ fontName })} />
            </Field>
            <Field label={`Size: ${base.fontSize}`}>
              <input type="range" min={10} max={60} value={base.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
            </Field>
            <Field label="Text color">
              <input type="color" className="input" style={{ padding: 2 }} value={base.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} />
            </Field>
            <Field label="Outline color">
              <input type="color" className="input" style={{ padding: 2 }} value={base.outlineColor} onChange={(e) => set({ outlineColor: e.target.value })} />
            </Field>
            <Field label={`Outline: ${base.outline}`}>
              <input type="range" min={0} max={6} value={base.outline} onChange={(e) => set({ outline: Number(e.target.value) })} />
            </Field>
            <Field label="Position">
              <Select
                value={base.position}
                options={[
                  { value: 'bottom', label: 'Bottom' },
                  { value: 'middle', label: 'Middle' },
                  { value: 'top', label: 'Top' },
                ]}
                onChange={(position) => set({ position })}
              />
            </Field>
          </div>
          <Check checked={base.bold} onChange={(bold) => set({ bold })} label="Bold" />
          <div className="card" style={{ background: '#222', textAlign: 'center', padding: 14 }}>
            <span
              style={{
                fontFamily: base.fontName,
                fontSize: Math.round(base.fontSize * 0.9),
                fontWeight: base.bold ? 700 : 400,
                color: base.primaryColor,
                textShadow: base.outline ? `0 0 ${base.outline}px ${base.outlineColor}, 0 0 ${base.outline}px ${base.outlineColor}` : 'none',
              }}
            >
              Subtitle preview
            </span>
          </div>
        </>
      )}
    </>
  );
}
