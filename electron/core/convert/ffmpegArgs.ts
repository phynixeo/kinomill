// Pure ffmpeg command builders (no I/O) for conversions, edits and joins.
//
// Conventions:
// - ffmpeg always runs with its working directory set to the job's temp folder,
//   so helper files (subtitles, watermark text/font, pass logs) are referenced by
//   short relative names and need no filter-path escaping.
// - Geometry: MediaInfo.video.width/height are the decoded (auto-rotated) frame
//   size. EditSpec.crop is in that pixel space (before user rotate/flip and
//   before anamorphic pixels are squared).
import type {
  AudioOutput,
  AudioStreamInfo,
  ConvertInput,
  Crop,
  FitMode,
  HwAccel,
  Interval,
  OutputSpec,
  SubtitleBurn,
  VideoOutput,
  Watermark,
} from '../../../shared/types';
import { AUDIO_CODECS, VIDEO_CODECS, getTarget } from '../../../shared/presets';
import { isEditDefault } from '../../../shared/defaults';

/* ───────────────────────── types ───────────────────────── */

export interface BuildEnv {
  /** Hardware encoders that passed the startup self-test, e.g. ['h264_nvenc']. */
  hwEncoders: string[];
  /** settings.hwAccel */
  hwPref: HwAccel;
  /** 'NUL' on Windows, '/dev/null' elsewhere (first pass of two-pass encodes). */
  nullDevice: string;
  /** Relative pass-log prefix (inside the job temp dir). */
  passLog: string;
}

export interface ResolvedInput extends ConvertInput {
  /** Crop to apply: manual crop or the auto-detected black-bar crop. */
  crop: Crop | null;
  /** Text subtitle file to burn, relative to ffmpeg's working dir (job temp dir). */
  subtitleFile?: string;
  /** Bitmap subtitle stream (order among subtitle streams) to overlay. */
  bitmapSubtitle?: number;
}

export interface WatermarkFiles {
  /** Relative name of a UTF-8 text file holding the watermark text. */
  textFile?: string;
  /** Relative name of a TTF font file. */
  fontFile?: string;
}

export interface FfmpegPass {
  args: string[];
  durationSec: number;
  stage: string;
}

export interface ConvertPlan {
  passes: FfmpegPass[];
  outputs: string[];
  /** Extra small text files to write after the passes (e.g. HTML5 snippet). */
  files: { path: string; content: string }[];
  durationSec: number;
  width?: number;
  height?: number;
  videoEncoder?: string;
  audioEncoder?: string;
  streamCopy: boolean;
}

/* ───────────────────────── small helpers ───────────────────────── */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const t3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

const STD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
/** Encoders that need constant frame rate with a small time base. */
const LEGACY_VCODECS = new Set(['mpeg4', 'xvid', 'wmv2', 'mpeg2', 'mpeg1', 'flv1', 'h263', 'theora']);
const H263_SIZES: [number, number][] = [
  [128, 96],
  [176, 144],
  [352, 288],
  [704, 576],
  [1408, 1152],
];
const BITMAP_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);

export function isBitmapSubtitle(codec: string): boolean {
  return BITMAP_SUB_CODECS.has(codec);
}

export function snapFps(fps: number): number {
  if (!fps || !Number.isFinite(fps)) return 25;
  return STD_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), STD_FPS[0]);
}

export function fpsExpr(fps: number): string {
  if (Math.abs(fps - 23.976) < 0.01) return '24000/1001';
  if (Math.abs(fps - 29.97) < 0.01) return '30000/1001';
  if (Math.abs(fps - 59.94) < 0.01) return '60000/1001';
  return t3(fps);
}

function parseSar(sar?: string): number {
  if (!sar) return 1;
  const [n, d] = sar.split(':').map(Number);
  if (!n || !d) return 1;
  return n / d;
}

/** "#RRGGBB" → ASS "&H00BBGGRR" */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const h = m ? m[1] : 'FFFFFF';
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function assForceStyle(s: SubtitleBurn): string {
  const font = (s.fontName || 'Arial').replace(/[^\w \-]/g, '').trim() || 'Arial';
  const align = s.position === 'top' ? 8 : s.position === 'middle' ? 5 : 2;
  return [
    `FontName=${font}`,
    `FontSize=${Math.round(clamp(s.fontSize || 22, 6, 200))}`,
    `PrimaryColour=${assColor(s.primaryColor || '#FFFFFF')}`,
    `OutlineColour=${assColor(s.outlineColor || '#000000')}`,
    'BorderStyle=1',
    `Outline=${clamp(s.outline ?? 1.5, 0, 10)}`,
    'Shadow=0',
    `Bold=${s.bold ? -1 : 0}`,
    `Alignment=${align}`,
    `MarginV=${Math.round(clamp(s.marginV ?? 20, 0, 500))}`,
  ].join(',');
}

/** Quote a short relative file name for use as a filter option value. */
function fval(name: string): string {
  return `'${name.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:')}'`;
}

/** Delete intervals → sorted, merged keep segments within [0, duration]. */
export function keepSegments(cuts: Interval[], duration: number): Interval[] {
  if (!(duration > 0)) return [{ start: 0, end: 0 }];
  const cs = cuts
    .map((c) => ({ start: clamp(Math.min(c.start, c.end), 0, duration), end: clamp(Math.max(c.start, c.end), 0, duration) }))
    .filter((c) => c.end - c.start > 0.01)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const c of cs) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.01) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  const keep: Interval[] = [];
  let cur = 0;
  for (const c of merged) {
    if (c.start > cur + 0.04) keep.push({ start: cur, end: c.start });
    cur = Math.max(cur, c.end);
  }
  if (duration > cur + 0.04) keep.push({ start: cur, end: duration });
  return keep;
}

