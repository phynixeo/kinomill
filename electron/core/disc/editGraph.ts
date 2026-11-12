// Builds an ffmpeg -filter_complex graph that applies an EditSpec
// (delete intervals, rotate, flip, crop, colour, burned subtitles, speed, fades,
// audio track/volume) and then fits the picture into a fixed frame (letterbox /
// pillarbox = "add black bars"), as needed for DVD and Blu-ray authoring.
// Pure functions only — no I/O — so it can be unit tested.
import type { EditSpec, Interval, MediaInfo, SubtitleBurn } from '../../../shared/types';

export interface FrameTarget {
  /** Stored frame size (e.g. 720×576 for PAL DVD). */
  width: number;
  height: number;
  /** Square-pixel box the picture is fitted into before the final (anamorphic) scale, e.g. 1024×576 for PAL 16:9. */
  boxWidth: number;
  boxHeight: number;
  /** Sample aspect ratio of the stored frame, e.g. "64/45". */
  sar: string;
  /** Output frame rate as an ffmpeg rational, e.g. "25" or "30000/1001". */
  fps: string;
  sampleRate: number;
  channels: number;
}

export interface EditGraph {
  /** Extra input arguments (after `-i <source>`), e.g. nothing today. */
  filterComplex: string;
  videoLabel: string; // e.g. "[vout]"
  audioLabel: string; // e.g. "[aout]"
  /** Output duration in seconds after cuts and speed change. */
  duration: number;
}

/** Merge and clamp the intervals to delete; return the intervals to KEEP. */
export function keepSegments(duration: number, cuts: Interval[]): Interval[] {
  const d = Math.max(0, duration);
  const sorted = cuts
    .map((c) => ({ start: Math.max(0, Math.min(c.start, c.end)), end: Math.min(d, Math.max(c.start, c.end)) }))
    .filter((c) => c.end - c.start > 0.01)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  const keep: Interval[] = [];
  let pos = 0;
  for (const c of merged) {
    if (c.start - pos > 0.04) keep.push({ start: pos, end: c.start });
    pos = c.end;
  }
  if (d - pos > 0.04) keep.push({ start: pos, end: d });
  return keep;
}

/** Escape a value for use inside single quotes in an ffmpeg filter option. */
export function escapeFilterPath(p: string): string {
  // ffmpeg wants forward slashes and an escaped drive colon: C\:/Videos/file.srt
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''");
}

function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = m ? m[1] : 'FFFFFF';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export function subtitleFilter(sub: SubtitleBurn, sourcePath: string): string {
  const file = sub.path ? sub.path : sourcePath;
  const align = sub.position === 'top' ? 8 : sub.position === 'middle' ? 5 : 2;
  const style = [
    `FontName=${sub.fontName.replace(/[,':\\]/g, '')}`,
    `FontSize=${Math.round(sub.fontSize)}`,
    `PrimaryColour=${assColor(sub.primaryColor)}`,
    `OutlineColour=${assColor(sub.outlineColor)}`,
    `BorderStyle=1`,
    `Outline=${Math.max(0, sub.outline)}`,
    `Bold=${sub.bold ? 1 : 0}`,
    `Alignment=${align}`,
    `MarginV=${Math.max(0, Math.round(sub.marginV))}`,
  ].join('\\,');
  const si = !sub.path && sub.streamOrder !== undefined ? `:si=${sub.streamOrder}` : '';
  return `subtitles=filename='${escapeFilterPath(file)}'${si}:force_style='${style}'`;
}

/** atempo only accepts 0.5..2 per instance; chain several for larger changes. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${+s.toFixed(6)}`);
  return out;
}

const fmt = (n: number) => +n.toFixed(4);

/**
 * Build the graph for input #`inputIndex` of the ffmpeg command line.
 * `crop` should already be resolved (e.g. from cropdetect when autoRemoveBlackBars is on).
 */
