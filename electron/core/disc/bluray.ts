// Blu-ray helpers: pick a spec-valid frame format, build Blu-ray compliant
// x264 + AC-3 encoder arguments, and write the tsMuxeR .meta file.
import type { FrameTarget } from './editGraph';

export interface BlurayFormat {
  frame: FrameTarget;
  /** Rate passed to tsMuxeR (frames per second of the coded stream). */
  tsFps: string;
  keyint: number;
  /** 1080i: progressive frames coded as interlaced (x264 fake-interlaced). */
  fakeInterlaced: boolean;
  label: string;
}

const FILM = (fps: number) => Math.abs(fps - 23.976) < 0.05 || Math.abs(fps - 24) < 0.05;

/**
 * Blu-ray only allows 1080p at 23.976/24, 1080i at 25/29.97 and 720p at 23.976/24/50/59.94.
 * PAL material becomes 1080i25 (or 720p50), NTSC 1080i29.97 (or 720p59.94), film stays 24p.
 */
export function blurayFormat(standard: 'pal' | 'ntsc', resolution: '1080' | '720', sourceFps: number): BlurayFormat {
  const film = FILM(sourceFps);
  const is1080 = resolution === '1080';
  const base = { width: is1080 ? 1920 : 1280, height: is1080 ? 1080 : 720, boxWidth: is1080 ? 1920 : 1280, boxHeight: is1080 ? 1080 : 720, sar: '1', sampleRate: 48000, channels: 2 };
  if (film) {
    const exact24 = Math.abs(sourceFps - 24) < 0.01;
    const fps = exact24 ? '24' : '24000/1001';
    return { frame: { ...base, fps }, tsFps: exact24 ? '24' : '23.976', keyint: 24, fakeInterlaced: false, label: `${resolution}p${exact24 ? '24' : '23.976'}` };
  }
  if (standard === 'pal') {
    return is1080
      ? { frame: { ...base, fps: '25' }, tsFps: '25', keyint: 25, fakeInterlaced: true, label: '1080i25' }
      : { frame: { ...base, fps: '50' }, tsFps: '50', keyint: 50, fakeInterlaced: false, label: '720p50' };
  }
  return is1080
    ? { frame: { ...base, fps: '30000/1001' }, tsFps: '29.97', keyint: 30, fakeInterlaced: true, label: '1080i29.97' }
    : { frame: { ...base, fps: '60000/1001' }, tsFps: '59.94', keyint: 60, fakeInterlaced: false, label: '720p59.94' };
}

/** ffmpeg output arguments for one Blu-ray compliant H.264 elementary stream. */
export function blurayVideoArgs(fmt: BlurayFormat, videoKbps: number, out: string): string[] {
  const params = [
    'bluray-compat=1',
    `keyint=${fmt.keyint}`,
    'min-keyint=1',
    'bframes=3',
    'ref=4',
    'slices=4',
    'aud=1',
    'nal-hrd=vbr',
    'b-pyramid=strict',
    'open-gop=0',
    'colorprim=bt709',
    'transfer=bt709',
    'colormatrix=bt709',
    ...(fmt.fakeInterlaced ? ['fake-interlaced=1', 'pic-struct=1'] : []),
  ].join(':');
  return [
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
    '-b:v', `${Math.round(videoKbps)}k`, '-maxrate', '38000k', '-bufsize', '30000k',
    '-x264-params', params,
    '-f', 'h264', out,
  ];
}

export function blurayAudioArgs(out: string, kbps = 448): string[] {
  return ['-c:a', 'ac3', '-b:a', `${kbps}k`, '-ar', '48000', '-ac', '2', '-f', 'ac3', out];
}

export function tsTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

/** Chapter marks at every input start and every `interval` seconds inside each input. */
export function chapterTimes(durations: number[], interval: number): number[] {
  const out: number[] = [];
  let t = 0;
  for (const d of durations) {
    out.push(t);
    if (interval > 0) for (let k = interval; k < d - Math.min(30, interval / 4); k += interval) out.push(t + k);
    t += d;
  }
  return out;
}

export function blurayMeta(opts: { videos: string[]; audios: string[]; fmt: BlurayFormat; chapters: number[]; label: string; lang?: string }): string {
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const label = opts.label.replace(/["\r\n]/g, '').slice(0, 32) || 'BLURAY';
  const lang = opts.lang && /^[a-z]{3}$/.test(opts.lang) ? `, lang=${opts.lang}` : '';
  return [
    `MUXOPT --no-pcr-on-video-pid --new-audio-pes --blu-ray --vbr --vbv-len=500 --custom-chapters=${opts.chapters.map(tsTime).join(';')} --label="${label}"`,
    `V_MPEG4/ISO/AVC, ${opts.videos.map(q).join('+')}, fps=${opts.fmt.tsFps}, insertSEI, contSPS, ar=16:9`,
    `A_AC3, ${opts.audios.map(q).join('+')}${lang}`,
    '',
  ].join('\r\n');
}

/** tsMuxeR prints "12.3% complete" while muxing. */
export function parseTsMuxerProgress(line: string): number | null {
  const m = /([\d.]+)%\s*complete/i.exec(line);
  return m ? Math.min(1, Number(m[1]) / 100) : null;
}

export function discCapacity(size: 'dvd5' | 'dvd9' | 'bd25' | 'bd50'): number {
  switch (size) {
    case 'dvd9':
      return 8_500_000_000;
    case 'bd25':
      return 25_025_314_816;
    case 'bd50':
      return 50_050_629_632;
    default:
      return 4_700_000_000;
  }
}

/**
 * Video bitrate (kbps) that fills — but does not overflow — the disc.
 * `overhead` covers container/IFO/file-system overhead.
 */
export function fitVideoKbps(capacityBytes: number, totalSeconds: number, audioKbps: number, overhead: number, min: number, max: number): number {
  if (totalSeconds <= 0) return max;
  const kbps = (capacityBytes * (1 - overhead) * 8) / totalSeconds / 1000 - audioKbps;
  return Math.max(min, Math.min(max, Math.floor(kbps)));
}
