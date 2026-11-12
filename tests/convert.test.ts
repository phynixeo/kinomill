// Converter engine tests: pure command-builder checks plus real ffmpeg runs
// through the job queue. Needs ffmpeg + ffprobe on PATH (or in the managed bin dir).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConvertInput, ConvertJob, EditSpec, MediaInfo, OutputSpec, Settings } from '../shared/types';
import { OUTPUT_TARGETS } from '../shared/presets';
import { defaultEdit, defaultSettings, outputFromPreset } from '../shared/defaults';
import { Bus, type Ctx } from '../electron/core/context';
import { Engines } from '../electron/core/engines';
import { MediaServer } from '../electron/core/mediaServer';
import { runCapture } from '../electron/core/util';
import { createConvertModule } from '../electron/core/convert';
import { atempoChain, assColor, buildConvertPlan, keepSegments, outputDims, qualityValue, streamCopyDecision, type BuildEnv } from '../electron/core/convert/ffmpegArgs';
import { mediaInfoFromProbe, normRotation } from '../electron/core/convert/probe';
import { unionCrops } from '../electron/core/convert/crop';

/* ───────────────────────── pure unit tests ───────────────────────── */

const ENV: BuildEnv = { hwEncoders: ['h264_nvenc'], hwPref: 'auto', nullDevice: 'NUL', passLog: 'ffpass' };

function fakeInfo(p: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: 'C:\\in\\a.mp4',
    name: 'a.mp4',
    size: 1000,
    duration: 10,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: { index: 0, codec: 'h264', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p', sar: '1:1' },
    audioTracks: [{ index: 1, order: 0, codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 128000 }],
    subtitleTracks: [],
    isImage: false,
    isAudioOnly: false,
    browserPlayable: true,
    ...p,
  };
}
const ri = (edit: Partial<EditSpec> = {}, info: Partial<MediaInfo> = {}) => {
  const e = { ...defaultEdit(), ...edit };
  return { path: 'C:\\in\\a.mp4', edit: e, info: fakeInfo(info), crop: e.crop };
};

