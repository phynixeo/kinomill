// Audio tools (vocal separation & clean-up):
//  • AI (Demucs, optional pack): isolate vocals, remove vocals (karaoke), split into stems
//  • ffmpeg filters: reduce noise, clean up speech, reduce echo, normalize loudness
// Results are saved as audio files, or written back into the original video.
import fs from 'node:fs';
import path from 'node:path';
import type { AudioToolOp, AudioToolSpec, ConvertInput, ConvertJob } from '../../../shared/types';
import { defaultEdit, outputFromPreset } from '../../../shared/defaults';
import type { CoreModule, Ctx, JobQueue, JobRuntime } from '../context';
import { errMessage, fileExists, runCapture, uniquePath } from '../util';
import { probeFile } from '../convert/probe';
import {
  AI_OPS,
  LOUDNORM_TARGET,
  OP_LABEL,
  OP_STAGE,
  audioFormatArgs,
  cleanupChain,
  loudnormSecondPass,
  parseDemucsProgress,
  parseLoudnorm,
  videoContainerAudio,
} from './filters';
import {
  WARMUP_PY,
  aiEnv,
  aiPaths,
  demucsArgs,
  demucsInstallArgs,
  demucsOutput,
  findPython,
  hasNvidiaGpu,
  readAiConfig,
  torchInstallArgs,
  type AiConfig,
  type AiPaths,
} from './ai';

/* ───────── AI pack installation ───────── */

export interface InstallOptions {
  onStage(message: string): void;
  /** Stop after the virtual environment exists and pip works (used by tests). */
  stopAfterVenv?: boolean;
}

function tailOf(text: string, n = 4): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' ');
}

export async function installAiPack(p: AiPaths, opts: InstallOptions): Promise<AiConfig | null> {
  const py = await findPython();
  if (!py) {
    throw new Error('Python 3.10–3.13 was not found. Install Python 3.12 from python.org (tick "Add python.exe to PATH"), then try again.');
  }
  fs.mkdirSync(p.root, { recursive: true });
  if (!fileExists(p.python)) {
    opts.onStage(`Creating the AI environment (Python ${py.version})`);
    const r = await runCapture(py.cmd, [...py.args, '-m', 'venv', p.venv], { timeoutMs: 5 * 60_000 });
    if (r.code !== 0 || !fileExists(p.python)) throw new Error('Could not create the Python environment: ' + tailOf(r.stderr + r.stdout));
  }
  const pip = await runCapture(p.python, ['-m', 'pip', '--version'], { timeoutMs: 60_000 });
  if (pip.code !== 0) throw new Error('pip is not available in the AI environment: ' + tailOf(pip.stderr + pip.stdout));
  if (opts.stopAfterVenv) return null;

  const env = aiEnv(p);
  const cuda = await hasNvidiaGpu();
  opts.onStage(`Downloading PyTorch for ${cuda ? 'your NVIDIA GPU (about 3 GB)' : 'the CPU (about 250 MB)'} — this can take a while`);
  const t = await runCapture(p.python, torchInstallArgs(cuda), { timeoutMs: 2 * 3600_000, env });
  if (t.code !== 0) throw new Error('Installing PyTorch failed: ' + tailOf(t.stderr + t.stdout));

  opts.onStage('Installing Demucs');
  const d = await runCapture(p.python, demucsInstallArgs(), { timeoutMs: 3600_000, env });
  if (d.code !== 0) throw new Error('Installing Demucs failed: ' + tailOf(d.stderr + d.stdout));

  opts.onStage('Downloading the separation model');
  const w = await runCapture(p.python, ['-c', WARMUP_PY], { timeoutMs: 3600_000, env });
  const line = (w.stdout.split(/\r?\n/).find((l) => l.startsWith('VFAI ')) ?? '').slice(5);
  if (w.code !== 0 || !line) throw new Error('The AI model could not be loaded: ' + tailOf(w.stderr + w.stdout));
  const info = JSON.parse(line) as { torch: string; cuda: boolean };
  const cfg: AiConfig = { python: p.python, device: cuda && info.cuda ? 'cuda' : 'cpu', torch: info.torch, installedAt: Date.now() };
  fs.writeFileSync(p.config, JSON.stringify(cfg, null, 1));
  return cfg;
}

/* ───────── module ───────── */

const FORMAT_TARGET: Record<AudioToolSpec['outputFormat'], string> = { wav: 'wav', mp3: 'mp3', flac: 'flac', m4a: 'm4a' };

