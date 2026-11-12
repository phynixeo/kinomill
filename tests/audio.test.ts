// Audio tools tests: filter builders + real ffmpeg processing for every
// non-AI operation, the karaoke fallback, writing back into the video, and the
// AI-pack installer up to venv creation (no multi-GB PyTorch download).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AudioToolSpec, ConvertJob } from '../shared/types';
import { Bus, type Ctx, type JobQueue, type JobRunner, type JobRuntime } from '../electron/core/context';
import { Engines } from '../electron/core/engines';
import {
  audioFormatArgs,
  basicKaraokeChain,
  cleanupChain,
  loudnormSecondPass,
  parseDemucsProgress,
  parseLoudnorm,
  videoContainerAudio,
} from '../electron/core/audio/filters';
import { aiPaths, demucsArgs, demucsOutput, parsePyVersion, torchInstallArgs, demucsInstallArgs, findPython } from '../electron/core/audio/ai';
import { createAudioModule, installAiPack } from '../electron/core/audio';

/* ───────── pure ───────── */

test('cleanupChain builds strength-scaled chains', () => {
  assert.match(cleanupChain('denoise', 0), /^afftdn=nr=6:/);
  assert.match(cleanupChain('denoise', 1), /^afftdn=nr=30:nf=-40:tn=1,afftdn=nr=18:nf=-50:tn=1$/);
  assert.ok(!/anlmdn/.test(cleanupChain('denoise', 1)), 'anlmdn crashes some ffmpeg builds');
  assert.match(cleanupChain('voice', 0.5), /highpass=f=80,afftdn=.*deesser=.*acompressor=.*loudnorm=/);
  assert.match(cleanupChain('dereverb', 0.5), /agate=/);
  assert.throws(() => cleanupChain('vocals', 1));
  assert.match(basicKaraokeChain(1), /pan=stereo\|c0=c0-1\*c1\|c1=c1-1\*c0/);
});

test('loudnorm JSON parsing and second pass', () => {
  const sample = `[Parsed_loudnorm_0 @ 0000]\n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-4.47",\n\t"input_lra" : "18.06",\n\t"input_thresh" : "-39.20",\n\t"output_i" : "-16.58",\n\t"target_offset" : "0.58"\n}`;
  const m = parseLoudnorm(sample)!;
  assert.equal(m.input_i, '-27.61');
  assert.match(loudnormSecondPass(m), /measured_I=-27\.61:measured_TP=-4\.47:measured_LRA=18\.06:measured_thresh=-39\.20:offset=0\.58:linear=true/);
  assert.equal(parseLoudnorm('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"0"}'), null);
});

test('format and container helpers', () => {
  assert.deepEqual(audioFormatArgs('mp3'), { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'] });
  assert.equal(audioFormatArgs('wav').ext, 'wav');
  assert.equal(videoContainerAudio('.WEBM').args[1], 'libopus');
  assert.equal(videoContainerAudio('.xyz').ext, 'mkv');
  assert.equal(parseDemucsProgress(' 45%|████▌     | 23.4/52.0 [00:05<00:06, 4.37seconds/s]'), 0.45);
  assert.equal(parseDemucsProgress('Separating track x.wav'), null);
});

test('demucs and pip command lines', () => {
  assert.deepEqual(demucsArgs({ input: 'in.wav', outDir: 'out', twoStems: true, device: 'cuda' }), [
    '-m', 'demucs.separate', '-n', 'htdemucs', '--two-stems', 'vocals', '-d', 'cuda', '-o', 'out', '--filename', '{stem}.{ext}', 'in.wav',
  ]);
  assert.ok(!demucsArgs({ input: 'a', outDir: 'o', twoStems: false, device: 'cpu' }).includes('--two-stems'));
  assert.equal(demucsOutput('o', 'no_vocals'), path.join('o', 'htdemucs', 'no_vocals.wav'));
  assert.ok(torchInstallArgs(true).includes('https://download.pytorch.org/whl/cu128'));
  assert.ok(torchInstallArgs(false).includes('https://download.pytorch.org/whl/cpu'));
  assert.ok(demucsInstallArgs().includes('demucs==4.1.0'));
  assert.equal(parsePyVersion('Python 3.12.4'), '3.12');
});

/* ───────── real processing ───────── */

const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const SKIP = !hasFfmpeg ? 'ffmpeg not installed' : process.env.VF_SKIP_E2E ? 'VF_SKIP_E2E set' : false;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-audio-'));

function ff(args: string[]): string {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
  return r.stderr;
}

function makeRuntime(name: string): JobRuntime & { stages: string[] } {
  const ac = new AbortController();
  const tempDir = fs.mkdtempSync(path.join(WORK, name + '-'));
  const rt = {
    signal: ac.signal,
    tempDir,
    stages: [] as string[],
    progress(p: number, stage?: string) {
      assert.ok(p >= 0 && p <= 1.0001, `progress ${p}`);
      if (stage && rt.stages[rt.stages.length - 1] !== stage) rt.stages.push(stage);
    },
    ffmpeg(args: string[], o: { durationSec: number; from?: number; to?: number; stage?: string }) {
      return new Promise<void>((resolve, reject) => {
        const c = spawn('ffmpeg', ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args]);
        let err = '';
        c.stdout.on('data', (d: Buffer) => {
          const m = /out_time_us=(\d+)/.exec(d.toString());
          if (m && o.durationSec > 0) rt.progress((o.from ?? 0) + Math.min(1, Number(m[1]) / 1e6 / o.durationSec) * ((o.to ?? 1) - (o.from ?? 0)), o.stage);
        });
        c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
        c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split(/\r?\n/).slice(-4).join('\n')))));
      });
    },
    run(cmd: string, args: string[], o?: { onLine?: (l: string) => void; env?: NodeJS.ProcessEnv }) {
      return new Promise<{ code: number | null; tail: string }>((resolve, reject) => {
        const c = spawn(cmd, args, { env: o?.env });
        let tail = '';
        const onData = (d: Buffer) => {
          const s = d.toString();
          tail = (tail + s).slice(-8000);
          s.split(/\r?\n|\r/).forEach((l) => l.length && o?.onLine?.(l));
        };
        c.stdout.on('data', onData);
        c.stderr.on('data', onData);
        c.on('error', reject);
        c.on('close', (code) => resolve({ code, tail }));
      });
    },
  };
  return rt;
}