describe('pure builders', () => {
  test('keepSegments complements, merges and clamps cuts', () => {
    assert.deepEqual(keepSegments([], 10), [{ start: 0, end: 10 }]);
    assert.deepEqual(keepSegments([{ start: 2, end: 4 }, { start: 3, end: 5 }, { start: 8, end: 20 }], 10), [
      { start: 0, end: 2 },
      { start: 5, end: 8 },
    ]);
    assert.deepEqual(keepSegments([{ start: 0, end: 10 }], 10), []);
  });
  test('atempo chains stay inside the filter range', () => {
    assert.deepEqual(atempoChain(2), ['atempo=2']);
    assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
    assert.deepEqual(atempoChain(1), []);
  });
  test('assColor converts RGB to ASS BGR', () => assert.equal(assColor('#FF8000'), '&H000080FF'));
  test('quality slider maps to sane crf', () => {
    assert.equal(qualityValue('libx264', 70), 23);
    assert.ok(qualityValue('mpeg4', 100) <= 2);
  });
  test('outputDims follows source orientation and h263 sizes', () => {
    assert.deepEqual(outputDims({ codec: 'h264', width: 1920, height: 1080, fit: 'pad' }, { w: 720, h: 1280 }).dims, { w: 1080, h: 1920 });
    assert.deepEqual(outputDims({ codec: 'h263', width: 300, height: 250, fit: 'pad' }, { w: 1280, h: 720 }).dims, { w: 352, h: 288 });
    assert.deepEqual(outputDims({ codec: 'gif', width: 480, fit: 'pad' }, { w: 720, h: 1280 }).dims, { w: 270, h: 480 });
  });
  test('rotation normalization', () => {
    assert.equal(normRotation(-90), 270);
    assert.equal(normRotation(450), 90);
  });
  test('probe parsing swaps dims for rotated phone video', () => {
    const info = mediaInfoFromProbe('C:\\x.mp4', {
      format: { format_name: 'mov,mp4', duration: '5.0' },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', side_data_list: [{ rotation: -90 }] }],
    }, 10);
    assert.equal(info.video?.width, 720);
    assert.equal(info.video?.height, 1280);
    assert.equal(info.video?.rotation, 90);
  });
  test('stream copy only when nothing needs re-encoding', () => {
    const out = outputFromPreset('mp4', 'source');
    assert.deepEqual(streamCopyDecision([ri()], out), { video: true, audio: true });
    assert.equal(streamCopyDecision([ri({ cuts: [{ start: 1, end: 2 }] })], out), null);
    assert.equal(streamCopyDecision([ri()], outputFromPreset('mp4', '720p')), null);
  });
  test('cuts produce split/trim/concat and fades use the output timeline', () => {
    const plan = buildConvertPlan({
      inputs: [ri({ cuts: [{ start: 2, end: 4 }, { start: 6, end: 7 }], fadeOut: 1 })],
      output: outputFromPreset('mp4', '720p'),
      outPath: 'C:\\o\\x.mp4',
      env: ENV,
    });
    const graph = plan.passes[0].args[plan.passes[0].args.indexOf('-filter_complex') + 1];
    assert.match(graph, /split=3/);
    assert.match(graph, /concat=n=3:v=1:a=0/);
    assert.match(graph, /fade=t=out:st=6:d=1/);
    assert.equal(plan.durationSec, 7);
    assert.ok(plan.passes[0].args.includes('h264_nvenc'));
  });
  test('single trim uses fast input seeking', () => {
    const plan = buildConvertPlan({ inputs: [ri({ cuts: [{ start: 0, end: 3 }] })], output: outputFromPreset('mp4', '720p'), outPath: 'C:\\o\\x.mp4', env: ENV });
    const a = plan.passes[0].args;
    assert.deepEqual(a.slice(0, 4), ['-ss', '3', '-t', '7']);
  });
  test('target size forces two-pass with a computed bitrate (software encoder)', () => {
    const out = { ...outputFromPreset('mp4', '720p'), hwAccel: false, targetSizeMB: 5 };
    const plan = buildConvertPlan({ inputs: [ri()], output: out, outPath: 'C:\\o\\x.mp4', env: ENV });
    assert.equal(plan.passes.length, 2);
    assert.ok(plan.passes[0].args.includes('-pass'));
    const br = plan.passes[1].args[plan.passes[1].args.indexOf('-b:v') + 1];
    assert.ok(parseInt(br) > 3500 && parseInt(br) < 4100, br);
  });
  test('disc targets and photos are rejected', () => {
    assert.throws(() => buildConvertPlan({ inputs: [ri()], output: outputFromPreset('dvd'), outPath: 'C:\\o\\x.vob', env: ENV }), /disc/);
    assert.throws(() => buildConvertPlan({ inputs: [ri({}, { isImage: true })], output: outputFromPreset('mp4'), outPath: 'C:\\o\\x.mp4', env: ENV }), /slideshow/);
  });
  test('jobs running at shutdown come back as interrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-queue-'));
    const job = { id: 'j1', kind: 'convert', title: 't', inputs: [], join: false, output: outputFromPreset('mp4'), outputDir: dir, status: 'running', progress: 0.4, createdAt: 1 };
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([job]));
    const { Queue } = await import('../electron/core/convert/queue');
    const q = new Queue({ paths: { data: dir }, bus: new Bus(), settings: () => ({ maxConcurrentConversions: 1 }) } as unknown as Ctx);
    assert.equal(q.list()[0].status, 'failed');
    assert.match(q.list()[0].error ?? '', /Interrupted/);
  });
  test('black bar union ignores dark scenes', () => {
    assert.deepEqual(unionCrops([{ x: 0, y: 60, w: 640, h: 360 }, { x: 0, y: 62, w: 640, h: 356 }], 640, 480), { x: 0, y: 60, w: 640, h: 360 });
    assert.equal(unionCrops([{ x: 0, y: 0, w: 640, h: 480 }], 640, 480), null);
    assert.equal(unionCrops([{ x: 300, y: 200, w: 20, h: 20 }], 640, 480), null);
  });
});

/* ───────────────────────── real ffmpeg integration ───────────────────────── */

const ROOT = path.join(os.tmpdir(), 'kinomill-convert-test');
const FIX = path.join(ROOT, 'fixtures');
const OUT = path.join(ROOT, 'out');

let ffmpeg = '';
let ffprobe = '';
let mod: ReturnType<typeof createConvertModule>;
let bus: Bus;
let media: MediaServer;
let settings: Settings;
let hwEncoders: string[] = [];

