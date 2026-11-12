// Photo slideshow builder (the Converter's "Photo" input): images → video with optional
// Ken Burns pan/zoom, transitions and background music.
import type { OutputSpec, SlideshowSpec } from '../../../shared/types';
import {
  Graph,
  audioEncoderArgs,
  containerArgs,
  even,
  fpsExpr,
  gifPalette,
  pickVideoEncoder,
  videoEncoderArgs,
  watermarkFilters,
  type BuildEnv,
  type ConvertPlan,
  type WatermarkFiles,
} from './ffmpegArgs';

const XFADE: Record<SlideshowSpec['transition'], string> = {
  none: '',
  fade: 'fade',
  slide: 'slideleft',
  wipe: 'wipeleft',
  dissolve: 'dissolve',
};

export interface SlideshowParams {
  spec: SlideshowSpec;
  /** Images in final order (already shuffled if requested). */
  images: string[];
  /** Music files with their durations in seconds (0 = unknown). */
  music: { path: string; duration: number }[];
  output: OutputSpec;
  outPath: string;
  env: BuildEnv;
  wm?: WatermarkFiles;
}

export function slideshowTiming(spec: SlideshowSpec, n: number): { S: number; T: number; clip: number; total: number } {
  const S = Math.max(0.5, spec.secondsPerImage || 4);
  const T = spec.transition === 'none' || n < 2 ? 0 : Math.min(Math.max(0.1, spec.transitionSeconds || 1), S * 0.9);
  const clip = S + T;
  const total = n * S + T;
  return { S, T, clip, total };
}

export function buildSlideshowPlan(p: SlideshowParams): ConvertPlan {
  const { spec, images, output, env } = p;
  if (!images.length) throw new Error('Add at least one photo for the slideshow.');
  const n = images.length;
  const W = even(spec.width || output.video?.width || 1920);
  const H = even(spec.height || output.video?.height || 1080);
  const F = spec.fps || output.video?.fps || 30;
  const { S, T, clip, total } = slideshowTiming(spec, n);
  const frames = Math.max(1, Math.round(clip * F));

  const g = new Graph();
  const inArgs: string[] = [];
  const clips: string[] = [];
  images.forEach((img, k) => {
    if (spec.panZoom) {
      inArgs.push('-i', img);
      const zin = k % 2 === 0;
      const z = zin ? `1+0.18*on/${frames}` : `1.18-0.18*on/${frames}`;
      // drift horizontally in alternating directions while zooming
      const x = k % 4 < 2 ? `(iw-iw/zoom)*on/${frames}` : `(iw-iw/zoom)*(1-on/${frames})`;
      clips.push(
        g.chain(`${k}:v:0`, [
          `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease:flags=lanczos`,
          `pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:color=black`,
          'setsar=1',
          `zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fpsExpr(F)}`,
          `fps=${fpsExpr(F)}`,
          'format=yuv420p',
          'setpts=PTS-STARTPTS',
        ]),
      );
    } else {
      inArgs.push('-loop', '1', '-framerate', fpsExpr(F), '-t', clip.toFixed(3), '-i', img);
      clips.push(
        g.chain(`${k}:v:0`, [
          `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
          'setsar=1',
          `fps=${fpsExpr(F)}`,
          'format=yuv420p',
          'setpts=PTS-STARTPTS',
        ]),
      );
    }
  });

  let v: string;
  if (n === 1) v = clips[0];
  else if (T > 0) {
    v = clips[0];
    for (let k = 1; k < n; k++) {
      v = g.add([v, clips[k]], `xfade=transition=${XFADE[spec.transition] || 'fade'}:duration=${T.toFixed(3)}:offset=${(k * S).toFixed(3)}`)[0];
    }
  } else {
    v = g.add(clips, `concat=n=${n}:v=1:a=0`)[0];
  }
  // make sure the video is exactly as long as planned
  v = g.chain(v, [`trim=duration=${total.toFixed(3)}`, 'setpts=PTS-STARTPTS']);

  if (output.watermark) {
    let idx: number | undefined;
    if (output.watermark.type === 'image' && output.watermark.imagePath) {
      idx = n;
      inArgs.push('-i', output.watermark.imagePath);
    }
    v = watermarkFilters(g, v, output.watermark, { w: W, h: H }, p.wm ?? {}, idx);
  }
  const isGif = output.video?.codec === 'gif';
  if (isGif) v = gifPalette(g, v);

  /* music: repeat the playlist until it covers the video, then trim + fade out */
  let a: string | undefined;
  if (p.music.length && output.audio && !isGif) {
    const known = p.music.reduce((s, m) => s + (m.duration || 0), 0);
    const reps = known > 0 ? Math.min(20, Math.max(1, Math.ceil(total / known))) : 1;
    const base = inArgs.filter((x) => x === '-i').length;
    const parts: string[] = [];
    let idx = base;
    for (let r = 0; r < reps; r++) {
      for (const m of p.music) {
        inArgs.push('-i', m.path);
        parts.push(g.chain(`${idx}:a:0`, ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo']));
        idx++;
      }
    }
    const joined = parts.length > 1 ? g.add(parts, `concat=n=${parts.length}:v=0:a=1`)[0] : parts[0];
    const fo = Math.min(3, total / 4);
    a = g.chain(joined, [`apad=whole_dur=${total.toFixed(3)}`, `atrim=0:${total.toFixed(3)}`, 'asetpts=PTS-STARTPTS', `afade=t=out:st=${Math.max(0, total - fo).toFixed(3)}:d=${fo.toFixed(3)}`]);
  }

  const container = output.container;
  const venc = output.video ? (isGif ? { encoder: 'gif' } : pickVideoEncoder(output.video.codec, output, env)) : undefined;
  const vargs = venc && output.video ? videoEncoderArgs(venc.encoder, output.video, { kbps: output.video.bitrateKbps, passLog: env.passLog, container }) : [];
  const aargs = a && output.audio ? audioEncoderArgs(output.audio, { index: 0, order: 0, codec: 'pcm', channels: 2, sampleRate: 48000 }, container) : [];
  const args = [
    ...inArgs,
    '-filter_complex',
    g.toString(),
    '-map',
    `[${v}]`,
    ...(a ? ['-map', `[${a}]`] : ['-an']),
    ...vargs,
    ...aargs,
    ...containerArgs(container, output.video?.codec),
    ...(isGif ? ['-loop', '0'] : []),
    '-max_muxing_queue_size',
    '4096',
    p.outPath,
  ];
  return {
    passes: [{ args, durationSec: total, stage: `Creating slideshow (${n} photo${n === 1 ? '' : 's'})` }],
    outputs: [p.outPath],
    files: [],
    durationSec: total,
    width: W,
    height: H,
    videoEncoder: venc?.encoder,
    audioEncoder: aargs[1],
    streamCopy: false,
  };
}