async function setup() {
  const engines = new Engines(path.join(process.env.APPDATA ?? os.homedir(), 'Kinomill', 'bin'), new Bus());
  await engines.refresh();
  const toasts: string[] = [];
  const ctx = {
    engines,
    paths: { data: path.join(WORK, 'data'), bin: '', temp: path.join(WORK, 'tmp'), cookies: '', archive: '' },
    settings: () => ({ convertDir: path.join(WORK, 'out') }),
    toast: (_l: string, m: string) => toasts.push(m),
    capabilitiesChanged: () => undefined,
    busyChanged: () => undefined,
  } as unknown as Ctx;
  let runner: JobRunner | undefined;
  const queue: JobQueue = {
    registerRunner: (kind, r) => {
      if (kind === 'audio') runner = r;
    },
    enqueue: (j) => ({ ...j, id: 'job', status: 'queued', progress: 0, createdAt: Date.now() }) as ConvertJob,
  };
  const mod = createAudioModule(ctx, queue);
  return { mod, runner: runner!, toasts };
}

/** Video with a stereo track: 250 Hz on the left, 3 kHz on the right, a 1 kHz "voice" in the centre, plus noise. */
function makeMedia(): { video: string; music: string } {
  const video = path.join(WORK, 'talk.mp4');
  const music = path.join(WORK, 'song.flac');
  if (!fs.existsSync(video)) {
    const graph =
      'sine=f=1000:d=10[c];sine=f=250:d=10[l];sine=f=3000:d=10[r];anoisesrc=d=10:c=white:a=0.05[n];' +
      '[c]asplit[c1][c2];[l][c1]amix=inputs=2:normalize=0[L];[r][c2]amix=inputs=2:normalize=0[R];' +
      '[L][R]join=inputs=2:channel_layout=stereo[s];[s][n]amix=inputs=2:normalize=0,volume=0.3[aout]';
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=10', '-filter_complex', graph, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '192k', '-shortest', video]);
    ff(['-i', video, '-vn', '-c:a', 'flac', music]);
  }
  return { video, music };
}

/** RMS level (dB) of one channel in a frequency band. */
function bandLevel(file: string, freq: number, channel: 0 | 1): number {
  const err = ff(['-i', file, '-af', `pan=mono|c0=c${channel},bandpass=f=${freq}:width_type=q:w=8,astats=metadata=0:measure_overall=RMS_level:measure_perchannel=0`, '-f', 'null', '-']);
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(err);
  return m && m[1] !== '-inf' ? Number(m[1]) : -200;
}