export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let r = speed;
  while (r < 0.5) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  while (r > 100) {
    out.push('atempo=100');
    r /= 100;
  }
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${t3(r)}`);
  return out;
}

/* ───────────────────────── graph builder ───────────────────────── */

export class Graph {
  private parts: string[] = [];
  private n = 0;
  /** Add a filter (chain) with given inputs; returns its output labels. */
  add(inputs: string[], filter: string, outs = 1): string[] {
    const labels = Array.from({ length: outs }, () => `l${this.n++}`);
    this.parts.push(`${inputs.map((l) => `[${l}]`).join('')}${filter}${labels.map((l) => `[${l}]`).join('')}`);
    return labels;
  }
  chain(input: string, filters: string[]): string {
    if (!filters.length) return input;
    return this.add([input], filters.join(','))[0];
  }
  source(filter: string): string {
    return this.add([], filter)[0];
  }
  get empty(): boolean {
    return this.parts.length === 0;
  }
  toString(): string {
    return this.parts.join(';');
  }
}

/* ───────────────────────── encoders ───────────────────────── */

export type HwVendor = 'nvenc' | 'qsv' | 'amf';

export function pickVideoEncoder(codec: string, output: OutputSpec, env: BuildEnv): { encoder: string; hw?: HwVendor } {
  const info = VIDEO_CODECS[codec];
  if (!info) throw new Error(`Unknown video codec "${codec}"`);
  if (output.hwAccel && env.hwPref !== 'none' && info.hw) {
    const vendors: HwVendor[] = env.hwPref === 'auto' ? ['nvenc', 'qsv', 'amf'] : [env.hwPref as HwVendor];
    for (const v of vendors) {
      const enc = info.hw[v];
      if (enc && env.hwEncoders.includes(enc)) return { encoder: enc, hw: v };
    }
  }
  return { encoder: info.encoder };
}

const TWO_PASS_ENCODERS = new Set(['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'mpeg4', 'libxvid', 'mpeg2video', 'mpeg1video', 'wmv2', 'flv', 'h263', 'libtheora']);

/** 0..100 quality slider → encoder specific constant-quality value. */
export function qualityValue(encoder: string, q: number): number {
  const x264 = clamp(Math.round(51 - q * 0.4), 0, 51);
  switch (encoder) {
    case 'libx264':
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'h264_qsv':
    case 'hevc_qsv':
    case 'h264_amf':
    case 'hevc_amf':
      return x264;
    case 'libx265':
      return clamp(x264 + 4, 0, 51);
    case 'libsvtav1':
    case 'libvpx-vp9':
    case 'av1_nvenc':
    case 'av1_qsv':
    case 'av1_amf':
      return clamp(Math.round(63 - q * 0.45), 1, 63);
    case 'libvpx':
      return clamp(Math.round(63 - q * 0.5), 4, 63);
    case 'libtheora':
      return clamp(Math.round(q / 10), 0, 10);
    default:
      // qscale encoders: mpeg4, xvid, wmv2, mpeg1/2, flv, h263
      return clamp(Math.round(2 + (100 - q) * 0.25), 1, 31);
  }
}

interface VEncOpts {
  kbps?: number;
  pass?: 1 | 2;
  passLog: string;
  container: string;
  twoPassHw?: boolean;
  /** Ceiling (kbps) for constant-quality mode, so "same as source" never balloons a file. */
  capKbps?: number;
}

export function videoEncoderArgs(encoder: string, v: VideoOutput, o: VEncOpts): string[] {
  const a: string[] = ['-c:v', encoder];
  const q = v.quality ?? 70;
  const k = o.kbps;
  const rate = (mult = true) => (k ? ['-b:v', `${k}k`, ...(mult ? ['-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`] : [])] : []);
  const pass = o.pass ? ['-pass', String(o.pass), '-passlogfile', o.passLog] : [];
  const mp4ish = ['mp4', 'mov', 'm4v', '3gp'].includes(o.container);
  const cap = !k && o.capKbps ? ['-maxrate', `${o.capKbps}k`, '-bufsize', `${o.capKbps * 2}k`] : [];
  switch (encoder) {
    case 'libx264':
      a.push('-preset', 'medium', ...(k ? rate() : ['-crf', String(qualityValue(encoder, q)), ...cap]), ...pass, '-pix_fmt', 'yuv420p');
      break;
    case 'libx265': {
      const params = ['log-level=error'];
      if (o.pass) params.push(`pass=${o.pass}`, `stats=${o.passLog}.x265`);
      a.push('-preset', 'fast', ...(k ? ['-b:v', `${k}k`] : ['-crf', String(qualityValue(encoder, q)), ...cap]), '-x265-params', params.join(':'), '-pix_fmt', 'yuv420p');
      if (mp4ish) a.push('-tag:v', 'hvc1');
      break;
    }
    case 'libsvtav1':
      a.push('-preset', '8', ...(k ? ['-b:v', `${k}k`] : ['-crf', String(qualityValue(encoder, q))]), '-pix_fmt', 'yuv420p');
      break;
    case 'libvpx-vp9':
      a.push('-row-mt', '1', '-deadline', 'good', '-cpu-used', o.pass === 1 ? '4' : '2', ...(k ? ['-b:v', `${k}k`] : ['-crf', String(qualityValue(encoder, q)), '-b:v', '0']), ...pass, '-pix_fmt', 'yuv420p');
      break;
    case 'libvpx':
      a.push('-deadline', 'good', '-cpu-used', '2', ...(k ? ['-b:v', `${k}k`] : ['-crf', String(qualityValue(encoder, q)), '-b:v', '12M']), ...pass, '-pix_fmt', 'yuv420p');
      break;
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'av1_nvenc':
      a.push('-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...(k ? rate() : ['-cq', String(qualityValue(encoder, q)), '-b:v', '0', ...cap]));
      if (o.twoPassHw) a.push('-multipass', 'fullres');
      a.push('-pix_fmt', 'yuv420p');
      if (encoder === 'hevc_nvenc' && mp4ish) a.push('-tag:v', 'hvc1');
      break;
    case 'h264_qsv':
    case 'hevc_qsv':
    case 'av1_qsv':
      a.push('-preset', 'medium', ...(k ? rate() : ['-global_quality', String(qualityValue(encoder, q))]), '-pix_fmt', 'nv12');
      if (encoder === 'hevc_qsv' && mp4ish) a.push('-tag:v', 'hvc1');
      break;
    case 'h264_amf':
    case 'hevc_amf':
    case 'av1_amf': {
      const qp = String(qualityValue(encoder, q));
      a.push('-quality', 'balanced', ...(k ? ['-rc', 'vbr_peak', ...rate()] : ['-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(encoder === 'av1_amf' ? [] : ['-qp_b', qp])]), '-pix_fmt', 'yuv420p');
      if (encoder === 'hevc_amf' && mp4ish) a.push('-tag:v', 'hvc1');
      break;
    }
    case 'prores_ks':
      a.push('-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le');
      break;
    case 'libtheora':
      a.push(...(k ? ['-b:v', `${k}k`] : ['-q:v', String(qualityValue(encoder, q))]), ...pass, '-pix_fmt', 'yuv420p');
      break;
    case 'gif':
      break;
    default:
      // mpeg4, libxvid, wmv2, mpeg2video, mpeg1video, flv, h263
      a.push(...(k ? rate(encoder === 'mpeg2video' || encoder === 'mpeg1video') : ['-q:v', String(qualityValue(encoder, q))]), ...pass, '-pix_fmt', 'yuv420p');
      if ((encoder === 'mpeg4' || encoder === 'libxvid') && o.container === 'avi') a.push('-vtag', 'XVID');
      break;
  }
  return a;
}

export function defaultAudioKbps(codec: string, channels = 2, sampleRate = 48000): number {
  switch (codec) {
    case 'aac':
      return 160;
    case 'mp3':
      return 192;
    case 'opus':
      return 128;
    case 'vorbis':
      return 160;
    case 'wma':
      return 192;
    case 'ac3':
      return 448;
    case 'mp2':
      return 224;
    case 'amr':
      return 12.2;
    case 'flac':
    case 'alac':
      return Math.round((sampleRate * channels * 16 * 0.6) / 1000);
    case 'pcm':
    case 'pcm_be':
      return Math.round((sampleRate * channels * 16) / 1000);
    default:
      return 160;
  }
}

export function audioEncoderArgs(a: AudioOutput, src: AudioStreamInfo | undefined, container: string): string[] {
  const info = AUDIO_CODECS[a.codec];
  if (!info) throw new Error(`Unknown audio codec "${a.codec}"`);
  const out: string[] = ['-c:a', info.encoder];
  const br = a.bitrateKbps;
  const srcCh = src?.channels ?? 2;
  let ar = a.sampleRate;
  let ac = a.channels;
  switch (a.codec) {
    case 'aac':
    case 'mp3':
    case 'opus':
    case 'vorbis':
    case 'wma':
    case 'mp2':
      out.push('-b:a', `${br ?? defaultAudioKbps(a.codec)}k`);
      if (!ac && srcCh > 2 && a.codec !== 'aac' && a.codec !== 'vorbis') ac = 2;
      break;
    case 'ac3':
      out.push('-b:a', `${Math.min(640, br ?? 448)}k`);
      break;
    case 'amr':
      out.push('-b:a', '12.2k');
      ar = 8000;
      ac = 1;
      break;
    default:
      break; // lossless codecs: no bitrate
  }
  // Flash containers only accept 44.1/22.05/11.025 kHz MP3
  if ((container === 'flv' || container === 'swf') && a.codec === 'mp3' && (!ar || ![44100, 22050, 11025].includes(ar))) ar = 44100;
  if (ar) out.push('-ar', String(ar));
  if (ac) out.push('-ac', String(ac));
  return out;
}

function audioKbpsFor(a: AudioOutput | null, src?: AudioStreamInfo): number {
  if (!a) return 0;
  return a.bitrateKbps ?? defaultAudioKbps(a.codec, a.channels ?? Math.min(2, src?.channels ?? 2), a.sampleRate ?? src?.sampleRate ?? 48000);
}

export function containerArgs(container: string, vcodec?: string): string[] {
  const a: string[] = [];
  if (['mp4', 'mov', 'm4a', 'm4v', '3gp'].includes(container)) a.push('-movflags', '+faststart');
  if (container === 'mpg') a.push('-f', vcodec === 'mpeg1' ? 'mpeg' : 'vob');
  return a;
}

/* ───────────────────────── geometry ───────────────────────── */

export interface Dims {
  w: number;
  h: number;
}

/** Frame size after crop, square pixels and rotation (before scaling to the output size). */
export function editedGeometry(inp: ResolvedInput): Dims | null {
  const v = inp.info.video;
  if (!v || inp.info.isAudioOnly) return null;
  let w = v.width;
  let h = v.height;
  if (inp.crop) {
    w = inp.crop.w;
    h = inp.crop.h;
  }
  const sar = parseSar(v.sar);
  if (Math.abs(sar - 1) > 0.01) w = even(w * sar);
  if (inp.edit.rotate === 90 || inp.edit.rotate === 270) [w, h] = [h, w];
  return { w, h };
}

/**
 * Output frame size. `box` = fit into an exact WxH (pad/crop/stretch);
 * otherwise scale keeping aspect.
 */
export function outputDims(v: VideoOutput, cur: Dims, opts: { forceBox?: boolean } = {}): { dims: Dims; box: boolean } {
  if (v.codec === 'h263') {
    // H.263 only allows a few fixed sizes
    const want = v.width && v.height ? { w: v.width, h: v.height } : cur;
    const best = H263_SIZES.reduce((b, s) => (Math.abs(s[0] - want.w) + Math.abs(s[1] - want.h) < Math.abs(b[0] - want.w) + Math.abs(b[1] - want.h) ? s : b), H263_SIZES[2]);
    return { dims: { w: best[0], h: best[1] }, box: true };
  }
  if (v.width && v.height) {
    let W = v.width;
    let H = v.height;
    // portrait source + landscape preset (or vice versa): follow the source orientation
    if (W !== H && cur.w !== cur.h && W > H !== cur.w > cur.h) [W, H] = [H, W];
    return { dims: { w: even(W), h: even(H) }, box: true };
  }
  if (v.height) {
    const H = even(v.height);
    return { dims: { w: even((cur.w * H) / cur.h), h: H }, box: !!opts.forceBox };
  }
  if (v.width) {
    // width-only presets (GIF) bound the longer side
    const L = v.width;
    if (cur.h > cur.w) return { dims: { w: even((cur.w * L) / cur.h), h: even(L) }, box: !!opts.forceBox };
    return { dims: { w: even(L), h: even((cur.h * L) / cur.w) }, box: !!opts.forceBox };
  }
  return { dims: { w: even(cur.w), h: even(cur.h) }, box: !!opts.forceBox };
}

function fitFilters(cur: Dims, dims: Dims, fit: FitMode, box: boolean): string[] {
  const { w: W, h: H } = dims;
  if (cur.w === W && cur.h === H) return [];
  if (!box) return [`scale=${W}:${H}:flags=bicubic`, 'setsar=1'];
  switch (fit) {
    case 'crop':
      return [`scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=bicubic`, `crop=${W}:${H}`, 'setsar=1'];
    case 'stretch':
      return [`scale=${W}:${H}:flags=bicubic`, 'setsar=1'];
    default:
      return [
        `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
      ];
  }
}

/* ───────────────────────── per-input chains ───────────────────────── */

interface InputPlan {
  inp: ResolvedInput;
  index: number;
  segs: Interval[];
  speed: number;
  keepLen: number;
  outDur: number;
  /** Use fast input seeking (-ss/-t before -i) for a single kept segment. */
  seek: Interval | null;
  needsTrim: boolean;
}

function planInput(inp: ResolvedInput, index: number): InputPlan {
  const dur = inp.info.duration;
  const segs = keepSegments(inp.edit.cuts, dur);
  if (dur > 0 && !segs.length) throw new Error(`Nothing is left of "${inp.info.name}" after cutting.`);
  const speed = clamp(inp.edit.speed || 1, 0.25, 4);
  const keepLen = segs.reduce((s, x) => s + (x.end - x.start), 0);
  const whole = segs.length === 1 && segs[0].start < 0.001 && segs[0].end > dur - 0.001;
  const canSeek = segs.length === 1 && !whole && !inp.subtitleFile && inp.bitmapSubtitle === undefined;
  return {
    inp,
    index,
    segs,
    speed,
    keepLen,
    outDur: keepLen / speed,
    seek: canSeek ? segs[0] : null,
    needsTrim: !whole && !canSeek,
  };
}

interface ChainOpts {
  dims: Dims;
  box: boolean;
  fit: FitMode;
  fps?: number;
  normalize: boolean; // join: force setsar/format
}

function videoChain(g: Graph, p: InputPlan, o: ChainOpts): string {
  const { inp } = p;
  const e = inp.edit;
  const v = inp.info.video;
  if (!v || inp.info.isAudioOnly) {
    return g.source(`color=c=black:s=${o.dims.w}x${o.dims.h}:r=${fpsExpr(o.fps ?? 30)}:d=${t3(Math.max(0.04, p.outDur))},format=yuv420p,setsar=1`);
  }
  let cur = `${p.index}:v:0`;
  let pre: string[] = [];
  if (e.deinterlace) pre.push('bwdif');
  if (inp.bitmapSubtitle !== undefined) {
    cur = g.chain(cur, pre);
    pre = [];
    cur = g.add([cur, `${p.index}:s:${inp.bitmapSubtitle}`], 'overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h')[0];
  }
  if (inp.crop) {
    const c = inp.crop;
    const cw = even(clamp(c.w, 2, v.width));
    const ch = even(clamp(c.h, 2, v.height));
    const cx = clamp(Math.round(c.x), 0, v.width - cw);
    const cy = clamp(Math.round(c.y), 0, v.height - ch);
    pre.push(`crop=${cw}:${ch}:${cx}:${cy}`);
  }
  if (Math.abs(parseSar(v.sar) - 1) > 0.01) pre.push('scale=trunc(iw*sar/2)*2:ih', 'setsar=1');
  if (e.rotate === 90) pre.push('transpose=clock');
  else if (e.rotate === 270) pre.push('transpose=cclock');
  else if (e.rotate === 180) pre.push('hflip', 'vflip');
  if (e.flipH) pre.push('hflip');
  if (e.flipV) pre.push('vflip');
  if (inp.subtitleFile) {
    const style = e.subtitles ? `:force_style='${assForceStyle(e.subtitles)}'` : '';
    pre.push(`subtitles=filename=${fval(inp.subtitleFile)}${style}`);
  }
  cur = g.chain(cur, pre);

  if (p.needsTrim) {
    if (p.segs.length === 1) {
      cur = g.chain(cur, [`trim=start=${t3(p.segs[0].start)}:end=${t3(p.segs[0].end)}`, 'setpts=PTS-STARTPTS']);
    } else {
      const outs = g.add([cur], `split=${p.segs.length}`, p.segs.length);
      const parts = outs.map((l, k) => g.chain(l, [`trim=start=${t3(p.segs[k].start)}:end=${t3(p.segs[k].end)}`, 'setpts=PTS-STARTPTS']));
      cur = g.add(parts, `concat=n=${parts.length}:v=1:a=0`)[0];
    }
  }

  const post: string[] = [];
  if (p.speed !== 1) post.push(`setpts=(PTS-STARTPTS)/${t3(p.speed)}`);
  if (e.brightness || e.contrast || e.saturation) {
    post.push(`eq=brightness=${t3(clamp(e.brightness, -1, 1) * 0.5)}:contrast=${t3(1 + clamp(e.contrast, -1, 1))}:saturation=${t3(1 + clamp(e.saturation, -1, 1))}`);
  }
  if (o.fps) post.push(`fps=${fpsExpr(o.fps)}`);
  const geom = editedGeometry(inp)!;
  post.push(...fitFilters(geom, o.dims, o.fit, o.box));
  if (e.fadeIn > 0) post.push(`fade=t=in:st=0:d=${t3(Math.min(e.fadeIn, p.outDur))}`);
  if (e.fadeOut > 0) post.push(`fade=t=out:st=${t3(Math.max(0, p.outDur - e.fadeOut))}:d=${t3(Math.min(e.fadeOut, p.outDur))}`);
  if (o.normalize) post.push('setsar=1', 'format=yuv420p');
  return g.chain(cur, post);
}

function selectedTrack(inp: ResolvedInput): AudioStreamInfo | undefined {
  const t = inp.edit.audioTrack;
  if (t < 0) return undefined;
  return inp.info.audioTracks[t] ?? inp.info.audioTracks[0];
}

interface AChainOpts {
  silenceIfNone: boolean;
  normalizeTo?: { rate: number; layout: string };
}

function audioChain(g: Graph, p: InputPlan, o: AChainOpts): string | null {
  const { inp } = p;
  const e = inp.edit;
  const track = selectedTrack(inp);
  if (!track) {
    if (!o.silenceIfNone) return null;
    const n = o.normalizeTo ?? { rate: 48000, layout: 'stereo' };
    return g.source(`anullsrc=r=${n.rate}:cl=${n.layout},atrim=duration=${t3(Math.max(0.04, p.outDur))}`);
  }
  let cur = `${p.index}:a:${track.order}`;
  if (p.needsTrim) {
    if (p.segs.length === 1) {
      cur = g.chain(cur, [`atrim=start=${t3(p.segs[0].start)}:end=${t3(p.segs[0].end)}`, 'asetpts=PTS-STARTPTS']);
    } else {
      const outs = g.add([cur], `asplit=${p.segs.length}`, p.segs.length);
      const parts = outs.map((l, k) => g.chain(l, [`atrim=start=${t3(p.segs[k].start)}:end=${t3(p.segs[k].end)}`, 'asetpts=PTS-STARTPTS']));
      cur = g.add(parts, `concat=n=${parts.length}:v=0:a=1`)[0];
    }
  }
  const post: string[] = [];
  if (p.speed !== 1) post.push(...atempoChain(p.speed));
  if (e.volume !== 1 && e.volume >= 0) post.push(`volume=${t3(e.volume)}`);
  if (e.normalizeAudio) post.push('loudnorm=I=-16:TP=-1.5:LRA=11', `aresample=${o.normalizeTo?.rate ?? track.sampleRate ?? 48000}`);
  if (e.fadeIn > 0) post.push(`afade=t=in:st=0:d=${t3(Math.min(e.fadeIn, p.outDur))}`);
  if (e.fadeOut > 0) post.push(`afade=t=out:st=${t3(Math.max(0, p.outDur - e.fadeOut))}:d=${t3(Math.min(e.fadeOut, p.outDur))}`);
  if (o.normalizeTo) post.push(`aresample=${o.normalizeTo.rate}`, `aformat=sample_fmts=fltp:channel_layouts=${o.normalizeTo.layout}`);
  return g.chain(cur, post);
}

/* ───────────────────────── watermark + gif ───────────────────────── */

export function watermarkFilters(
  g: Graph,
  cur: string,
  wm: Watermark,
  dims: Dims,
  files: WatermarkFiles,
  imageInputIndex: number | undefined,
): string {
  const m = Math.round(clamp(wm.margin ?? 16, 0, 2000));
  const op = clamp(wm.opacity ?? 0.7, 0.05, 1);
  if (wm.type === 'text') {
    if (!files.textFile || !files.fontFile) return cur;
    const size = Math.max(8, Math.round(dims.h * clamp(wm.scale || 0.05, 0.01, 0.3)));
    const color = (wm.color || '#FFFFFF').replace('#', '');
    const pos: Record<Watermark['position'], [string, string]> = {
      tl: [`${m}`, `${m}`],
      tr: [`w-tw-${m}`, `${m}`],
      bl: [`${m}`, `h-th-${m}`],
      br: [`w-tw-${m}`, `h-th-${m}`],
      center: ['(w-tw)/2', '(h-th)/2'],
    };
    const [x, y] = pos[wm.position] ?? pos.br;
    return g.chain(cur, [
      `drawtext=fontfile=${fval(files.fontFile)}:textfile=${fval(files.textFile)}:expansion=none:fontsize=${size}:fontcolor=0x${color}@${t3(op)}:shadowcolor=black@${t3(op * 0.6)}:shadowx=2:shadowy=2:x=${x}:y=${y}`,
    ]);
  }
  if (imageInputIndex === undefined) return cur;
  const ww = even(dims.w * clamp(wm.scale || 0.15, 0.02, 0.9));
  const pos: Record<Watermark['position'], [string, string]> = {
    tl: [`${m}`, `${m}`],
    tr: [`main_w-overlay_w-${m}`, `${m}`],
    bl: [`${m}`, `main_h-overlay_h-${m}`],
    br: [`main_w-overlay_w-${m}`, `main_h-overlay_h-${m}`],
    center: ['(main_w-overlay_w)/2', '(main_h-overlay_h)/2'],
  };
  const [x, y] = pos[wm.position] ?? pos.br;
  const logo = g.chain(`${imageInputIndex}:v:0`, [`scale=${ww}:-1`, 'format=rgba', `colorchannelmixer=aa=${t3(op)}`]);
  return g.add([cur, logo], `overlay=x=${x}:y=${y}:format=auto`)[0];
}

export function gifPalette(g: Graph, cur: string): string {
  const [a, b] = g.add([cur], 'split', 2);
  const [pal] = g.add([a], 'palettegen=stats_mode=diff:max_colors=256');
  return g.add([b, pal], 'paletteuse=dither=sierra2_4a:diff_mode=rectangle')[0];
}

/* ───────────────────────── stream copy ───────────────────────── */

const PROBE_TO_VCODEC: Record<string, string[]> = {
  h264: ['h264'],
  hevc: ['hevc'],
  av1: ['av1'],
  vp9: ['vp9'],
  vp8: ['vp8'],
  mpeg4: ['mpeg4', 'xvid'],
  mpeg2video: ['mpeg2'],
  mpeg1video: ['mpeg1'],
  wmv2: ['wmv2'],
  flv1: ['flv1'],
  h263: ['h263'],
  prores: ['prores'],
  theora: ['theora'],
};
const PROBE_TO_ACODEC: Record<string, string> = {
  aac: 'aac',
  mp3: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  pcm_s16le: 'pcm',
  pcm_s16be: 'pcm_be',
  alac: 'alac',
  wmav2: 'wma',
  ac3: 'ac3',
  mp2: 'mp2',
  amr_nb: 'amr',
};

/** Which streams can be copied without re-encoding (null = full re-encode needed). */
export function streamCopyDecision(inputs: ResolvedInput[], output: OutputSpec): { video: boolean; audio: boolean } | null {
  if (!output.allowStreamCopy || inputs.length !== 1) return null;
  const target = getTarget(output.targetId);
  if (target?.special) return null;
  const inp = inputs[0];
  if (!isEditDefault(inp.edit) || inp.crop || inp.subtitleFile || inp.bitmapSubtitle !== undefined) return null;
  if (output.watermark || output.targetSizeMB) return null;
  const info = inp.info;
  if (info.isImage) return null;

  let video = false;
  if (output.video) {
    const v = output.video;
    if (!info.video || info.isAudioOnly) return null;
    if (v.width || v.height || v.fps || v.bitrateKbps || v.twoPass) return null;
    if (!(PROBE_TO_VCODEC[info.video.codec] ?? []).includes(v.codec)) return null;
    if (target && !target.videoCodecs.includes(v.codec)) return null;
    if (info.video.rotation) return null; // keep it simple: rotated phone videos get re-encoded upright
    video = true;
  }
  let audio = false;
  const track = selectedTrack(inp);
  if (output.audio && track) {
    const a = output.audio;
    const same = PROBE_TO_ACODEC[track.codec] === a.codec;
    const rateOk = !a.sampleRate || a.sampleRate === track.sampleRate;
    const chOk = !a.channels || a.channels === track.channels;
    const brOk = !a.bitrateKbps || !track.bitrate || track.bitrate / 1000 <= a.bitrateKbps * 1.1;
    audio = same && rateOk && chOk && brOk;
  }
  if (output.video && !video) return null; // video must be copied for a "copy" plan to be worthwhile
  if (!output.video && !audio) return null;
  return { video, audio };
}

/* ───────────────────────── main builder ───────────────────────── */

export interface BuildParams {
  inputs: ResolvedInput[];
  output: OutputSpec;
  /** Full output path; for HTML5 this is the .mp4 path (siblings get .webm/.ogv/.html). */
  outPath: string;
  env: BuildEnv;
  wm?: WatermarkFiles;
}

export function buildConvertPlan(p: BuildParams): ConvertPlan {
  const target = getTarget(p.output.targetId);
  if (target?.special === 'dvd' || target?.special === 'bluray') {
    throw new Error(`"to ${target.label}" is created with the disc tools, not the regular converter.`);
  }
  if (!p.inputs.length) throw new Error('No files to convert');
  for (const i of p.inputs) if (i.info.isImage) throw new Error(`"${i.info.name}" is a photo — use Photo slideshow to turn photos into a video.`);
  if (target?.special === 'html5') return buildHtml5(p);
  return buildSingle(p);
}

function replaceExt(file: string, ext: string): string {
  return file.replace(/\.[^.\\/]+$/, '') + '.' + ext;
}

function buildHtml5(p: BuildParams): ConvertPlan {
  const v = p.output.video ?? { codec: 'h264', fit: 'pad' as FitMode, quality: 70 };
  const q = v.quality ?? 70;
  const base = p.outPath.replace(/\.[^.\\/]+$/, '');
  const name = base.split(/[\\/]/).pop() ?? 'video';
  const mk = (container: string, video: VideoOutput, audio: AudioOutput): BuildParams => ({
    ...p,
    output: { ...p.output, targetId: container === 'mp4' ? 'mp4' : container === 'webm' ? 'webm' : 'ogv', container, video, audio, targetSizeMB: undefined },
    outPath: `${base}.${container}`,
  });
  const mp4 = buildSingle(mk('mp4', { ...v, codec: 'h264', twoPass: false }, { codec: 'aac', bitrateKbps: p.output.audio?.bitrateKbps ?? 128 }));
  const webm = buildSingle(mk('webm', { ...v, codec: 'vp9', bitrateKbps: undefined, quality: q, twoPass: false }, { codec: 'opus', bitrateKbps: 128 }));
  const ogv = buildSingle(mk('ogv', { ...v, codec: 'theora', bitrateKbps: undefined, quality: q, twoPass: false }, { codec: 'vorbis', bitrateKbps: 128 }));
  const label = ['MP4', 'WebM', 'OGV'];
  const passes = [mp4, webm, ogv].flatMap((pl, i) => pl.passes.map((ps) => ({ ...ps, stage: `Creating ${label[i]} (${i + 1}/3)` })));
  const W = mp4.width ?? 1280;
  const H = mp4.height ?? 720;
  const html = [
    '<!-- HTML5 video created with Kinomill. Upload all three video files next to your page. -->',
    `<video controls preload="metadata" width="${W}" height="${H}" style="max-width:100%;height:auto">`,
    `  <source src="${name}.mp4" type="video/mp4">`,
    `  <source src="${name}.webm" type="video/webm">`,
    `  <source src="${name}.ogv" type="video/ogg">`,
    `  Your browser does not support HTML5 video. <a href="${name}.mp4">Download the video</a>.`,
    '</video>',
    '',
  ].join('\n');
  return {
    passes,
    outputs: [`${base}.mp4`, `${base}.webm`, `${base}.ogv`, `${base}.html`],
    files: [{ path: `${base}.html`, content: html }],
    durationSec: mp4.durationSec,
    width: W,
    height: H,
    videoEncoder: mp4.videoEncoder,
    audioEncoder: mp4.audioEncoder,
    streamCopy: false,
  };
}

function buildSingle(p: BuildParams): ConvertPlan {
  const { inputs, output, env } = p;
  const container = output.container;
  const plans = inputs.map((inp, i) => planInput(inp, i));
  const totalDur = plans.reduce((s, x) => s + x.outDur, 0);
  const join = inputs.length > 1;

  /* ── fast path: remux ── */
  const copy = streamCopyDecision(inputs, output);
  if (copy) {
    const inp = inputs[0];
    const track = selectedTrack(inp);
    const args: string[] = ['-i', inp.path];
    if (copy.video) args.push('-map', '0:v:0');
    if (output.audio && track) args.push('-map', `0:a:${track.order}`);
    if (copy.video) args.push('-c:v', 'copy');
    else args.push('-vn');
    if (output.audio && track) args.push(...(copy.audio ? ['-c:a', 'copy'] : audioEncoderArgs(output.audio, track, container)));
    else args.push('-an');
    if (copy.video && (output.video?.codec === 'hevc') && ['mp4', 'mov'].includes(container)) args.push('-tag:v', 'hvc1');
    args.push('-map_metadata', '0', '-map_chapters', '0', ...containerArgs(container, output.video?.codec), p.outPath);
    return {
      passes: [{ args, durationSec: totalDur, stage: copy.audio ? 'Copying (no re-encoding)' : 'Converting audio' }],
      outputs: [p.outPath],
      files: [],
      durationSec: totalDur,
      width: inp.info.video?.width,
      height: inp.info.video?.height,
      streamCopy: true,
    };
  }

  const anyVideo = inputs.some((i) => i.info.video && !i.info.isAudioOnly);
  const anyAudio = inputs.some((i) => selectedTrack(i));
  const wantVideo = !!output.video;
  const wantAudio = !!output.audio && (anyAudio || join);
  if (wantVideo && !anyVideo && !output.audio) throw new Error('These files have no video to convert.');
  if (!wantVideo && !anyAudio) throw new Error(inputs.length === 1 ? `"${inputs[0].info.name}" has no audio track to convert.` : 'These files have no audio.');
  if (!wantVideo && !output.audio) throw new Error('The output has neither video nor audio.');

  const g = new Graph();
  const inArgs: string[] = [];
  for (const pl of plans) {
    if (pl.seek) inArgs.push('-ss', t3(pl.seek.start), '-t', t3(pl.seek.end - pl.seek.start));
    inArgs.push('-i', pl.inp.path);
  }

  const vcodec = output.video?.codec;
  const isGif = vcodec === 'gif';
  const legacy = !!vcodec && LEGACY_VCODECS.has(vcodec);

  /* ── geometry & frame rate ── */
  const firstGeom = plans.map((x) => editedGeometry(x.inp)).find(Boolean) ?? { w: 1280, h: 720 };
  let dims: Dims = firstGeom;
  let box = false;
  let fps: number | undefined;
  if (output.video) {
    const r = outputDims(output.video, firstGeom, { forceBox: join });
    dims = r.dims;
    box = r.box || join;
    const srcFps = inputs.find((i) => i.info.video?.fps)?.info.video?.fps;
    fps = output.video.fps;
    if (!fps && (join || legacy || !anyVideo)) fps = srcFps && srcFps <= 120 ? srcFps : 30;
    if (fps && legacy) fps = snapFps(fps);
  }

  /* ── audio normalization for joins ── */
  const layout = output.audio?.channels === 1 ? 'mono' : output.audio?.channels === 6 ? '5.1' : 'stereo';
  const normalizeTo = join ? { rate: output.audio?.sampleRate ?? 48000, layout } : undefined;

  const vLabels: string[] = [];
  const aLabels: string[] = [];
  for (const pl of plans) {
    if (wantVideo) {
      // single-input: each input fits on its own geometry unless a box size is requested
      const own = editedGeometry(pl.inp);
      const o = join || !own ? { dims, box: true } : { dims, box };
      vLabels.push(videoChain(g, pl, { dims: o.dims, box: o.box, fit: output.video!.fit ?? 'pad', fps, normalize: join }));
    }
    if (wantAudio) {
      const a = audioChain(g, pl, { silenceIfNone: join, normalizeTo });
      if (a) aLabels.push(a);
    }
  }

  let vOut: string | undefined;
  let aOut: string | undefined;
  if (join) {
    if (wantVideo && wantAudio) {
      const inter = vLabels.flatMap((v, i) => [v, aLabels[i]]);
      [vOut, aOut] = g.add(inter, `concat=n=${plans.length}:v=1:a=1`, 2);
    } else if (wantVideo) {
      [vOut] = g.add(vLabels, `concat=n=${plans.length}:v=1:a=0`);
    } else {
      [aOut] = g.add(aLabels, `concat=n=${plans.length}:v=0:a=1`);
    }
  } else {
    vOut = vLabels[0];
    aOut = aLabels[0];
  }

  /* ── global video post-processing ── */
  let imageIdx: number | undefined;
  if (vOut && output.watermark) {
    if (output.watermark.type === 'image' && output.watermark.imagePath) {
      imageIdx = plans.length;
      inArgs.push('-i', output.watermark.imagePath);
    }
    vOut = watermarkFilters(g, vOut, output.watermark, dims, p.wm ?? {}, imageIdx);
  }
  if (vOut && isGif) vOut = gifPalette(g, vOut);

  /* ── encoders ── */
  const track0 = inputs.map(selectedTrack).find(Boolean);
  let venc: { encoder: string; hw?: HwVendor } | undefined;
  let kbps = output.video?.bitrateKbps;
  let twoPass = false;
  if (output.video && vOut) {
    venc = isGif ? { encoder: 'gif' } : pickVideoEncoder(output.video.codec, output, env);
    if (output.targetSizeMB && output.targetSizeMB > 0 && totalDur > 0 && !isGif) {
      const totalKbit = (output.targetSizeMB * 8 * 1024 * 1024) / 1000;
      const aK = aOut ? audioKbpsFor(output.audio, track0) : 0;
      kbps = Math.max(64, Math.floor((totalKbit / totalDur) * 0.97 - aK));
    }
    twoPass = !!kbps && (!!output.video.twoPass || !!output.targetSizeMB) && !venc.hw && TWO_PASS_ENCODERS.has(venc.encoder);
  }
  const hwTwoPass = !!venc?.hw && venc.encoder.endsWith('_nvenc') && !!kbps && (!!output.video?.twoPass || !!output.targetSizeMB);
  // "Same as source": cap constant-quality output at ~1.25× the source video bitrate (single, unscaled input only)
  let capKbps: number | undefined;
  const src = inputs.length === 1 ? inputs[0].info : undefined;
  const srcBps = src?.video?.bitrate ?? (src?.bitrate ? src.bitrate - (src.audioTracks[0]?.bitrate ?? 128000) : undefined);
  if (!join && output.presetId === 'source' && !output.video?.width && !output.video?.height && srcBps && srcBps > 0) {
    capKbps = Math.max(300, Math.round((srcBps / 1000) * 1.25));
  }

  const graphArgs = g.empty ? [] : ['-filter_complex', g.toString()];
  // raw input streams (no filters applied) are mapped as "0:a:1", filter outputs as "[l3]"
  const ref = (l: string) => (/^\d+:/.test(l) ? l : `[${l}]`);
  const mapArgs = (withAudio: boolean) => [...(vOut ? ['-map', ref(vOut)] : ['-vn']), ...(withAudio && aOut ? ['-map', ref(aOut)] : ['-an'])];
  const meta = join || plans.some((x) => x.segs.length > 1 || x.needsTrim || x.seek) ? ['-map_metadata', '0', '-map_chapters', '-1'] : ['-map_metadata', '0'];
  const encV = (pass?: 1 | 2) => (vOut && venc && output.video ? videoEncoderArgs(venc.encoder, output.video, { kbps, pass, passLog: env.passLog, container, twoPassHw: hwTwoPass, capKbps }) : []);
  const encA = aOut && output.audio ? audioEncoderArgs(output.audio, join ? { ...(track0 as AudioStreamInfo), channels: layout === 'mono' ? 1 : layout === '5.1' ? 6 : 2 } : track0, container) : [];
  const tail = [...containerArgs(container, vcodec), ...(isGif ? ['-loop', '0'] : []), '-max_muxing_queue_size', '4096'];

  const passes: FfmpegPass[] = [];
  if (twoPass) {
    passes.push({
      args: [...inArgs, ...graphArgs, ...mapArgs(false), ...encV(1), '-f', 'null', env.nullDevice],
      durationSec: totalDur,
      stage: 'Analyzing (pass 1 of 2)',
    });
    passes.push({ args: [...inArgs, ...graphArgs, ...mapArgs(true), ...encV(2), ...encA, ...meta, ...tail, p.outPath], durationSec: totalDur, stage: 'Encoding (pass 2 of 2)' });
  } else {
    passes.push({ args: [...inArgs, ...graphArgs, ...mapArgs(true), ...encV(), ...encA, ...meta, ...tail, p.outPath], durationSec: totalDur, stage: join ? 'Joining' : 'Converting' });
  }

  return {
    passes,
    outputs: [p.outPath],
    files: [],
    durationSec: totalDur,
    width: vOut ? dims.w : undefined,
    height: vOut ? dims.h : undefined,
    videoEncoder: venc?.encoder,
    audioEncoder: encA[1],
    streamCopy: false,
  };
}

/* ───────────────────────── size estimate ───────────────────────── */

const BPP: Record<string, number> = {
  h264: 0.08,
  hevc: 0.05,
  av1: 0.04,
  vp9: 0.05,
  vp8: 0.09,
  mpeg4: 0.14,
  xvid: 0.13,
  wmv2: 0.16,
  mpeg2: 0.2,
  mpeg1: 0.25,
  flv1: 0.2,
  h263: 0.2,
  theora: 0.12,
  prores: 2.4,
  gif: 1.2,
};

/** Rough output size in bytes (exact when a bitrate or target size is set). */
export function estimateOutputBytes(inputs: ConvertInput[], join: boolean, output: OutputSpec): number {
  const resolved: ResolvedInput[] = inputs.map((i) => ({ ...i, crop: i.edit.crop }));
  const each = join ? [resolved] : resolved.map((r) => [r]);
  let total = 0;
  for (const group of each) {
    const plans = group.map((g, i) => planInput(g, i));
    const dur = plans.reduce((s, x) => s + x.outDur, 0);
    if (output.targetSizeMB && output.video) {
      total += output.targetSizeMB * 1024 * 1024;
      continue;
    }
    const copy = streamCopyDecision(group, output);
    if (copy && copy.video && copy.audio) {
      total += group[0].info.size;
      continue;
    }
    const track = group.map(selectedTrack).find(Boolean);
    let kbps = output.audio && track ? audioKbpsFor(output.audio, track) : 0;
    if (output.video) {
      const geom = group.map(editedGeometry).find(Boolean) ?? { w: 1280, h: 720 };
      const { dims } = outputDims(output.video, geom, { forceBox: join });
      const fps = output.video.fps || group[0].info.video?.fps || 30;
      if (output.video.bitrateKbps) kbps += output.video.bitrateKbps;
      else {
        const q = output.video.quality ?? 70;
        const bpp = (BPP[output.video.codec] ?? 0.1) * Math.pow(2, (q - 70) / 12);
        kbps += (dims.w * dims.h * Math.min(fps, 60) * bpp) / 1000;
      }
    }
    total += (kbps * 1000 * dur) / 8;
  }
  return Math.round(total * 1.01);
}
