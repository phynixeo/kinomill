// Reads media files with ffprobe and turns the JSON into MediaInfo.
import path from 'node:path';
import type { AudioStreamInfo, MediaInfo, SubtitleStreamInfo, VideoStreamInfo } from '../../../shared/types';
import { fileSize, runCapture } from '../util';

/* Minimal shape of ffprobe's JSON output that we rely on. */
export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string; nb_streams?: number };
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.avif', '.jfif']);
const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|bmp_pipe|webp_pipe|tiff_pipe|jpegls_pipe|qoi_pipe|avif)(,|$)/;

const BROWSER_VIDEO_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const BROWSER_AUDIO_CONTAINERS = new Set(['.mp3', '.m4a', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm', '.mp4', '.aac']);
const BROWSER_VCODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_ACODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);

export function parseRate(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  if (!d) return Number.isFinite(n) ? n : 0;
  const v = n / d;
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function num(s?: string): number | undefined {
  if (s === undefined || s === null || s === 'N/A') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalize a rotation (degrees, any sign) to 0/90/180/270 clockwise. */
export function normRotation(deg: number): number {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r;
}

/** Pure: build MediaInfo from ffprobe JSON. `size` is the file size in bytes. */
export function mediaInfoFromProbe(file: string, j: ProbeJson, size: number): MediaInfo {
  const streams = j.streams ?? [];
  const fmt = j.format ?? {};
  const ext = path.extname(file).toLowerCase();
  const formatName = fmt.format_name ?? '';

  const vStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');

  let duration = num(fmt.duration) ?? 0;
  if (!duration) duration = Math.max(0, ...streams.map((s) => num(s.duration) ?? 0));

  const isImage =
    !!vStream &&
    audio.length === 0 &&
    (IMAGE_FORMATS.test(formatName) || (IMAGE_EXT.has(ext) && (num(vStream.nb_frames) ?? 1) <= 1));

  let video: VideoStreamInfo | undefined;
  if (vStream) {
    let rotation = 0;
    const sd = vStream.side_data_list?.find((d) => typeof d.rotation === 'number');
    if (sd?.rotation !== undefined) rotation = normRotation(-sd.rotation); // display matrix is counter-clockwise
    else if (vStream.tags?.rotate) rotation = normRotation(Number(vStream.tags.rotate));
    const cw = vStream.width ?? 0;
    const ch = vStream.height ?? 0;
    const swap = rotation === 90 || rotation === 270;
    let fps = parseRate(vStream.avg_frame_rate);
    if (!fps || fps > 1000) fps = parseRate(vStream.r_frame_rate);
    if (fps > 1000) fps = 0;
    video = {
      index: vStream.index,
      codec: vStream.codec_name ?? 'unknown',
      // display size (ffmpeg auto-rotates while decoding, so filters see these dimensions)
      width: swap ? ch : cw,
      height: swap ? cw : ch,
      fps,
      bitrate: num(vStream.bit_rate),
      rotation,
      pixFmt: vStream.pix_fmt,
      sar: vStream.sample_aspect_ratio,
      dar: vStream.display_aspect_ratio,
    };
  }

  const audioTracks: AudioStreamInfo[] = audio.map((s, order) => ({
    index: s.index,
    order,
    codec: s.codec_name ?? 'unknown',
    channels: s.channels ?? 2,
    sampleRate: num(s.sample_rate) ?? 48000,
    bitrate: num(s.bit_rate),
    language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
    title: s.tags?.title || s.tags?.handler_name?.replace(/^(SoundHandler|ISO Media file.*)$/i, '') || undefined,
  }));

  const subtitleTracks: SubtitleStreamInfo[] = subs.map((s, order) => ({
    index: s.index,
    order,
    codec: s.codec_name ?? 'unknown',
    language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
    title: s.tags?.title || undefined,
  }));

  const isAudioOnly = !video && audioTracks.length > 0;

  let browserPlayable = false;
  if (isImage) {
    browserPlayable = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(ext);
  } else if (video) {
    const okPix = !video.pixFmt || /^(yuv420p|yuvj420p|nv12)$/.test(video.pixFmt) || video.codec !== 'h264';
    browserPlayable =
      BROWSER_VIDEO_CONTAINERS.has(ext) &&
      BROWSER_VCODECS.has(video.codec) &&
      okPix &&
      audioTracks.every((a) => BROWSER_ACODECS.has(a.codec));
  } else if (isAudioOnly) {
    browserPlayable = BROWSER_AUDIO_CONTAINERS.has(ext) && BROWSER_ACODECS.has(audioTracks[0].codec);
  }

  return {
    path: file,
    name: path.basename(file),
    size,
    duration: isImage ? 0 : duration,
    formatName,
    bitrate: num(fmt.bit_rate),
    video,
    audioTracks,
    subtitleTracks,
    isImage,
    isAudioOnly,
    browserPlayable,
  };
}

export async function probeFile(ffprobe: string, file: string): Promise<MediaInfo> {
  const r = await runCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  if (r.code !== 0) {
    const msg = r.stderr.trim().split(/\r?\n/).pop() || 'unknown error';
    throw new Error(`Cannot read "${path.basename(file)}": ${msg.replace(/^.*?:\s*/, '')}`);
  }
  let j: ProbeJson;
  try {
    j = JSON.parse(r.stdout) as ProbeJson;
  } catch {
    throw new Error(`Cannot read "${path.basename(file)}"`);
  }
  if (!j.streams?.length) throw new Error(`"${path.basename(file)}" has no audio or video`);
  return mediaInfoFromProbe(file, j, fileSize(file));
}

/** Duration of a media file in seconds (0 if unknown). */
export async function probeDuration(ffprobe: string, file: string): Promise<number> {
  const r = await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 30000 });
  const d = Number(r.stdout.trim());
  return Number.isFinite(d) ? d : 0;
}