function integratedLufs(file: string): number {
  const err = ff(['-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const all = [...err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  return Number(all[all.length - 1][1]);
}

async function process1(mod: Awaited<ReturnType<typeof setup>>['mod'], runner: JobRunner, file: string, spec: AudioToolSpec, name: string): Promise<{ outs: string[]; stages: string[] }> {
  const jobs = (await mod.handlers['audio.process']!({ inputs: [file], spec, outputDir: path.join(WORK, 'out') })) as ConvertJob[];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'audio');
  const rt = makeRuntime(name);
  const outs = await runner(jobs[0], rt);
  for (const o of outs) assert.ok(fs.statSync(o).size > 1000, `${o} written`);
  return { outs, stages: rt.stages };
}

test('every ffmpeg-only operation produces audio', { skip: SKIP, timeout: 300_000 }, async () => {
  const { mod, runner } = await setup();
  const { music } = makeMedia();
  const noiseBefore = bandLevel(music, 6000, 0);
  for (const op of ['denoise', 'voice', 'dereverb'] as const) {
    const { outs, stages } = await process1(mod, runner, music, { op, strength: 0.7, outputFormat: 'flac', keepVideo: false }, op);
    assert.ok(outs[0].endsWith('.flac'));
    assert.ok(stages.length > 0);
    if (op === 'denoise') {
      const after = bandLevel(outs[0], 6000, 0);
      assert.ok(after < noiseBefore - 6, `noise band ${noiseBefore.toFixed(1)} → ${after.toFixed(1)} dB`);
    }
  }
});

test('normalize hits -16 LUFS (two-pass loudnorm)', { skip: SKIP, timeout: 300_000 }, async () => {
  const { mod, runner } = await setup();
  const { music } = makeMedia();
  const before = integratedLufs(music);
  const { outs } = await process1(mod, runner, music, { op: 'normalize', strength: 1, outputFormat: 'wav', keepVideo: false }, 'norm');
  const after = integratedLufs(outs[0]);
  assert.ok(Math.abs(after - -16) < 1, `loudness ${before} → ${after} LUFS`);
});

test('instrumental without the AI pack uses centre cancellation', { skip: SKIP, timeout: 300_000 }, async () => {
  const { mod, runner } = await setup();
  const { music } = makeMedia();
  const { outs, stages } = await process1(mod, runner, music, { op: 'instrumental', strength: 1, outputFormat: 'wav', keepVideo: false }, 'kar');
  assert.ok(stages.some((s) => /basic method/.test(s)), stages.join(' | '));
  assert.match(path.basename(outs[0]), /instrumental, basic/);
  const voiceBefore = bandLevel(music, 1000, 0);
  const voiceAfter = bandLevel(outs[0], 1000, 0);
  const sideBefore = bandLevel(music, 3000, 1);
  const sideAfter = bandLevel(outs[0], 3000, 1);
  assert.ok(voiceAfter < voiceBefore - 20, `centre "voice" ${voiceBefore.toFixed(1)} → ${voiceAfter.toFixed(1)} dB`);
  assert.ok(sideAfter > sideBefore - 3, `side instrument ${sideBefore.toFixed(1)} → ${sideAfter.toFixed(1)} dB`);
});

test('keepVideo writes the processed audio back into the video', { skip: SKIP, timeout: 300_000 }, async () => {
  const { mod, runner } = await setup();
  const { video } = makeMedia();
  const { outs } = await process1(mod, runner, video, { op: 'denoise', strength: 0.8, outputFormat: 'mp3', keepVideo: true }, 'keep');
  assert.ok(outs[0].endsWith('.mp4'), outs[0]);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'compact', outs[0]], { encoding: 'utf8' });
  assert.match(r.stdout, /codec_name=h264\|codec_type=video/);
  assert.match(r.stdout, /codec_name=aac\|codec_type=audio/);
  assert.ok(Math.abs(Number(/duration=([\d.]+)/.exec(r.stdout)![1]) - 10) < 0.2);
  // video stream copied untouched
  const src = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=bit_rate,nb_frames', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout;
  const dst = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=bit_rate,nb_frames', '-of', 'csv=p=0', outs[0]], { encoding: 'utf8' }).stdout;
  assert.equal(dst.split(',')[1], src.split(',')[1]);
});

test('vocals / stems without the AI pack are refused with guidance', { skip: SKIP, timeout: 60_000 }, async () => {
  const { mod } = await setup();
  const { music } = makeMedia();
  await assert.rejects(
    async () => mod.handlers['audio.process']!({ inputs: [music], spec: { op: 'vocals', strength: 1, outputFormat: 'wav', keepVideo: false }, outputDir: WORK }),
    /needs the AI audio pack/,
  );
  assert.equal(mod.capabilities!().aiAudioAvailable, false);
});

test('files without audio are rejected', { skip: SKIP, timeout: 60_000 }, async () => {
  const { mod } = await setup();
  const silent = path.join(WORK, 'silent.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', silent]);
  await assert.rejects(
    async () => mod.handlers['audio.process']!({ inputs: [silent], spec: { op: 'denoise', strength: 0.5, outputFormat: 'wav', keepVideo: false }, outputDir: WORK }),
    /No audio found/,
  );
});

test('AI pack installer creates a venv with pip (no PyTorch download)', { skip: SKIP || (process.env.VF_SKIP_VENV ? 'VF_SKIP_VENV set' : false), timeout: 300_000 }, async (t) => {
  const py = await findPython();
  if (!py) {
    t.skip('no suitable Python on this machine');
    return;
  }
  const p = aiPaths(path.join(WORK, 'ai-data'));
  const stages: string[] = [];
  const cfg = await installAiPack(p, { onStage: (m) => stages.push(m), stopAfterVenv: true });
  assert.equal(cfg, null);
  assert.ok(fs.existsSync(p.python), 'venv python exists');
  assert.ok(stages.some((s) => /Creating the AI environment/.test(s)), stages.join(' | '));
  const pip = spawnSync(p.python, ['-m', 'pip', '--version'], { encoding: 'utf8' });
  assert.equal(pip.status, 0);
  assert.match(pip.stdout, /pip \d+/);
});