async function ff(args: string[]): Promise<void> {
  const r = await runCapture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

interface ProbeOut {
  duration: number;
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; tags?: Record<string, string> }[];
}
async function probe(file: string): Promise<ProbeOut> {
  const r = await runCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  assert.equal(r.code, 0, `ffprobe failed for ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return { duration: Number(j.format.duration), streams: j.streams };
}
const vstream = (p: ProbeOut) => p.streams.find((s) => s.codec_type === 'video');
const astream = (p: ProbeOut) => p.streams.find((s) => s.codec_type === 'audio');

function waitJob(id: string): Promise<ConvertJob> {
  return new Promise((resolve) => {
    const done = (j: ConvertJob) => ['completed', 'failed', 'canceled'].includes(j.status);
    const cur = mod.state!().jobs!.find((j) => j.id === id);
    if (cur && done(cur)) return resolve(cur);
    const off = bus.on((ev) => {
      if (ev.type === 'job' && ev.job.id === id && done(ev.job)) {
        off();
        resolve(ev.job);
      }
    });
  });
}

async function convert(inputs: ConvertInput[], output: OutputSpec, opts: { join?: boolean; name?: string } = {}): Promise<ConvertJob[]> {
  const jobs = (await mod.handlers['convert.add']!({ inputs, join: !!opts.join, output, outputDir: OUT, outputName: opts.name })) as ConvertJob[];
  const res = await Promise.all(jobs.map((j) => waitJob(j.id)));
  for (const j of res) assert.equal(j.status, 'completed', `${j.title}: ${j.error}`);
  return res;
}

async function info(file: string): Promise<MediaInfo> {
  const [i] = (await mod.handlers['convert.probe']!({ paths: [file] })) as MediaInfo[];
  return i;
}
const input = async (file: string, edit: Partial<EditSpec> = {}): Promise<ConvertInput> => ({ path: file, edit: { ...defaultEdit(), ...edit }, info: await info(file) });
const close = (a: number, b: number, tol = 0.25) => assert.ok(Math.abs(a - b) <= tol, `expected ~${b}, got ${a}`);

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of [FIX, OUT, path.join(ROOT, 'data'), path.join(ROOT, 'temp'), path.join(FIX, 'DVD', 'VIDEO_TS')]) fs.mkdirSync(d, { recursive: true });
  bus = new Bus();
  const engines = new Engines(path.join(ROOT, 'bin'), bus);
  await engines.refresh();
  ffmpeg = engines.require('ffmpeg');
  ffprobe = engines.ffprobePath()!;
  media = new MediaServer(engines);
  await media.start();
  settings = { ...defaultSettings(ROOT, path.sep), convertDir: OUT, maxConcurrentConversions: 4, hwAccel: 'auto' };
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const ctx: Ctx = {
    host: {} as Ctx['host'],
    paths: { data: path.join(ROOT, 'data'), bin: path.join(ROOT, 'bin'), temp: path.join(ROOT, 'temp'), cookies: '', archive: '' },
    bus,
    settings: () => settings,
    updateSettings: (p) => (settings = { ...settings, ...p }),
    engines,
    media,
    privacy: { isHidden: () => false },
    log: () => undefined,
    toast: () => undefined,
    notifyDone: () => undefined,
    busyChanged: () => undefined,
    capabilitiesChanged: () => ready(),
  };
  mod = createConvertModule(ctx);
  await readyP;
  hwEncoders = mod.capabilities!().hwEncoders ?? [];

  const f = (n: string) => path.join(FIX, n);
  fs.writeFileSync(f('sub.srt'), '1\n00:00:00,500 --> 00:00:03,000\nHello from Kinomill\n\n2\n00:00:04,000 --> 00:00:07,000\nSecond line\n');
  await Promise.all([
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:d=10:sample_rate=48000', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('main.mp4')]),
    ff([
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-f', 'lavfi', '-i', 'sine=f=880:d=8', '-i', f('sub.srt'),
      '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', f('multi.mkv'),
    ]),
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-vf', 'pad=640:480:0:60:black', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('letterbox.mp4')]),
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('portrait.mp4')]),
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('short.mp4')]),
    ff(['-f', 'lavfi', '-i', 'sine=f=330:d=5', '-c:a', 'libmp3lame', '-b:a', '128k', f('audio.mp3')]),
    ff(['-f', 'lavfi', '-i', 'sine=f=550:d=3', '-c:a', 'libmp3lame', f('music.mp3')]),
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x1200', '-frames:v', '1', f('photo1.png')]),
    ff(['-f', 'lavfi', '-i', 'mandelbrot=s=800x1200', '-frames:v', '1', f('photo2.jpg')]),
    ff(['-f', 'lavfi', '-i', 'testsrc=s=1920x1080', '-frames:v', '1', f('photo3.jpg')]),
    ff(['-f', 'lavfi', '-i', 'color=c=red@0.6:s=200x80,format=rgba', '-frames:v', '1', f('logo.png')]),
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x576:r=25:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-target', 'pal-dvd', '-aspect', '16:9', path.join(FIX, 'DVD', 'VIDEO_TS', 'VTS_01_1.VOB')]),
  ]);
  // phone video: landscape pixels + 90° display rotation
  await ff(['-display_rotation:v:0', '-90', '-i', f('short.mp4'), '-c', 'copy', f('rotated.mp4')]);
});

after(async () => {
  await mod?.dispose?.();
  media?.stop();
});

const F = (n: string) => path.join(FIX, n);

describe('real conversions', { concurrency: 4 }, () => {
  test('probe reads tracks, rotation and DVD folders', async () => {
    const m = await info(F('multi.mkv'));
    assert.equal(m.audioTracks.length, 2);
    assert.equal(m.audioTracks[1].language, 'fra');
    assert.equal(m.subtitleTracks.length, 1);
    assert.equal(m.browserPlayable, false);
    const r = await info(F('rotated.mp4'));
    assert.equal(r.video?.width, 360);
    assert.equal(r.video?.height, 640);
    const a = await info(F('audio.mp3'));
    assert.ok(a.isAudioOnly && a.browserPlayable);
    const p = await info(F('photo1.png'));
    assert.ok(p.isImage);
    const d = await info(path.join(FIX, 'DVD'));
    assert.match(d.path, /^concat:/);
    close(d.duration, 4, 0.6);
  });

  test('cuts + 720p preset → exact duration', async () => {
    const [j] = await convert([await input(F('main.mp4'), { cuts: [{ start: 2, end: 4 }, { start: 6, end: 7 }] })], outputFromPreset('mp4', '720p'));
    const p = await probe(j.outputPaths![0]);
    close(p.duration, 7, 0.15);
    assert.equal(vstream(p)?.width, 1280);
    assert.equal(astream(p)?.codec_name, 'aac');
  });

  test('crop + rotate 90 + flip, same as source', async () => {
    const [j] = await convert(
      [await input(F('main.mp4'), { crop: { x: 100, y: 100, w: 640, h: 360 }, rotate: 90, flipH: true })],
      outputFromPreset('mp4', 'source'),
      { name: 'crop-rotate' },
    );
    const v = vstream(await probe(j.outputPaths![0]))!;
    assert.equal(v.width, 360);
    assert.equal(v.height, 640);
  });

  test('auto black-bar removal', async () => {
    const [j] = await convert([await input(F('letterbox.mp4'), { autoRemoveBlackBars: true })], outputFromPreset('mkv', 'source'));
    const v = vstream(await probe(j.outputPaths![0]))!;
    assert.equal(v.width, 640);
    assert.equal(v.height, 360);
  });

  test('pad 4:3 into 1080p box (add black bars)', async () => {
    const [j] = await convert([await input(F('letterbox.mp4'))], outputFromPreset('mp4', '1080p'), { name: 'padded' });
    const v = vstream(await probe(j.outputPaths![0]))!;
    assert.equal(v.width, 1920);
    assert.equal(v.height, 1080);
  });

  test('rotated phone video is upright; portrait keeps orientation in a landscape preset', async () => {
    const [a] = await convert([await input(F('rotated.mp4'))], outputFromPreset('mp4', '720p'), { name: 'rot' });
    const va = vstream(await probe(a.outputPaths![0]))!;
    assert.equal(va.width, 720);
    assert.equal(va.height, 1280);
    const [b] = await convert([await input(F('portrait.mp4'))], outputFromPreset('android', 'phone-720'), { name: 'portrait' });
    const vb = vstream(await probe(b.outputPaths![0]))!;
    assert.deepEqual([vb.width, vb.height], [720, 1280]);
  });

  test('subtitle burn-in: external .srt and embedded track', async () => {
    const style = { fontName: 'Arial', fontSize: 28, primaryColor: '#FFFF00', outlineColor: '#000000', outline: 2, bold: true, position: 'bottom' as const, marginV: 20 };
    const [a] = await convert([await input(F('main.mp4'), { subtitles: { ...style, path: F('sub.srt') } })], outputFromPreset('mp4', '720p'), { name: 'subs-ext' });
    const [b] = await convert([await input(F('multi.mkv'), { subtitles: { ...style, streamOrder: 0 } })], outputFromPreset('mp4', 'source'), { name: 'subs-emb' });
    // the burned frame must differ from the plain source frame
    const plain = await media.frame(F('main.mp4'), 1.5, 320);
    const burned = await media.frame(a.outputPaths![0], 1.5, 320);
    assert.notDeepEqual(plain, burned);
    assert.ok(fs.statSync(b.outputPaths![0]).size > 0);
  });

  test('watermarks: text and image', async () => {
    const t: OutputSpec = { ...outputFromPreset('mp4', '720p'), watermark: { type: 'text', text: 'Kinomill 100% ©', position: 'br', opacity: 0.8, scale: 0.06, margin: 20, color: '#FFFFFF' } };
    const i: OutputSpec = { ...outputFromPreset('mp4', '720p'), watermark: { type: 'image', imagePath: F('logo.png'), position: 'tl', opacity: 0.5, scale: 0.2, margin: 10 } };
    await convert([await input(F('short.mp4'))], t, { name: 'wm-text' });
    await convert([await input(F('short.mp4'))], i, { name: 'wm-image' });
  });

  test('speed, fades, volume, loudnorm, audio track pick', async () => {
    const [fast] = await convert([await input(F('main.mp4'), { speed: 2, fadeIn: 1, fadeOut: 1, volume: 1.5 })], outputFromPreset('mp4', '720p'), { name: 'fast' });
    close((await probe(fast.outputPaths![0])).duration, 5, 0.2);
    const [slow] = await convert([await input(F('short.mp4'), { speed: 0.25, normalizeAudio: true })], outputFromPreset('mp4', 'source'), { name: 'slow' });
    close((await probe(slow.outputPaths![0])).duration, 8, 0.3);
    const [fra] = await convert([await input(F('multi.mkv'), { audioTrack: 1 })], outputFromPreset('mp3', '192'), { name: 'fra' });
    close((await probe(fra.outputPaths![0])).duration, 8, 0.2);
    const [mute] = await convert([await input(F('short.mp4'), { audioTrack: -1 })], outputFromPreset('mp4', '720p'), { name: 'mute' });
    assert.equal(astream(await probe(mute.outputPaths![0])), undefined);
  });

  test('join 3 mixed inputs (video, mkv 2nd audio track, mp3)', async () => {
    const [j] = await convert(
      [await input(F('main.mp4'), { cuts: [{ start: 0, end: 5 }] }), await input(F('multi.mkv'), { audioTrack: 1 }), await input(F('audio.mp3'))],
      outputFromPreset('mp4', '720p'),
      { join: true, name: 'joined' },
    );
    const p = await probe(j.outputPaths![0]);
    close(p.duration, 18, 0.3);
    assert.equal(vstream(p)?.width, 1280);
    assert.ok(astream(p));
  });

  test('two-pass bitrate and target size', async () => {
    const two: OutputSpec = { ...outputFromPreset('mp4', '720p'), hwAccel: false, video: { codec: 'h264', width: 1280, height: 720, bitrateKbps: 1500, twoPass: true, fit: 'pad' } };
    await convert([await input(F('short.mp4'))], two, { name: 'twopass' });
    const size: OutputSpec = { ...outputFromPreset('mp4', '720p'), hwAccel: false, targetSizeMB: 2 };
    const [j] = await convert([await input(F('main.mp4'))], size, { name: 'target2mb' });
    const bytes = fs.statSync(j.outputPaths![0]).size;
    const want = 2 * 1024 * 1024;
    assert.ok(Math.abs(bytes - want) / want < 0.1, `size ${bytes} vs ${want}`);
  });

  test('NVENC hardware encode (when available)', async (t) => {
    if (!hwEncoders.includes('h264_nvenc')) return t.skip('no NVENC on this PC');
    const [j] = await convert([await input(F('main.mp4'))], { ...outputFromPreset('mp4', '1080p'), hwAccel: true }, { name: 'nvenc' });
    const v = vstream(await probe(j.outputPaths![0]))!;
    assert.match(v.tags?.encoder ?? '', /nvenc/i);
    const [h] = await convert([await input(F('short.mp4'))], { ...outputFromPreset('sony', 'ps5'), hwAccel: true }, { name: 'nvenc-hevc' });
    assert.equal(vstream(await probe(h.outputPaths![0]))?.codec_name, 'hevc');
  });

  test('GIF, HTML5, stream copy, audio extract, DVD rip', async () => {
    const [g] = await convert([await input(F('main.mp4'), { cuts: [{ start: 3, end: 10 }] })], outputFromPreset('gif', 'small'), { name: 'clip' });
    const pg = await probe(g.outputPaths![0]);
    assert.equal(vstream(pg)?.codec_name, 'gif');
    assert.equal(vstream(pg)?.width, 320);
    const [h] = await convert([await input(F('short.mp4'))], outputFromPreset('html5', '360p'), { name: 'web' });
    assert.equal(h.outputPaths!.length, 4);
    for (const o of h.outputPaths!) assert.ok(fs.existsSync(o), o);
    assert.match(fs.readFileSync(h.outputPaths![3], 'utf8'), /web\.webm/);
    const t0 = Date.now();
    const [c] = await convert([await input(F('multi.mkv'))], outputFromPreset('mp4', 'source'), { name: 'remux' });
    assert.ok(Date.now() - t0 < 3000, 'remux should be near-instant');
    const pc = await probe(c.outputPaths![0]);
    assert.equal(vstream(pc)?.codec_name, 'h264');
    close(pc.duration, 8, 0.2);
    const [m] = await convert([await input(F('main.mp4'))], outputFromPreset('mp3', '320'), { name: 'extract' });
    assert.equal(astream(await probe(m.outputPaths![0]))?.codec_name, 'mp3');
    const [d] = await convert([await input(path.join(FIX, 'DVD'))], outputFromPreset('mp4', '480p'), { name: 'dvdrip' });
    close((await probe(d.outputPaths![0])).duration, 4, 0.6);
  });

  test('photo slideshow with pan/zoom, fade transitions and looped music', async () => {
    const spec = { images: [F('photo1.png'), F('photo2.jpg'), F('photo3.jpg')], secondsPerImage: 2, transition: 'fade' as const, transitionSeconds: 0.5, panZoom: true, music: [F('music.mp3')], width: 1280, height: 720, fps: 25, shuffle: false };
    const job = (await mod.handlers['convert.slideshow']!({ spec, output: outputFromPreset('mp4', '720p'), outputDir: OUT, outputName: 'slides' })) as ConvertJob;
    const done = await waitJob(job.id);
    assert.equal(done.status, 'completed', done.error);
    const p = await probe(done.outputPaths![0]);
    close(p.duration, 6.5, 0.2);
    assert.equal(vstream(p)?.width, 1280);
    close(Number((p.streams.find((s) => s.codec_type === 'audio') as { duration?: string } | undefined)?.duration ?? p.duration), 6.5, 0.3);
  });

  test('progress is reported, cancel removes the partial output', async () => {
    const out: OutputSpec = { ...outputFromPreset('mp4', '1080p'), hwAccel: false, video: { codec: 'hevc', width: 3840, height: 2160, quality: 95, fit: 'pad' } };
    const [job] = (await mod.handlers['convert.add']!({ inputs: [await input(F('main.mp4'))], join: false, output: out, outputDir: OUT, outputName: 'to-cancel' })) as ConvertJob[];
    let maxProgress = 0;
    let sawSpeed = false;
    const offP = bus.on((ev) => {
      if (ev.type === 'job' && ev.job.id === job.id && ev.job.status === 'running') {
        maxProgress = Math.max(maxProgress, ev.job.progress);
        if (ev.job.speed) sawSpeed = true;
      }
    });
    await new Promise<void>((r) => {
      const off = bus.on((ev) => {
        if (ev.type === 'job' && ev.job.id === job.id && ev.job.status === 'running' && ev.job.progress > 0) {
          off();
          setTimeout(r, 300);
        }
      });
    });
    await mod.handlers['convert.cancel']!({ ids: [job.id] });
    const done = await waitJob(job.id);
    offP();
    assert.equal(done.status, 'canceled');
    assert.ok(maxProgress > 0 && maxProgress < 1, `progress ${maxProgress}`);
    assert.ok(sawSpeed, 'speed reported');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!fs.existsSync(path.join(OUT, 'to-cancel.mp4')));
  });

  test('previews, crop detection and size estimate handlers', async () => {
    const url = (await mod.handlers['convert.frame']!({ path: F('main.mp4'), time: 2, width: 320 })) as string;
    assert.match(url, /^data:image\/jpeg;base64,/);
    const thumbs = (await mod.handlers['convert.thumbs']!({ path: F('main.mp4'), count: 5, width: 120 })) as string[];
    assert.equal(thumbs.length, 5);
    const res = await fetch(thumbs[2]);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const crop = await mod.handlers['convert.detectCrop']!({ path: F('letterbox.mp4') });
    assert.deepEqual(crop, { x: 0, y: 60, w: 640, h: 360 });
    const est = (await mod.handlers['convert.estimateSize']!({ inputs: [await input(F('main.mp4'))], join: false, output: { ...outputFromPreset('mp4', '720p'), targetSizeMB: 3 } })) as number;
    close(est / (1024 * 1024), 3, 0.1);
    const q = (await mod.handlers['convert.estimateSize']!({ inputs: [await input(F('main.mp4'))], join: false, output: outputFromPreset('mp4', '1080p') })) as number;
    assert.ok(q > 500_000 && q < 50_000_000, `estimate ${q}`);
  });

  test('a failed job can be retried', async () => {
    const tmp = path.join(FIX, 'later.mp4');
    const inp = await input(F('short.mp4'));
    const [job] = (await mod.handlers['convert.add']!({ inputs: [{ ...inp, path: tmp, info: { ...inp.info, path: tmp } }], join: false, output: outputFromPreset('mp4', '360p'), outputDir: OUT, outputName: 'retry' })) as ConvertJob[];
    const failed = await waitJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /moved or deleted/);
    fs.copyFileSync(F('short.mp4'), tmp);
    await mod.handlers['convert.retry']!({ ids: [job.id] });
    await new Promise((r) => setTimeout(r, 50));
    const ok = await waitJob(job.id);
    assert.equal(ok.status, 'completed', ok.error);
  });

  test('AV1 on the GPU (when available)', async (t) => {
    if (!hwEncoders.includes('av1_nvenc')) return t.skip('no AV1 NVENC');
    const out: OutputSpec = { ...outputFromPreset('mkv', '1080p'), hwAccel: true, video: { codec: 'av1', width: 1920, height: 1080, quality: 70, fit: 'pad' } };
    const [j] = await convert([await input(F('short.mp4'))], out, { name: 'av1' });
    assert.equal(vstream(await probe(j.outputPaths![0]))?.codec_name, 'av1');
  });
});

describe('every output target', { concurrency: 6 }, () => {
  const targets = OUTPUT_TARGETS.filter((t) => t.special !== 'dvd' && t.special !== 'bluray');
  for (const t of targets) {
    test(`to ${t.label}`, async () => {
      const [j] = await convert([await input(F('short.mp4'))], outputFromPreset(t.id), { name: `target-${t.id}` });
      for (const o of j.outputPaths!.filter((x) => !x.endsWith('.html'))) {
        const p = await probe(o);
        if (t.videoCodecs.length) assert.ok(vstream(p), `${t.id}: no video stream`);
        if (t.audioCodecs.length && t.special !== 'gif') assert.ok(astream(p), `${t.id}: no audio stream`);
        if (t.id === 'swf') {
          // SWF headers carry no duration; count frames instead (2 s @ 30 fps)
          const r = await runCapture(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', o]);
          assert.ok(Number(r.stdout.trim()) >= 55, `swf frames ${r.stdout}`);
        } else assert.ok(p.duration > 1.5 || t.special === 'gif', `${t.id}: duration ${p.duration}`);
      }
    });
  }
});
