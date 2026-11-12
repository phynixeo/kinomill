// ffmpeg audio filter chains for the "audio tools" (noise reduction, voice
// cleanup, echo reduction, loudness normalization, basic vocal removal) and
// container/codec helpers. Pure functions — unit tested.
import type { AudioToolOp, AudioToolSpec } from '../../../shared/types';

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
const r2 = (n: number) => +n.toFixed(2);

export const OP_LABEL: Record<AudioToolOp, string> = {
  vocals: 'vocals',
  instrumental: 'instrumental',
  stems: 'stems',
  denoise: 'noise reduced',
  voice: 'voice enhanced',
  dereverb: 'echo reduced',
  normalize: 'normalized',
};

export const OP_STAGE: Record<AudioToolOp, string> = {
  vocals: 'Isolating vocals (AI)',
  instrumental: 'Removing vocals (AI)',
  stems: 'Splitting into vocals, drums, bass and other (AI)',
  denoise: 'Reducing background noise',
  voice: 'Cleaning up speech',
  dereverb: 'Reducing echo and reverb (basic filter, not AI)',
  normalize: 'Normalizing loudness (EBU R128)',
};

export const AI_OPS: AudioToolOp[] = ['vocals', 'instrumental', 'stems'];

/** Filter chain for the ffmpeg-only operations (normalize is two-pass, see loudnormSecondPass). */
export function cleanupChain(op: AudioToolOp, strength: number): string {
  const s = clamp01(strength);
  switch (op) {
    case 'denoise': {
      // spectral noise reduction that tracks the noise floor; stronger = more reduction
      const nr = r2(6 + 24 * s);
      const parts = [`afftdn=nr=${nr}:nf=-40:tn=1`];
      // strong settings: a second, gentler pass (anlmdn would be nicer but crashes in some ffmpeg 9 builds)
      if (s > 0.6) parts.push(`afftdn=nr=${r2(6 + 30 * (s - 0.6))}:nf=-50:tn=1`);
      return parts.join(',');
    }
    case 'voice':
      return [
        'highpass=f=80',
        `afftdn=nr=${r2(8 + 16 * s)}:nf=-40:tn=1`,
        `deesser=i=${r2(0.1 + 0.4 * s)}:m=0.5:f=0.5`,
        `acompressor=threshold=-20dB:ratio=${r2(2 + 2 * s)}:attack=10:release=150:makeup=2`,
        'loudnorm=I=-16:TP=-1.5:LRA=9',
        'aresample=48000',
      ].join(',');
    case 'dereverb':
      // No true de-reverb exists in ffmpeg: attenuate decaying tails between words with an
      // expander/gate, reduce the diffuse "room" floor and the boomy low end.
      return [
        'highpass=f=100',
        `afftdn=nr=${r2(6 + 14 * s)}:nf=-35:tn=1`,
        `agate=threshold=${r2(0.02 + 0.05 * s)}:ratio=${r2(1.5 + 2.5 * s)}:range=${r2(0.25 - 0.2 * s)}:attack=5:release=${Math.round(120 - 60 * s)}`,
        'aresample=48000',
      ].join(',');
    case 'instrumental':
      return basicKaraokeChain(s);
    default:
      throw new Error(`"${op}" is not an ffmpeg-only operation`);
  }
}

/**
 * Basic vocal removal without AI: cancel the centre channel (where lead vocals usually sit)
 * and add the bass back, since kick and bass are centred too. Needs a stereo source.
 */
export function basicKaraokeChain(strength: number): string {
  const s = r2(0.5 + 0.5 * clamp01(strength));
  return [
    'aformat=channel_layouts=stereo,asplit=2[kar_a][kar_b]',
    `[kar_a]pan=stereo|c0=c0-${s}*c1|c1=c1-${s}*c0,highpass=f=180[kar_side]`,
    '[kar_b]lowpass=f=180[kar_low]',
    '[kar_side][kar_low]amix=inputs=2:normalize=0',
  ].join(';');
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11';

/** Parse the JSON block ffmpeg's loudnorm prints in print_format=json mode. */
export function parseLoudnorm(text: string): LoudnormMeasure | null {
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Partial<LoudnormMeasure>;
    if (!j.input_i || !j.input_tp || !j.input_lra || !j.input_thresh || j.target_offset === undefined) return null;
    if (!Number.isFinite(Number(j.input_i))) return null; // silence → "-inf"
    return j as LoudnormMeasure;
  } catch {
    return null;
  }
}

export function loudnormSecondPass(m: LoudnormMeasure): string {
  return `loudnorm=${LOUDNORM_TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
}

/** Encoder args + extension for an audio-only output format. */
export function audioFormatArgs(fmt: AudioToolSpec['outputFormat']): { ext: string; args: string[] } {
  switch (fmt) {
    case 'mp3':
      return { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'] };
    case 'flac':
      return { ext: 'flac', args: ['-c:a', 'flac'] };
    case 'm4a':
      return { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'] };
    default:
      return { ext: 'wav', args: ['-c:a', 'pcm_s16le'] };
  }
}

/** Audio codec that the video's own container accepts (used when writing the result back into the video). */
export function videoContainerAudio(ext: string): { ext: string; args: string[] } {
  const e = ext.toLowerCase().replace(/^\./, '');
  switch (e) {
    case 'mp4':
    case 'm4v':
    case 'mov':
    case '3gp':
      return { ext: e, args: ['-c:a', 'aac', '-b:a', '256k'] };
    case 'webm':
      return { ext: e, args: ['-c:a', 'libopus', '-b:a', '192k'] };
    case 'mkv':
      return { ext: e, args: ['-c:a', 'aac', '-b:a', '256k'] };
    case 'avi':
      return { ext: e, args: ['-c:a', 'libmp3lame', '-b:a', '256k'] };
    case 'wmv':
    case 'asf':
      return { ext: e, args: ['-c:a', 'wmav2', '-b:a', '192k'] };
    case 'flv':
      return { ext: e, args: ['-c:a', 'aac', '-b:a', '192k'] };
    case 'mpg':
    case 'mpeg':
    case 'vob':
      return { ext: e, args: ['-c:a', 'mp2', '-b:a', '224k'] };
    default:
      // anything exotic: Matroska holds every video codec
      return { ext: 'mkv', args: ['-c:a', 'aac', '-b:a', '256k'] };
  }
}

/** tqdm progress from Demucs: " 45%|████▌     | 23.4/52.0 [00:05<00:06, 4.37seconds/s]" */
export function parseDemucsProgress(line: string): number | null {
  const m = /(\d{1,3})%\|/.exec(line);
  return m ? Math.min(1, Number(m[1]) / 100) : null;
}
