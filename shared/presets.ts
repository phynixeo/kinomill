// Output targets ("to MP4", "to AVI", "to iPhone" …) and their quality presets.
// Used by the converter UI and by the ffmpeg command builder.
import type { AudioOutput, VideoOutput } from './types';

export interface CodecInfo {
  id: string;
  label: string;
  /** Software ffmpeg encoder. */
  encoder: string;
  /** Hardware encoders by vendor, used when hardware acceleration is enabled and available. */
  hw?: Partial<Record<'nvenc' | 'qsv' | 'amf', string>>;
  /** Supports constant-quality (crf / qscale) mode. */
  crf?: boolean;
}

export const VIDEO_CODECS: Record<string, CodecInfo> = {
  h264: { id: 'h264', label: 'H.264 / AVC', encoder: 'libx264', hw: { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' }, crf: true },
  hevc: { id: 'hevc', label: 'H.265 / HEVC', encoder: 'libx265', hw: { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf' }, crf: true },
  av1: { id: 'av1', label: 'AV1', encoder: 'libsvtav1', hw: { nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf' }, crf: true },
  vp9: { id: 'vp9', label: 'VP9', encoder: 'libvpx-vp9', crf: true },
  vp8: { id: 'vp8', label: 'VP8', encoder: 'libvpx', crf: true },
  mpeg4: { id: 'mpeg4', label: 'MPEG-4 Part 2', encoder: 'mpeg4', crf: true },
  xvid: { id: 'xvid', label: 'Xvid', encoder: 'libxvid', crf: true },
  wmv2: { id: 'wmv2', label: 'WMV 8 (WMV2)', encoder: 'wmv2', crf: true },
  mpeg2: { id: 'mpeg2', label: 'MPEG-2', encoder: 'mpeg2video', crf: true },
  mpeg1: { id: 'mpeg1', label: 'MPEG-1', encoder: 'mpeg1video', crf: true },
  flv1: { id: 'flv1', label: 'Sorenson Spark (FLV1)', encoder: 'flv', crf: true },
  h263: { id: 'h263', label: 'H.263', encoder: 'h263', crf: true },
  prores: { id: 'prores', label: 'Apple ProRes 422', encoder: 'prores_ks' },
  theora: { id: 'theora', label: 'Theora', encoder: 'libtheora', crf: true },
  gif: { id: 'gif', label: 'GIF', encoder: 'gif' },
};

export const AUDIO_CODECS: Record<string, CodecInfo> = {
  aac: { id: 'aac', label: 'AAC', encoder: 'aac' },
  mp3: { id: 'mp3', label: 'MP3', encoder: 'libmp3lame' },
  opus: { id: 'opus', label: 'Opus', encoder: 'libopus' },
  vorbis: { id: 'vorbis', label: 'Vorbis', encoder: 'libvorbis' },
  flac: { id: 'flac', label: 'FLAC (lossless)', encoder: 'flac' },
  pcm: { id: 'pcm', label: 'PCM WAV (lossless)', encoder: 'pcm_s16le' },
  pcm_be: { id: 'pcm_be', label: 'PCM AIFF (lossless)', encoder: 'pcm_s16be' },
  alac: { id: 'alac', label: 'Apple Lossless', encoder: 'alac' },
  wma: { id: 'wma', label: 'WMA', encoder: 'wmav2' },
  ac3: { id: 'ac3', label: 'Dolby Digital (AC-3)', encoder: 'ac3' },
  mp2: { id: 'mp2', label: 'MPEG Layer II', encoder: 'mp2' },
  amr: { id: 'amr', label: 'AMR-NB', encoder: 'libopencore_amrnb' },
};

export interface QualityPreset {
  id: string;
  label: string;
  description?: string;
  video: VideoOutput | null;
  audio: AudioOutput | null;
}

export type TargetGroup = 'video' | 'audio' | 'device' | 'web' | 'disc' | 'image';

export interface OutputTarget {
  id: string;
  label: string; // shown as "to {label}"
  group: TargetGroup;
  container: string; // file extension
  badge: string; // short text on the button
  color: string; // accent color of the button
  description: string;
  videoCodecs: string[]; // allowed video codecs (first = default); empty = audio only
  audioCodecs: string[]; // allowed audio codecs (first = default)
  presets: QualityPreset[];
  defaultPreset: string;
  supportsTwoPass: boolean;
  /** Special handling in the engine. */
  special?: 'html5' | 'gif' | 'dvd' | 'bluray';
}

/* ───────── helpers ───────── */

const v = (codec: string, height?: number, bitrateKbps?: number, extra: Partial<VideoOutput> = {}): VideoOutput => ({
  codec,
  height,
  width: height ? Math.round((height * 16) / 9 / 2) * 2 : undefined,
  bitrateKbps,
  fit: 'pad',
  ...extra,
});
const a = (codec: string, bitrateKbps?: number, extra: Partial<AudioOutput> = {}): AudioOutput => ({ codec, bitrateKbps, ...extra });

/** Standard resolution ladder for general-purpose formats. */
function ladder(vcodec: string, acodec: string, opts: { max?: number; abr?: number; bitrates?: Record<number, number> } = {}): QualityPreset[] {
  const max = opts.max ?? 2160;
  const abr = opts.abr ?? 192;
  const br = opts.bitrates;
  const rows: [number, string][] = [
    [2160, '4K Ultra HD'],
    [1440, '2K QHD'],
    [1080, 'Full HD'],
    [720, 'HD'],
    [480, 'SD (DVD quality)'],
    [360, 'Mobile'],
    [240, 'Small'],
  ];
  const presets: QualityPreset[] = [
    {
      id: 'source',
      label: 'Same as source',
      description: 'Keep original resolution and frame rate, high quality',
      video: { codec: vcodec, fit: 'pad', quality: 80 },
      audio: a(acodec, abr),
    },
  ];
  for (const [h, name] of rows) {
    if (h > max) continue;
    presets.push({
      id: `${h}p`,
      label: `${name} (${h}p)`,
      video: br ? v(vcodec, h, br[h]) : { ...v(vcodec, h), quality: 75 },
      audio: a(acodec, h >= 720 ? abr : Math.min(abr, 128)),
    });
  }
  return presets;
}

const LEGACY_BITRATES: Record<number, number> = { 2160: 20000, 1440: 12000, 1080: 8000, 720: 4500, 480: 2000, 360: 1000, 240: 500 };

/* ───────── targets ───────── */

export const OUTPUT_TARGETS: OutputTarget[] = [
  // ── Video formats
  {
    id: 'mp4', label: 'MP4', group: 'video', container: 'mp4', badge: 'MP4', color: '#2f80ed',
    description: 'Plays everywhere: phones, TVs, browsers, editors.',
    videoCodecs: ['h264', 'hevc', 'av1', 'mpeg4'], audioCodecs: ['aac', 'mp3', 'ac3', 'opus'],
    presets: ladder('h264', 'aac'), defaultPreset: 'source', supportsTwoPass: true,
  },
  {
    id: 'avi', label: 'AVI', group: 'video', container: 'avi', badge: 'AVI', color: '#27ae60',
    description: 'Classic Windows video for older players and DVD players with USB.',
    videoCodecs: ['xvid', 'h264', 'mpeg4'], audioCodecs: ['mp3', 'ac3', 'pcm'],
    presets: ladder('xvid', 'mp3', { max: 1080, abr: 192, bitrates: LEGACY_BITRATES }), defaultPreset: '720p', supportsTwoPass: true,
  },
  {
    id: 'wmv', label: 'WMV', group: 'video', container: 'wmv', badge: 'WMV', color: '#0078d4',
    description: 'Windows Media Video for Windows Media Player and older PowerPoint.',
    videoCodecs: ['wmv2'], audioCodecs: ['wma'],
    presets: ladder('wmv2', 'wma', { max: 1080, abr: 192, bitrates: LEGACY_BITRATES }), defaultPreset: '720p', supportsTwoPass: true,
  },
  {
    id: 'mkv', label: 'MKV', group: 'video', container: 'mkv', badge: 'MKV', color: '#8e44ad',
    description: 'Flexible container; keeps multiple audio and subtitle tracks.',
    videoCodecs: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], audioCodecs: ['aac', 'opus', 'ac3', 'flac', 'mp3', 'vorbis'],
    presets: ladder('h264', 'aac'), defaultPreset: 'source', supportsTwoPass: true,
  },
  {
    id: 'mov', label: 'MOV', group: 'video', container: 'mov', badge: 'MOV', color: '#636e72',
    description: 'QuickTime for Mac, Final Cut and iMovie. ProRes available for editing.',
    videoCodecs: ['h264', 'hevc', 'prores'], audioCodecs: ['aac', 'alac', 'pcm'],
    presets: [
      ...ladder('h264', 'aac'),
      { id: 'prores', label: 'ProRes 422 (for editing)', video: { codec: 'prores', fit: 'pad' }, audio: a('pcm') },
    ],
    defaultPreset: 'source', supportsTwoPass: true,
  },
  {
    id: 'webm', label: 'WebM', group: 'web', container: 'webm', badge: 'WebM', color: '#e67e22',
    description: 'Open web format (VP9 + Opus) for websites and browsers.',
    videoCodecs: ['vp9', 'av1', 'vp8'], audioCodecs: ['opus', 'vorbis'],
    presets: ladder('vp9', 'opus', { abr: 160 }), defaultPreset: '1080p', supportsTwoPass: true,
  },
  {
    id: 'html5', label: 'HTML5', group: 'web', container: 'mp4', badge: 'HTML5', color: '#e44d26',
    description: 'Makes MP4 + WebM + OGV versions and an HTML page snippet for your website.',
    videoCodecs: ['h264'], audioCodecs: ['aac'],
    presets: ladder('h264', 'aac', { max: 1080, abr: 128 }), defaultPreset: '720p', supportsTwoPass: false, special: 'html5',
  },
  {
    id: 'mpeg', label: 'MPEG', group: 'video', container: 'mpg', badge: 'MPEG', color: '#16a085',
    description: 'MPEG-1/MPEG-2 for legacy players and set-top boxes.',
    videoCodecs: ['mpeg2', 'mpeg1'], audioCodecs: ['mp2', 'ac3'],
    presets: ladder('mpeg2', 'mp2', { max: 1080, abr: 224, bitrates: { ...LEGACY_BITRATES, 480: 6000 } }), defaultPreset: '480p', supportsTwoPass: true,
  },
  {
    id: 'flv', label: 'FLV', group: 'web', container: 'flv', badge: 'FLV', color: '#c0392b',
    description: 'Flash Video for legacy web players.',
    videoCodecs: ['h264', 'flv1'], audioCodecs: ['aac', 'mp3'],
    presets: ladder('h264', 'aac', { max: 1080, abr: 128 }), defaultPreset: '720p', supportsTwoPass: true,
  },
  {
    id: 'swf', label: 'SWF', group: 'web', container: 'swf', badge: 'SWF', color: '#b33939',
    description: 'Legacy Flash movie (Sorenson video + MP3).',
    videoCodecs: ['flv1'], audioCodecs: ['mp3'],
    presets: ladder('flv1', 'mp3', { max: 720, abr: 128, bitrates: LEGACY_BITRATES }).map((p) => ({ ...p, audio: p.audio ? { ...p.audio, sampleRate: 44100 } : null })),
    defaultPreset: '480p', supportsTwoPass: false,
  },
  {
    id: '3gp', label: '3GP', group: 'device', container: '3gp', badge: '3GP', color: '#7f8c8d',
    description: 'Very small files for old mobile phones.',
    videoCodecs: ['h263', 'mpeg4', 'h264'], audioCodecs: ['aac', 'amr'],
    presets: [
      { id: 'cif', label: 'CIF 352×288', video: { codec: 'h263', width: 352, height: 288, bitrateKbps: 384, fps: 15, fit: 'pad' }, audio: a('aac', 64, { sampleRate: 22050, channels: 1 }) },
      { id: 'qcif', label: 'QCIF 176×144', video: { codec: 'h263', width: 176, height: 144, bitrateKbps: 128, fps: 15, fit: 'pad' }, audio: a('amr', 12, { sampleRate: 8000, channels: 1 }) },
      { id: 'qvga', label: 'QVGA 320×240 (MPEG-4)', video: { codec: 'mpeg4', width: 320, height: 240, bitrateKbps: 512, fps: 25, fit: 'pad' }, audio: a('aac', 96, { sampleRate: 44100, channels: 2 }) },
    ],
    defaultPreset: 'cif', supportsTwoPass: false,
  },
  {
    id: 'ogv', label: 'OGV', group: 'web', container: 'ogv', badge: 'OGV', color: '#d35400',
    description: 'Ogg Theora video (open format).',
    videoCodecs: ['theora'], audioCodecs: ['vorbis'],
    presets: ladder('theora', 'vorbis', { max: 1080, abr: 160 }), defaultPreset: '720p', supportsTwoPass: false,
  },
  {
    id: 'gif', label: 'GIF', group: 'image', container: 'gif', badge: 'GIF', color: '#f39c12',
    description: 'Animated GIF — best for short clips (trim first!).',
    videoCodecs: ['gif'], audioCodecs: [],
    presets: [
      { id: 'small', label: 'Small (320px, 10 fps)', video: { codec: 'gif', width: 320, fps: 10, fit: 'pad' }, audio: null },
      { id: 'medium', label: 'Medium (480px, 15 fps)', video: { codec: 'gif', width: 480, fps: 15, fit: 'pad' }, audio: null },
      { id: 'large', label: 'Large (720px, 20 fps)', video: { codec: 'gif', width: 720, fps: 20, fit: 'pad' }, audio: null },
    ],
    defaultPreset: 'medium', supportsTwoPass: false, special: 'gif',
  },

  // ── Audio formats
  ...audioTargets(),

  // ── Devices
  {
    id: 'apple', label: 'Apple', group: 'device', container: 'mp4', badge: 'Apple', color: '#555555',
    description: 'iPhone, iPad, Apple TV, Mac and iTunes.',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'],
    presets: [
      { id: 'iphone', label: 'iPhone (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 75, fit: 'pad' }, audio: a('aac', 160) },
      { id: 'iphone-hevc', label: 'iPhone (4K HEVC)', video: { codec: 'hevc', width: 3840, height: 2160, quality: 75, fit: 'pad' }, audio: a('aac', 192) },
      { id: 'ipad', label: 'iPad (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 78, fit: 'pad' }, audio: a('aac', 192) },
      { id: 'appletv', label: 'Apple TV 4K', video: { codec: 'hevc', width: 3840, height: 2160, quality: 80, fit: 'pad' }, audio: a('aac', 256) },
      { id: 'ipod', label: 'iPod / old iPhone (480p)', video: { codec: 'h264', width: 640, height: 480, bitrateKbps: 1500, fit: 'pad' }, audio: a('aac', 128) },
    ],
    defaultPreset: 'iphone', supportsTwoPass: true,
  },
  {
    id: 'android', label: 'Android', group: 'device', container: 'mp4', badge: 'Android', color: '#3ddc84',
    description: 'Android phones and tablets (Samsung, Pixel, Xiaomi …).',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'],
    presets: [
      { id: 'phone-1080', label: 'Phone Full HD (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 72, fit: 'pad' }, audio: a('aac', 160) },
      { id: 'phone-720', label: 'Phone HD (720p)', video: { codec: 'h264', width: 1280, height: 720, quality: 70, fit: 'pad' }, audio: a('aac', 128) },
      { id: 'tablet', label: 'Tablet (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 76, fit: 'pad' }, audio: a('aac', 192) },
      { id: 'phone-small', label: 'Small phone (480p)', video: { codec: 'h264', width: 854, height: 480, bitrateKbps: 1200, fit: 'pad' }, audio: a('aac', 96) },
    ],
    defaultPreset: 'phone-1080', supportsTwoPass: true,
  },
  {
    id: 'samsung', label: 'Samsung', group: 'device', container: 'mp4', badge: 'Samsung', color: '#1428a0',
    description: 'Samsung Galaxy phones and Samsung Smart TVs.',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3'],
    presets: [
      { id: 'galaxy', label: 'Galaxy phone (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 74, fit: 'pad' }, audio: a('aac', 160) },
      { id: 'tv-4k', label: 'Smart TV 4K (HEVC)', video: { codec: 'hevc', width: 3840, height: 2160, quality: 80, fit: 'pad' }, audio: a('ac3', 384) },
      { id: 'tv-1080', label: 'Smart TV Full HD', video: { codec: 'h264', width: 1920, height: 1080, quality: 78, fit: 'pad' }, audio: a('ac3', 384) },
    ],
    defaultPreset: 'galaxy', supportsTwoPass: true,
  },
  {
    id: 'sony', label: 'Sony', group: 'device', container: 'mp4', badge: 'Sony', color: '#003791',
    description: 'PlayStation 5 / 4, PSP and Sony Bravia TVs.',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3'],
    presets: [
      { id: 'ps5', label: 'PlayStation 5 (4K)', video: { codec: 'hevc', width: 3840, height: 2160, quality: 80, fit: 'pad' }, audio: a('aac', 256) },
      { id: 'ps4', label: 'PlayStation 4 (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 78, fit: 'pad' }, audio: a('aac', 192) },
      { id: 'psp', label: 'PSP (480×272)', video: { codec: 'h264', width: 480, height: 272, bitrateKbps: 768, fps: 30, fit: 'pad' }, audio: a('aac', 128, { sampleRate: 48000 }) },
      { id: 'bravia', label: 'Bravia TV (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 80, fit: 'pad' }, audio: a('ac3', 384) },
    ],
    defaultPreset: 'ps5', supportsTwoPass: true,
  },
  {
    id: 'xbox', label: 'Xbox', group: 'device', container: 'mp4', badge: 'Xbox', color: '#107c10',
    description: 'Xbox Series X|S and Xbox One.',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3'],
    presets: [
      { id: 'series', label: 'Xbox Series X|S (4K)', video: { codec: 'hevc', width: 3840, height: 2160, quality: 80, fit: 'pad' }, audio: a('aac', 256) },
      { id: 'one', label: 'Xbox One (1080p)', video: { codec: 'h264', width: 1920, height: 1080, quality: 78, fit: 'pad' }, audio: a('aac', 192) },
    ],
    defaultPreset: 'series', supportsTwoPass: true,
  },
  {
    id: 'tv', label: 'Smart TV', group: 'device', container: 'mkv', badge: 'TV', color: '#34495e',
    description: 'LG, Philips, TCL, Hisense, Roku and other smart TVs.',
    videoCodecs: ['h264', 'hevc'], audioCodecs: ['ac3', 'aac'],
    presets: [
      { id: '4k', label: '4K (HEVC)', video: { codec: 'hevc', width: 3840, height: 2160, quality: 80, fit: 'pad' }, audio: a('ac3', 448) },
      { id: '1080', label: 'Full HD (H.264)', video: { codec: 'h264', width: 1920, height: 1080, quality: 78, fit: 'pad' }, audio: a('ac3', 384) },
    ],
    defaultPreset: '1080', supportsTwoPass: true,
  },
  {
    id: 'nokia', label: 'Nokia / Feature phone', group: 'device', container: '3gp', badge: 'Phone', color: '#124191',
    description: 'Old Nokia and feature phones.',
    videoCodecs: ['mpeg4', 'h263'], audioCodecs: ['aac', 'amr'],
    presets: [
      { id: 'qvga', label: '320×240', video: { codec: 'mpeg4', width: 320, height: 240, bitrateKbps: 384, fps: 15, fit: 'pad' }, audio: a('aac', 64, { sampleRate: 22050, channels: 1 }) },
      { id: 'qcif', label: '176×144', video: { codec: 'h263', width: 176, height: 144, bitrateKbps: 128, fps: 15, fit: 'pad' }, audio: a('amr', 12, { sampleRate: 8000, channels: 1 }) },
    ],
    defaultPreset: 'qvga', supportsTwoPass: false,
  },

  // ── Discs
  {
    id: 'dvd', label: 'DVD', group: 'disc', container: 'vob', badge: 'DVD', color: '#6c5ce7',
    description: 'Burn a DVD that plays on any DVD player, or save a DVD folder / ISO image.',
    videoCodecs: ['mpeg2'], audioCodecs: ['ac3'],
    presets: [
      { id: 'pal', label: 'PAL (Europe, Asia) 720×576, 25 fps', video: { codec: 'mpeg2', width: 720, height: 576, fps: 25, fit: 'pad' }, audio: a('ac3', 192, { sampleRate: 48000 }) },
      { id: 'ntsc', label: 'NTSC (USA, Japan) 720×480, 29.97 fps', video: { codec: 'mpeg2', width: 720, height: 480, fps: 29.97, fit: 'pad' }, audio: a('ac3', 192, { sampleRate: 48000 }) },
    ],
    defaultPreset: 'pal', supportsTwoPass: false, special: 'dvd',
  },
  {
    id: 'bluray', label: 'Blu-ray', group: 'disc', container: 'm2ts', badge: 'BD', color: '#0652dd',
    description: 'Burn a Blu-ray disc, or save a Blu-ray folder / ISO image.',
    videoCodecs: ['h264'], audioCodecs: ['ac3'],
    presets: [
      { id: '1080', label: 'Full HD 1920×1080', video: { codec: 'h264', width: 1920, height: 1080, fit: 'pad' }, audio: a('ac3', 448, { sampleRate: 48000 }) },
      { id: '720', label: 'HD 1280×720', video: { codec: 'h264', width: 1280, height: 720, fit: 'pad' }, audio: a('ac3', 384, { sampleRate: 48000 }) },
    ],
    defaultPreset: '1080', supportsTwoPass: false, special: 'bluray',
  },
];

function audioTargets(): OutputTarget[] {
  const lossy = (codec: string, rates: number[], def: number): QualityPreset[] =>
    rates.map((r) => ({ id: `${r}`, label: `${r} kbps${r === def ? ' (recommended)' : ''}`, video: null, audio: a(codec, r) }));
  return [
    {
      id: 'mp3', label: 'MP3', group: 'audio', container: 'mp3', badge: 'MP3', color: '#e84393',
      description: 'Extract or convert audio to MP3 — works on every device.',
      videoCodecs: [], audioCodecs: ['mp3'], presets: lossy('mp3', [320, 256, 192, 128, 96], 192), defaultPreset: '192', supportsTwoPass: false,
    },
    {
      id: 'm4a', label: 'AAC (M4A)', group: 'audio', container: 'm4a', badge: 'AAC', color: '#fd79a8',
      description: 'High quality AAC audio for Apple devices and iTunes.',
      videoCodecs: [], audioCodecs: ['aac', 'alac'], presets: lossy('aac', [320, 256, 192, 128, 96], 256), defaultPreset: '256', supportsTwoPass: false,
    },
    {
      id: 'wav', label: 'WAV', group: 'audio', container: 'wav', badge: 'WAV', color: '#00b894',
      description: 'Uncompressed lossless audio.',
      videoCodecs: [], audioCodecs: ['pcm'],
      presets: [
        { id: 'cd', label: 'CD quality 44.1 kHz 16-bit', video: null, audio: a('pcm', undefined, { sampleRate: 44100 }) },
        { id: 'dvd', label: '48 kHz 16-bit', video: null, audio: a('pcm', undefined, { sampleRate: 48000 }) },
      ],
      defaultPreset: 'cd', supportsTwoPass: false,
    },
    {
      id: 'flac', label: 'FLAC', group: 'audio', container: 'flac', badge: 'FLAC', color: '#00cec9',
      description: 'Lossless compressed audio.',
      videoCodecs: [], audioCodecs: ['flac'],
      presets: [{ id: 'lossless', label: 'Lossless', video: null, audio: a('flac') }], defaultPreset: 'lossless', supportsTwoPass: false,
    },
    {
      id: 'ogg', label: 'OGG', group: 'audio', container: 'ogg', badge: 'OGG', color: '#a29bfe',
      description: 'Ogg Vorbis audio.',
      videoCodecs: [], audioCodecs: ['vorbis'], presets: lossy('vorbis', [320, 256, 192, 128], 192), defaultPreset: '192', supportsTwoPass: false,
    },
    {
      id: 'opus', label: 'Opus', group: 'audio', container: 'opus', badge: 'OPUS', color: '#6c5ce7',
      description: 'Modern, very efficient audio codec.',
      videoCodecs: [], audioCodecs: ['opus'], presets: lossy('opus', [256, 192, 160, 128, 96, 64], 160), defaultPreset: '160', supportsTwoPass: false,
    },
    {
      id: 'wma', label: 'WMA', group: 'audio', container: 'wma', badge: 'WMA', color: '#0984e3',
      description: 'Windows Media Audio.',
      videoCodecs: [], audioCodecs: ['wma'], presets: lossy('wma', [320, 192, 128], 192), defaultPreset: '192', supportsTwoPass: false,
    },
    {
      id: 'ac3', label: 'AC3', group: 'audio', container: 'ac3', badge: 'AC3', color: '#2d3436',
      description: 'Dolby Digital audio for home theater.',
      videoCodecs: [], audioCodecs: ['ac3'], presets: lossy('ac3', [640, 448, 384, 192], 448), defaultPreset: '448', supportsTwoPass: false,
    },
    {
      id: 'aiff', label: 'AIFF', group: 'audio', container: 'aiff', badge: 'AIFF', color: '#636e72',
      description: 'Uncompressed audio for Mac.',
      videoCodecs: [], audioCodecs: ['pcm_be'],
      presets: [{ id: 'cd', label: 'CD quality 44.1 kHz 16-bit', video: null, audio: a('pcm_be', undefined, { sampleRate: 44100 }) }],
      defaultPreset: 'cd', supportsTwoPass: false,
    },
  ];
}

export function getTarget(id: string): OutputTarget | undefined {
  return OUTPUT_TARGETS.find((t) => t.id === id);
}

export function getPreset(targetId: string, presetId: string): QualityPreset | undefined {
  return getTarget(targetId)?.presets.find((p) => p.id === presetId);
}

/** Which containers each video codec may go into (used to validate custom settings). */
export const CONTAINER_LABELS: Record<string, string> = {
  mp4: 'MP4', mkv: 'MKV', avi: 'AVI', wmv: 'WMV', mov: 'MOV', webm: 'WebM', mpg: 'MPEG', flv: 'FLV', swf: 'SWF', '3gp': '3GP', ogv: 'OGV', gif: 'GIF',
  mp3: 'MP3', m4a: 'M4A', wav: 'WAV', flac: 'FLAC', ogg: 'OGG', opus: 'Opus', wma: 'WMA', ac3: 'AC3', aiff: 'AIFF',
};

export const FRAME_RATES = [10, 12, 15, 20, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
export const SAMPLE_RATES = [8000, 11025, 22050, 32000, 44100, 48000, 96000];
export const RESOLUTIONS: { label: string; width: number; height: number }[] = [
  { label: '8K (7680×4320)', width: 7680, height: 4320 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: '2K (2560×1440)', width: 2560, height: 1440 },
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '576p PAL (720×576)', width: 720, height: 576 },
  { label: '480p (854×480)', width: 854, height: 480 },
  { label: 'NTSC (720×480)', width: 720, height: 480 },
  { label: '360p (640×360)', width: 640, height: 360 },
  { label: 'VGA (640×480)', width: 640, height: 480 },
  { label: '240p (426×240)', width: 426, height: 240 },
  { label: 'Vertical 1080×1920', width: 1080, height: 1920 },
  { label: 'Square 1080×1080', width: 1080, height: 1080 },
];
