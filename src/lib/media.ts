import type { ConvertInput, EditSpec, MediaInfo } from '../../shared/types';
import { getState } from './store';
import { formatDuration } from './format';

export function frameUrl(path: string, t: number, w = 320): string {
  const base = getState().app?.mediaBase ?? '';
  return `${base}/frame?path=${encodeURIComponent(path)}&t=${Math.max(0, t).toFixed(2)}&w=${w}`;
}

/** Live preview stream (converted on the fly) for formats the built-in player can't decode. */
export function liveUrl(path: string, start: number, audioTrack: number, kind: 'video' | 'audio'): string {
  const base = getState().app?.mediaBase ?? '';
  return `${base}/live?path=${encodeURIComponent(path)}&start=${Math.max(0, start).toFixed(3)}&audio=${audioTrack}&kind=${kind}`;
}

export function mediaUrl(path: string): string {
  const base = getState().app?.mediaBase ?? '';
  return `${base}/media?path=${encodeURIComponent(path)}`;
}

/** Duration after cuts and speed change. */
export function editedDuration(info: MediaInfo, edit: EditSpec): number {
  const removed = edit.cuts.reduce((n, c) => n + Math.max(0, Math.min(c.end, info.duration) - Math.max(0, c.start)), 0);
  return Math.max(0, info.duration - removed) / (edit.speed || 1);
}

export function describeMedia(info: MediaInfo): string {
  const parts: string[] = [];
  if (info.duration) parts.push(formatDuration(info.duration));
  if (info.video) parts.push(`${info.video.width}×${info.video.height}`, info.video.codec.toUpperCase());
  if (info.video?.fps) parts.push(`${Math.round(info.video.fps * 100) / 100} fps`);
  const a = info.audioTracks[0];
  if (a) parts.push(`${a.codec.toUpperCase()} ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : a.channels + 'ch'}`);
  return parts.join(' · ');
}

export function editBadges(info: MediaInfo, e: EditSpec): string[] {
  const b: string[] = [];
  if (e.cuts.length) b.push(`Cut ${e.cuts.length} part${e.cuts.length > 1 ? 's' : ''}`);
  if (e.rotate) b.push(`Rotated ${e.rotate}°`);
  if (e.flipH || e.flipV) b.push('Flipped');
  if (e.crop) b.push('Cropped');
  if (e.autoRemoveBlackBars) b.push('No black bars');
  if (e.subtitles) b.push('Subtitles');
  if (e.speed !== 1) b.push(`${e.speed}× speed`);
  if (e.volume !== 1) b.push(`Volume ${Math.round(e.volume * 100)}%`);
  if (e.normalizeAudio) b.push('Normalized');
  if (e.audioTrack === -1 && info.audioTracks.length) b.push('Muted');
  if (e.fadeIn || e.fadeOut) b.push('Fades');
  if (e.brightness || e.contrast || e.saturation) b.push('Color');
  if (e.deinterlace) b.push('Deinterlaced');
  return b;
}

export function toInputs(items: { info: MediaInfo; edit: EditSpec }[]): ConvertInput[] {
  return items.map((i) => ({ path: i.info.path, info: i.info, edit: i.edit }));
}