export function buildEditGraph(info: MediaInfo, edit: EditSpec, target: FrameTarget, inputIndex = 0): EditGraph {
  const parts: string[] = [];
  const keep = keepSegments(info.duration, edit.cuts);
  if (!keep.length) throw new Error(`Nothing is left of "${info.name}" after removing the selected intervals.`);
  const speed = Math.min(4, Math.max(0.25, edit.speed || 1));
  const keptDuration = keep.reduce((s, k) => s + (k.end - k.start), 0);
  const duration = keptDuration / speed;
  const multi = keep.length > 1;
  const needsTrim = multi || keep[0].start > 0.01 || keep[0].end < info.duration - 0.01;

  /* ── video ── */
  const vf: string[] = [];
  let vSrc: string;
  if (info.video && !info.isImage) {
    vSrc = `[${inputIndex}:v:0]`;
    if (edit.deinterlace) vf.push('bwdif=mode=send_frame');
    if (edit.crop && edit.crop.w > 0 && edit.crop.h > 0) {
      const c = edit.crop;
      vf.push(`crop=${Math.round(c.w / 2) * 2}:${Math.round(c.h / 2) * 2}:${Math.round(c.x)}:${Math.round(c.y)}`);
    }
    if (edit.rotate === 90) vf.push('transpose=1');
    else if (edit.rotate === 270) vf.push('transpose=2');
    else if (edit.rotate === 180) vf.push('hflip', 'vflip');
    if (edit.flipH) vf.push('hflip');
    if (edit.flipV) vf.push('vflip');
    if (edit.brightness || edit.contrast || edit.saturation) {
      vf.push(`eq=brightness=${fmt(edit.brightness * 0.5)}:contrast=${fmt(1 + edit.contrast)}:saturation=${fmt(1 + edit.saturation)}`);
    }
    if (edit.subtitles) vf.push(subtitleFilter(edit.subtitles, info.path));
  } else {
    // audio-only (or still image) input: black picture for the whole source duration
    vSrc = '';
    vf.push(`color=c=black:s=${target.boxWidth}x${target.boxHeight}:r=${target.fps}:d=${fmt(Math.max(0.1, info.duration))}`);
  }
  const vPre = vSrc ? `${vSrc}${vf.length ? vf.join(',') : 'null'}[vpre]` : `${vf.join(',')}[vpre]`;
  parts.push(vPre);

  /* ── audio ── */
  const hasAudio = info.audioTracks.length > 0 && edit.audioTrack >= 0;
  const order = hasAudio ? Math.min(edit.audioTrack, info.audioTracks.length - 1) : -1;
  const af: string[] = [];
  if (hasAudio) {
    if (Math.abs(edit.volume - 1) > 0.001) af.push(`volume=${fmt(edit.volume)}`);
    af.push(`aresample=${target.sampleRate}`);
    af.push(`aformat=sample_fmts=fltp:channel_layouts=${target.channels === 1 ? 'mono' : 'stereo'}`);
    parts.push(`[${inputIndex}:a:${order}]${af.join(',')}[apre]`);
  } else {
    parts.push(
      `anullsrc=channel_layout=${target.channels === 1 ? 'mono' : 'stereo'}:sample_rate=${target.sampleRate},atrim=duration=${fmt(Math.max(0.1, info.duration))}[apre]`,
    );
  }

  /* ── cuts ── */
  let v = '[vpre]';
  let a = '[apre]';
  if (needsTrim) {
    if (multi) {
      parts.push(`[vpre]split=${keep.length}${keep.map((_, i) => `[vs${i}]`).join('')}`);
      parts.push(`[apre]asplit=${keep.length}${keep.map((_, i) => `[as${i}]`).join('')}`);
      keep.forEach((k, i) => {
        parts.push(`[vs${i}]trim=start=${fmt(k.start)}:end=${fmt(k.end)},setpts=PTS-STARTPTS[vk${i}]`);
        parts.push(`[as${i}]atrim=start=${fmt(k.start)}:end=${fmt(k.end)},asetpts=PTS-STARTPTS[ak${i}]`);
      });
      parts.push(`${keep.map((_, i) => `[vk${i}][ak${i}]`).join('')}concat=n=${keep.length}:v=1:a=1[vcut][acut]`);
    } else {
      const k = keep[0];
      parts.push(`[vpre]trim=start=${fmt(k.start)}:end=${fmt(k.end)},setpts=PTS-STARTPTS[vcut]`);
      parts.push(`[apre]atrim=start=${fmt(k.start)}:end=${fmt(k.end)},asetpts=PTS-STARTPTS[acut]`);
    }
    v = '[vcut]';
    a = '[acut]';
  }

  /* ── speed, fit into frame, fps, fades ── */
  const vpost: string[] = [];
  if (Math.abs(speed - 1) > 1e-6) vpost.push(`setpts=PTS/${fmt(speed)}`);
  vpost.push(
    // square pixels first, so the aspect ratio is right whatever the source SAR
    `scale=trunc(iw*sar/2)*2:ih`,
    'setsar=1',
    `scale=${target.boxWidth}:${target.boxHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${target.boxWidth}:${target.boxHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
  );
  if (target.boxWidth !== target.width || target.boxHeight !== target.height) vpost.push(`scale=${target.width}:${target.height}:flags=lanczos`);
  vpost.push(`setsar=${target.sar}`, `fps=${target.fps}`, 'format=yuv420p');
  if (edit.fadeIn > 0) vpost.push(`fade=t=in:st=0:d=${fmt(Math.min(edit.fadeIn, duration / 2))}`);
  if (edit.fadeOut > 0) {
    const d = Math.min(edit.fadeOut, duration / 2);
    vpost.push(`fade=t=out:st=${fmt(Math.max(0, duration - d))}:d=${fmt(d)}`);
  }
  vpost.push(`trim=duration=${fmt(duration)}`);
  parts.push(`${v}${vpost.join(',')}[vout]`);

  const apost: string[] = [];
  apost.push(...atempoChain(speed));
  if (edit.normalizeAudio) apost.push('loudnorm=I=-16:TP=-1.5:LRA=11', `aresample=${target.sampleRate}`);
  if (edit.fadeIn > 0) apost.push(`afade=t=in:st=0:d=${fmt(Math.min(edit.fadeIn, duration / 2))}`);
  if (edit.fadeOut > 0) {
    const d = Math.min(edit.fadeOut, duration / 2);
    apost.push(`afade=t=out:st=${fmt(Math.max(0, duration - d))}:d=${fmt(d)}`);
  }
  // make audio exactly as long as the video so joined titles don't drift
  apost.push(`apad=whole_dur=${fmt(duration)}`, `atrim=duration=${fmt(duration)}`);
  parts.push(`${a}${apost.join(',')}[aout]`);

  return { filterComplex: parts.join(';'), videoLabel: '[vout]', audioLabel: '[aout]', duration };
}

/* ───────── disc frame targets ───────── */

export function dvdTarget(standard: 'pal' | 'ntsc', aspect: '16:9' | '4:3'): FrameTarget {
  const pal = standard === 'pal';
  const height = pal ? 576 : 480;
  const wide = aspect === '16:9';
  return {
    width: 720,
    height,
    boxWidth: wide ? (pal ? 1024 : 854) : pal ? 768 : 640,
    boxHeight: height,
    sar: wide ? (pal ? '64/45' : '32/27') : pal ? '16/15' : '8/9',
    fps: pal ? '25' : '30000/1001',
    sampleRate: 48000,
    channels: 2,
  };
}