export function createAudioModule(ctx: Ctx, queue: JobQueue): CoreModule {
  const paths = aiPaths(ctx.paths.data);
  let config = readAiConfig(paths);
  let installing = false;

  const outName = (job: ConvertJob, label: string, ext: string) =>
    uniquePath(job.outputDir, `${job.inputs[0].info.name.replace(/\.[^.]+$/, '')} (${label})`, ext);

  /** Write a processed WAV/stream either as the chosen audio format or back into the video. */
  async function finish(rt: JobRuntime, job: ConvertJob, wav: string, label: string, keepVideo: boolean, from: number, to: number): Promise<string> {
    const src = job.inputs[0];
    if (keepVideo) {
      const vca = videoContainerAudio(path.extname(src.path));
      const out = outName(job, label, vca.ext);
      await rt.ffmpeg(['-i', src.path, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...vca.args, '-map_metadata', '0', '-shortest', out], {
        durationSec: src.info.duration,
        from,
        to,
        stage: 'Writing the new audio into the video',
      });
      return out;
    }
    const fmt = audioFormatArgs(job.audioTool!.outputFormat);
    const out = outName(job, label, fmt.ext);
    await rt.ffmpeg(['-i', wav, '-map', '0:a:0', ...fmt.args, out], { durationSec: src.info.duration, from, to, stage: `Saving ${label}` });
    return out;
  }

  async function runAi(job: ConvertJob, rt: JobRuntime, cfg: AiConfig, order: number, keepVideo: boolean): Promise<string[]> {
    const spec = job.audioTool!;
    const src = job.inputs[0];
    const ffmpeg = ctx.engines.require('ffmpeg');
    const wav = path.join(rt.tempDir, 'input.wav');
    await rt.ffmpeg(['-i', src.path, '-map', `0:a:${order}`, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav], {
      durationSec: src.info.duration,
      from: 0,
      to: 0.05,
      stage: 'Preparing the audio',
    });
    const sepDir = path.join(rt.tempDir, 'separated');
    const separate = async (device: 'cuda' | 'cpu') => {
      const stage = `${OP_STAGE[spec.op]} on the ${device === 'cuda' ? 'GPU' : 'CPU'}`;
      rt.progress(0.05, stage);
      return rt.run(cfg.python, demucsArgs({ input: wav, outDir: sepDir, twoStems: spec.op !== 'stems', device }), {
        env: aiEnv(paths, path.dirname(ffmpeg)),
        onLine: (line) => {
          const p = parseDemucsProgress(line);
          if (p !== null) rt.progress(0.05 + p * 0.8, stage);
        },
      });
    };
    let r = await separate(cfg.device);
    if (r.code !== 0 && cfg.device === 'cuda' && !rt.signal.aborted && /out of memory|CUDA|cuDNN|no kernel image/i.test(r.tail)) {
      ctx.toast('warning', 'The GPU could not run the AI model, so Kinomill is using the CPU instead (slower).');
      r = await separate('cpu');
    }
    if (r.code !== 0) throw new Error('AI separation failed: ' + tailOf(r.tail, 3));

    const stems = spec.op === 'vocals' ? ['vocals'] : spec.op === 'instrumental' ? ['no_vocals'] : ['vocals', 'drums', 'bass', 'other'];
    const outputs: string[] = [];
    for (let i = 0; i < stems.length; i++) {
      const file = demucsOutput(sepDir, stems[i]);
      if (!fileExists(file)) throw new Error(`The AI did not produce the "${stems[i]}" track`);
      const label = stems[i] === 'no_vocals' ? 'instrumental' : stems[i];
      const from = 0.85 + (0.15 * i) / stems.length;
      outputs.push(await finish(rt, job, file, label, keepVideo, from, from + 0.15 / stems.length));
    }
    return outputs;
  }

  async function runFfmpegOp(job: ConvertJob, rt: JobRuntime, op: AudioToolOp, order: number, keepVideo: boolean, basic: boolean): Promise<string[]> {
    const spec = job.audioTool!;
    const src = job.inputs[0];
    const ffmpeg = ctx.engines.require('ffmpeg');
    let chain: string;
    let from = 0;
    if (op === 'normalize') {
      rt.progress(0, 'Measuring loudness');
      let text = '';
      const r = await rt.run(ffmpeg, ['-hide_banner', '-nostats', '-i', src.path, '-map', `0:a:${order}`, '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'], {
        onLine: (l) => {
          text += l + '\n';
        },
      });
      const m = r.code === 0 ? parseLoudnorm(text) : null;
      if (!m) throw new Error('Could not measure the loudness (is the audio silent?)');
      chain = loudnormSecondPass(m);
      from = 0.45;
    } else {
      if (op === 'instrumental' && (src.info.audioTracks[order]?.channels ?? 2) < 2) {
        throw new Error('Removing vocals without the AI pack only works on stereo recordings. Install the AI audio pack for mono audio.');
      }
      chain = cleanupChain(op, spec.strength);
    }
    const filter = `[0:a:${order}]${chain}[aout]`;
    const label = basic ? 'instrumental, basic' : OP_LABEL[op];
    const stage = basic ? 'Removing vocals (basic method — install the AI pack for much better results)' : OP_STAGE[op];
    let out: string;
    let args: string[];
    if (keepVideo) {
      const vca = videoContainerAudio(path.extname(src.path));
      out = outName(job, label, vca.ext);
      args = ['-i', src.path, '-filter_complex', filter, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', ...vca.args, '-map_metadata', '0', out];
    } else {
      const fmt = audioFormatArgs(spec.outputFormat);
      out = outName(job, label, fmt.ext);
      args = ['-i', src.path, '-filter_complex', filter, '-map', '[aout]', '-vn', ...fmt.args, out];
    }
    await rt.ffmpeg(args, { durationSec: src.info.duration, from, to: 1, stage });
    return [out];
  }

  queue.registerRunner('audio', async (job, rt) => {
    const spec = job.audioTool;
    if (!spec) throw new Error('This job has no audio tool settings');
    const src = job.inputs[0];
    if (!src) throw new Error('No input file');
    if (!src.info.audioTracks.length) throw new Error(`"${src.info.name}" has no audio`);
    const order = Math.max(0, Math.min(src.edit.audioTrack, src.info.audioTracks.length - 1));
    const hasVideo = !!src.info.video && !src.info.isAudioOnly && !src.info.isImage;
    const keepVideo = spec.keepVideo && hasVideo && spec.op !== 'stems';
    try {
      if (AI_OPS.includes(spec.op)) {
        config = readAiConfig(paths);
        if (config) return await runAi(job, rt, config, order, keepVideo);
        if (spec.op === 'instrumental') return await runFfmpegOp(job, rt, 'instrumental', order, keepVideo, true);
        throw new Error('Isolating vocals and splitting into stems needs the AI audio pack. Install it from the Audio tools page.');
      }
      return await runFfmpegOp(job, rt, spec.op, order, keepVideo, false);
    } catch (e) {
      if (rt.signal.aborted) throw new Error('Canceled');
      throw new Error(errMessage(e));
    }
  });

  return {
    handlers: {
      'audio.process': async ({ inputs, spec, outputDir }) => {
        if (!inputs.length) throw new Error('Add at least one file');
        if (AI_OPS.includes(spec.op) && spec.op !== 'instrumental' && !readAiConfig(paths)) {
          throw new Error('Isolating vocals and splitting into stems needs the AI audio pack. Install it first (about 3 GB with GPU support).');
        }
        const ffprobe = ctx.engines.ffprobePath();
        if (!ffprobe) throw new Error('FFmpeg is not installed yet. Open Settings → Components and click Install.');
        const dir = outputDir || ctx.settings().convertDir;
        fs.mkdirSync(dir, { recursive: true });
        const probed: ConvertInput[] = [];
        const noAudio: string[] = [];
        for (const p of inputs) {
          const info = await probeFile(ffprobe, p);
          if (!info.audioTracks.length) noAudio.push(info.name);
          else probed.push({ path: p, edit: defaultEdit(), info });
        }
        if (!probed.length) throw new Error(`No audio found in ${noAudio.join(', ')}`);
        if (noAudio.length) ctx.toast('warning', `Skipped (no audio): ${noAudio.join(', ')}`);
        const output = outputFromPreset(FORMAT_TARGET[spec.outputFormat] ?? 'wav');
        return probed.map((ci) =>
          queue.enqueue({
            kind: 'audio',
            title: `${OP_LABEL[spec.op][0].toUpperCase()}${OP_LABEL[spec.op].slice(1)}: ${ci.info.name}`,
            inputs: [ci],
            join: false,
            output,
            outputDir: dir,
            audioTool: { ...spec, strength: Math.min(1, Math.max(0, spec.strength)) },
          }),
        );
      },
      'audio.installAi': () => {
        if (installing) return;
        if (readAiConfig(paths)) {
          ctx.toast('info', 'The AI audio pack is already installed.');
          return;
        }
        installing = true;
        ctx.capabilitiesChanged();
        ctx.busyChanged();
        void installAiPack(paths, { onStage: (m) => ctx.toast('info', m) })
          .then((cfg) => {
            config = cfg;
            ctx.toast('success', `AI audio pack installed (${cfg?.device === 'cuda' ? 'GPU accelerated' : 'CPU'}). You can now isolate vocals and split stems.`);
          })
          .catch((e) => ctx.toast('error', errMessage(e)))
          .finally(() => {
            installing = false;
            ctx.capabilitiesChanged();
            ctx.busyChanged();
          });
      },
    },
    capabilities: () => ({ aiAudioAvailable: !!(config ?? readAiConfig(paths)), aiAudioInstalling: installing }),
    isBusy: () => installing,
  };
}
