// Disc module tests: pure helpers + real end-to-end DVD / Blu-ray authoring with ffmpeg
// (validated by ffmpeg's libdvdread/libdvdnav based "dvdvideo" demuxer and libbluray).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConvertInput, ConvertJob, DiscSpec, MediaInfo } from '../shared/types';
import { defaultEdit } from '../shared/defaults';
import { Bus, type Ctx, type JobQueue, type JobRunner, type JobRuntime } from '../electron/core/context';
import { Engines } from '../electron/core/engines';
import { atempoChain, buildEditGraph, dvdTarget, escapeFilterPath, keepSegments } from '../electron/core/disc/editGraph';
import { dvdTime, makeCells, type Vobu } from '../electron/core/disc/dvdAuthor';
import { crc16 } from '../electron/core/disc/udfIso';
import { blurayFormat, blurayMeta, chapterTimes, fitVideoKbps, parseTsMuxerProgress, tsTime } from '../electron/core/disc/bluray';
import { parseBurnLine } from '../electron/core/disc/imapi';
import { createDiscModule } from '../electron/core/disc';

/* ───────── pure helpers ───────── */

test('keepSegments merges, clamps and complements cuts', () => {
  assert.deepEqual(keepSegments(100, []), [{ start: 0, end: 100 }]);
  assert.deepEqual(keepSegments(100, [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 120 }]), [
    { start: 0, end: 10 },
    { start: 30, end: 90 },
  ]);
  assert.deepEqual(keepSegments(10, [{ start: 0, end: 10 }]), []);
});

test('atempoChain splits large speed changes', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(1.5), ['atempo=1.5']);
});

test('escapeFilterPath escapes the drive colon and uses forward slashes', () => {
  assert.equal(escapeFilterPath('C:\\Videos\\a.srt'), 'C\\:/Videos/a.srt');
});

test('dvdTime encodes BCD with frame-rate flag', () => {
  assert.deepEqual([...dvdTime(3725.48, false)], [0x01, 0x02, 0x05, 0x40 | 0x12]); // 1:02:05 + 12 frames @25
  assert.equal(dvdTime(1, true)[3] & 0xc0, 0xc0);
});

test('makeCells puts chapters every interval without a tiny last chapter', () => {
  const vobus: Vobu[] = Array.from({ length: 200 }, (_, i) => ({ sector: i * 10, lastSector: i * 10 + 9, scr: 0, sPts: 45000 + i * 54000, ePts: 45000 + (i + 1) * 54000, seqEnd: false, refEnds: [], firstAudio: -1, hasVideo: true }));
  // 200 VOBUs × 0.6 s = 120 s; chapters at 0, 30, 60, 90
  const cells = makeCells(vobus, 30);
  assert.equal(cells.length, 4);
  assert.equal(cells[0].first, 0);
  assert.equal(cells[3].last, 199);
});

test('crc16 is CRC-CCITT (XModem)', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
});

test('blurayFormat picks spec-valid formats', () => {
  assert.equal(blurayFormat('pal', '1080', 25).label, '1080i25');
  assert.equal(blurayFormat('ntsc', '1080', 29.97).label, '1080i29.97');
  assert.equal(blurayFormat('pal', '1080', 23.976).label, '1080p23.976');
  assert.equal(blurayFormat('ntsc', '720', 30).label, '720p59.94');
  assert.equal(blurayFormat('pal', '720', 25).label, '720p50');
});

test('chapterTimes, tsTime and meta text', () => {
  assert.deepEqual(chapterTimes([700, 100], 300), [0, 300, 600, 700]);
  assert.equal(tsTime(3723.456), '01:02:03.456');
  const meta = blurayMeta({ videos: ['C:\\a b\\1.264', 'C:\\a b\\2.264'], audios: ['x.ac3', 'y.ac3'], fmt: blurayFormat('pal', '1080', 25), chapters: [0, 300], label: 'My "Disc"', lang: 'eng' });
  assert.match(meta, /--custom-chapters=00:00:00\.000;00:05:00\.000/);
  assert.match(meta, /V_MPEG4\/ISO\/AVC, "C:\/a b\/1\.264"\+"C:\/a b\/2\.264", fps=25/);
  assert.match(meta, /A_AC3, "x\.ac3"\+"y\.ac3", lang=eng/);
  assert.match(meta, /--label="My Disc"/);
  assert.ok(Math.abs((parseTsMuxerProgress('  45.3% complete') ?? 0) - 0.453) < 1e-9);
});

test('fitVideoKbps fills the disc within limits', () => {
  // 2 hours on a DVD5 → about 4.7 Mbps total
  const k = fitVideoKbps(4_700_000_000, 7200, 192, 0.05, 900, 8000);
  assert.ok(k > 4500 && k < 5000, String(k));
  assert.equal(fitVideoKbps(4_700_000_000, 60, 192, 0.05, 900, 8000), 8000);
});

test('parseBurnLine', () => {
  assert.deepEqual(parseBurnLine('BURN 4 0.2500'), { stage: 'Burning', progress: 0.25 });
  assert.equal(parseBurnLine('something else'), null);
});

test('buildEditGraph covers cuts, rotate, subtitles, mute and audio-only input', () => {
  const info: MediaInfo = {
    path: 'C:\\v\\a.mp4', name: 'a.mp4', size: 1, duration: 60, formatName: 'mp4',
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30 },
    audioTracks: [{ index: 1, order: 0, codec: 'aac', channels: 2, sampleRate: 44100 }, { index: 2, order: 1, codec: 'aac', channels: 2, sampleRate: 44100 }],
    subtitleTracks: [], isImage: false, isAudioOnly: false, browserPlayable: true,
  };
  const e = { ...defaultEdit(), cuts: [{ start: 10, end: 20 }, { start: 40, end: 50 }], rotate: 90 as const, audioTrack: 1, speed: 2, fadeIn: 1 };
  e.subtitles = { path: 'C:\\s\\x.srt', fontName: 'Arial', fontSize: 24, primaryColor: '#ffffff', outlineColor: '#000000', outline: 2, bold: false, position: 'bottom', marginV: 20 };
  const g = buildEditGraph(info, e, dvdTarget('pal', '16:9'));
  assert.equal(g.duration, 20); // 40 s kept at 2x
  assert.match(g.filterComplex, /\[0:a:1\]/);
  assert.match(g.filterComplex, /transpose=1/);
  assert.match(g.filterComplex, /concat=n=3:v=1:a=1/);
  assert.match(g.filterComplex, /subtitles=filename='C\\:\/s\/x\.srt'/);
  assert.match(g.filterComplex, /setsar=64\/45/);
  const muted = buildEditGraph(info, { ...defaultEdit(), audioTrack: -1 }, dvdTarget('ntsc', '4:3'));
  assert.match(muted.filterComplex, /anullsrc/);
  const audioOnly = buildEditGraph({ ...info, video: undefined, isAudioOnly: true }, defaultEdit(), dvdTarget('pal', '4:3'));
  assert.match(audioOnly.filterComplex, /^color=c=black:s=768x576/);
});

/* ───────── end to end with real tools ───────── */

const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const hasDvdDemuxer = hasFfmpeg && /dvdvideo/.test(spawnSync('ffmpeg', ['-hide_banner', '-demuxers'], { encoding: 'utf8' }).stdout);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-disc-'));
const SKIP_E2E = !hasFfmpeg ? 'ffmpeg not installed' : process.env.VF_SKIP_E2E ? 'VF_SKIP_E2E set' : false;

function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function probe(file: string): MediaInfo {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout) as { format: { duration: string; format_name: string; size: string }; streams: { index: number; codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; channels?: number; sample_rate?: string; tags?: { language?: string } }[] };
  const v = j.streams.find((s) => s.codec_type === 'video');
  const [n, d] = (v?.r_frame_rate ?? '25/1').split('/').map(Number);
  const audio = j.streams.filter((s) => s.codec_type === 'audio');
  return {
    path: file, name: path.basename(file), size: Number(j.format.size), duration: Number(j.format.duration), formatName: j.format.format_name,
    video: v ? { index: v.index, codec: v.codec_name, width: v.width!, height: v.height!, fps: n / (d || 1) } : undefined,
    audioTracks: audio.map((a, i) => ({ index: a.index, order: i, codec: a.codec_name, channels: a.channels ?? 2, sampleRate: Number(a.sample_rate ?? 48000), language: a.tags?.language })),
    subtitleTracks: [], isImage: false, isAudioOnly: !v, browserPlayable: true,
  };
}

/** Minimal JobRuntime: ffmpeg with -progress parsing, cancellation, temp dir. */
function makeRuntime(name: string): JobRuntime & { stages: string[]; last: number } {
  const ac = new AbortController();
  const tempDir = fs.mkdtempSync(path.join(WORK, name + '-'));
  const children = new Set<ReturnType<typeof spawn>>();
  ac.signal.addEventListener('abort', () => children.forEach((c) => c.kill()));
  const rt = {
    signal: ac.signal,
    tempDir,
    stages: [] as string[],
    last: 0,
    progress(p: number, stage?: string) {
      assert.ok(p >= 0 && p <= 1.0001, `progress ${p} out of range`);
      rt.last = p;
      if (stage && rt.stages[rt.stages.length - 1] !== stage) rt.stages.push(stage);
    },
    ffmpeg(args: string[], o: { durationSec: number; from?: number; to?: number; stage?: string }) {
      return new Promise<void>((resolve, reject) => {
        const c = spawn('ffmpeg', ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args]);
        children.add(c);
        let err = '';
        c.stdout.on('data', (d: Buffer) => {
          const m = /out_time_us=(\d+)/.exec(d.toString());
          if (m && o.durationSec > 0) rt.progress((o.from ?? 0) + Math.min(1, Number(m[1]) / 1e6 / o.durationSec) * ((o.to ?? 1) - (o.from ?? 0)), o.stage);
        });
        c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
        c.on('close', (code) => {
          children.delete(c);
          if (code === 0) resolve();
          else reject(new Error(err.split(/\r?\n/).slice(-4).join('\n')));
        });
      });
    },
    run(cmd: string, args: string[], o?: { onLine?: (l: string) => void; cwd?: string }) {
      return new Promise<{ code: number | null; tail: string }>((resolve, reject) => {
        const c = spawn(cmd, args, { cwd: o?.cwd });
        children.add(c);
        let tail = '';
        const onData = (d: Buffer) => {
          const s = d.toString();
          tail = (tail + s).slice(-4000);
          s.split(/\r?\n|\r/).forEach((l) => l.trim() && o?.onLine?.(l));
        };
        c.stdout.on('data', onData);
        c.stderr.on('data', onData);
        c.on('error', reject);
        c.on('close', (code) => {
          children.delete(c);
          resolve({ code, tail });
        });
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
    paths: { data: WORK, bin: '', temp: path.join(WORK, 'tmp'), cookies: '', archive: '' },
    settings: () => ({ convertDir: WORK }),
    toast: (_l: string, m: string) => toasts.push(m),
  } as unknown as Ctx;
  let runner: JobRunner | undefined;
  const queue: JobQueue = {
    registerRunner: (kind, r) => {
      if (kind === 'disc') runner = r;
    },
    enqueue: (j) => ({ ...j, id: 'job', status: 'queued', progress: 0, createdAt: Date.now() }) as ConvertJob,
  };
  const mod = createDiscModule(ctx, queue);
  return { mod, runner: runner!, engines, toasts };
}

function makeInputs(): ConvertInput[] {
  const a = path.join(WORK, 'clip-a.mp4');
  const b = path.join(WORK, 'clip-b.mkv');
  const srt = path.join(WORK, 'subs.srt');
  if (!fs.existsSync(a)) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=40', '-f', 'lavfi', '-i', 'sine=f=440:d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-shortest', a]);
    ff(['-f', 'lavfi', '-i', 'testsrc=s=640x480:r=25:d=12', '-f', 'lavfi', '-i', 'sine=f=880:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-shortest', b]);
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:05,000\nHello DVD\n');
  }
  const ea = { ...defaultEdit(), cuts: [{ start: 5, end: 10 }] };
  ea.subtitles = { path: srt, fontName: 'Arial', fontSize: 22, primaryColor: '#ffff00', outlineColor: '#000000', outline: 2, bold: true, position: 'bottom', marginV: 20 };
  const eb = { ...defaultEdit(), rotate: 90 as const, fadeIn: 1, fadeOut: 1 };
  return [
    { path: a, edit: ea, info: probe(a) },
    { path: b, edit: eb, info: probe(b) },
  ];
}

const QUIET = /libdvdcss|for reading|CSS auth|Unable to open device|dvd_read_name/i;

function readDvdTitle(src: string, title: number): { frames: number; duration: number; chapters: number; warnings: string[] } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'dvdvideo', '-preindex', '1', '-title', String(title), '-i', src, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8' });
  const err = r.stderr.split(/\r?\n/).filter((l) => !QUIET.test(l));
  const text = err.join('\n');
  const frames = Number(/frame=\s*(\d+)/.exec(text)?.[1] ?? 0);
  const times = [...text.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const dm = times[times.length - 1];
  const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
  const chapters = (text.match(/Chapter #0:\d+/g) ?? []).length / 2; // listed for input and output
  return { frames, duration, chapters, warnings: err.filter((l) => /warn|error|invalid/i.test(l)) };
}

function isoFileLayout(iso: string): { name: string; lba: number; sectors: number }[] {
  const fd = fs.openSync(iso, 'r');
  const sec = (n: number) => {
    const b = Buffer.alloc(2048);
    fs.readSync(fd, b, 0, 2048, n * 2048);
    return b;
  };
  const pvd = sec(16);
  const entries = (lba: number, len: number) => {
    const out: { name: string; lba: number; size: number; dir: boolean }[] = [];
    for (let s = 0; s < Math.ceil(len / 2048); s++) {
      const d = sec(lba + s);
      let p = 0;
      while (p < 2048 && d[p]) {
        const l = d[p];
        const name = d.subarray(p + 33, p + 33 + d[p + 32]).toString('latin1');
        if (name !== '\x00' && name !== '\x01') out.push({ name, lba: d.readUInt32LE(p + 2), size: d.readUInt32LE(p + 10), dir: !!(d[p + 25] & 2) });
        p += l;
      }
    }
    return out;
  };
  const root = entries(pvd.readUInt32LE(156 + 2), pvd.readUInt32LE(156 + 10));
  const vts = root.find((e) => e.name === 'VIDEO_TS')!;
  const files = entries(vts.lba, vts.size).map((f) => ({ name: f.name.replace(/;1$/, ''), lba: f.lba, sectors: Math.ceil(f.size / 2048) }));
  fs.closeSync(fd);
  return files.sort((x, y) => x.lba - y.lba);
}

test('DVD (PAL 16:9) folder and ISO are readable by libdvdread/libdvdnav', { skip: SKIP_E2E || (!hasDvdDemuxer && 'ffmpeg built without dvdvideo demuxer'), timeout: 600_000 }, async () => {
  const { mod, runner } = await setup();
  const inputs = makeInputs();
  for (const output of ['folder', 'iso'] as const) {
    const spec: DiscSpec = { type: 'dvd', standard: 'pal', aspect: '16:9', title: `Test ${output}`, menu: 'none', output, discSize: 'dvd5' };
    const job = (await mod.handlers['disc.create']!({ inputs, spec, outputDir: path.join(WORK, 'out-pal') })) as ConvertJob;
    const rt = makeRuntime('pal-' + output);
    const outs = await runner(job, rt);
    assert.equal(outs.length, 1);
    assert.ok(rt.last > 0.99, 'progress reached the end');
    const src = outs[0];
    if (output === 'folder') {
      const files = fs.readdirSync(path.join(src, 'VIDEO_TS')).sort();
      assert.deepEqual(files, ['VIDEO_TS.BUP', 'VIDEO_TS.IFO', 'VTS_01_0.BUP', 'VTS_01_0.IFO', 'VTS_01_1.VOB']);
      const ifo = fs.readFileSync(path.join(src, 'VIDEO_TS', 'VIDEO_TS.IFO'));
      assert.equal(ifo.subarray(0, 12).toString(), 'DVDVIDEO-VMG');
      assert.equal(ifo.readUInt16BE(0x800), 2, 'two titles in TT_SRPT');
      assert.ok(fs.existsSync(path.join(src, 'AUDIO_TS')));
    } else {
      const layout = isoFileLayout(src);
      assert.deepEqual(layout.map((f) => f.name), ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_1.VOB', 'VTS_01_0.BUP']);
      for (let i = 1; i < layout.length; i++) assert.equal(layout[i].lba, layout[i - 1].lba + layout[i - 1].sectors, 'files are contiguous');
    }
    // title 1: 40 s minus 5 s cut = 35 s; title 2: 12 s
    const t1 = readDvdTitle(src, 1);
    const t2 = readDvdTitle(src, 2);
    assert.ok(Math.abs(t1.duration - 35) < 0.5, `title 1 duration ${t1.duration}`);
    assert.ok(Math.abs(t2.duration - 12) < 0.5, `title 2 duration ${t2.duration}`);
    assert.ok(Math.abs(t1.frames - 35 * 25) <= 3, `title 1 frames ${t1.frames}`);
    assert.ok(Math.abs(t2.frames - 12 * 25) <= 3, `title 2 frames ${t2.frames}`);
    assert.deepEqual(t1.warnings, []);
  }
});

test('DVD (NTSC 4:3) folder', { skip: SKIP_E2E || (!hasDvdDemuxer && 'no dvdvideo demuxer'), timeout: 600_000 }, async () => {
  const { mod, runner } = await setup();
  const inputs = makeInputs().slice(1);
  const spec: DiscSpec = { type: 'dvd', standard: 'ntsc', aspect: '4:3', title: 'NTSC', menu: 'simple', output: 'folder', discSize: 'dvd9' };
  const job = (await mod.handlers['disc.create']!({ inputs, spec, outputDir: path.join(WORK, 'out-ntsc') })) as ConvertJob;
  const outs = await runner(job, makeRuntime('ntsc'));
  const r = spawnSync('ffprobe', ['-hide_banner', '-v', 'error', '-f', 'dvdvideo', '-title', '1', '-show_entries', 'stream=codec_name,width,height,display_aspect_ratio,r_frame_rate', '-of', 'compact', outs[0]], { encoding: 'utf8' });
  assert.match(r.stdout, /mpeg2video\|width=720\|height=480\|display_aspect_ratio=4:3\|r_frame_rate=30000\/1001/);
  assert.match(r.stdout, /ac3/);
  const t = readDvdTitle(outs[0], 1);
  assert.ok(Math.abs(t.duration - 12) < 0.5, `duration ${t.duration}`);
});

test('Blu-ray folder and ISO via tsMuxeR', { skip: SKIP_E2E, timeout: 900_000 }, async () => {
  const { mod, runner, engines } = await setup();
  if (!engines.path('tsmuxer')) return; // installed on demand in the app; skip silently here
  const inputs = makeInputs();
  for (const output of ['folder', 'iso'] as const) {
    const spec: DiscSpec = { type: 'bluray', standard: 'pal', aspect: '16:9', title: `BD ${output}`, menu: 'none', output, discSize: 'bd25' };
    const job = (await mod.handlers['disc.create']!({ inputs, spec, outputDir: path.join(WORK, 'out-bd') })) as ConvertJob;
    const rt = makeRuntime('bd-' + output);
    const outs = await runner(job, rt);
    const out = outs[0];
    if (output === 'folder') {
      assert.ok(fs.existsSync(path.join(out, 'BDMV', 'index.bdmv')));
      assert.ok(fs.existsSync(path.join(out, 'BDMV', 'PLAYLIST', '00000.mpls')));
      const m2ts = path.join(out, 'BDMV', 'STREAM', '00000.m2ts');
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,field_order', '-of', 'compact', m2ts], { encoding: 'utf8' });
      assert.match(r.stdout, /h264\|width=1920\|height=1080/);
      assert.match(r.stdout, /ac3/);
      const dur = Number(/duration=([\d.]+)/.exec(r.stdout)?.[1]);
      assert.ok(Math.abs(dur - 47) < 1, `m2ts duration ${dur}`);
      // chapter marks in the playlist: one per input (inputs are 35 s and 12 s long)
      const mpls = fs.readFileSync(path.join(out, 'BDMV', 'PLAYLIST', '00000.mpls'));
      assert.equal(mpls.subarray(0, 4).toString(), 'MPLS');
      const markAt = mpls.readUInt32BE(12);
      const marks = Array.from({ length: mpls.readUInt16BE(markAt + 4) }, (_, i) => mpls.readUInt32BE(markAt + 6 + i * 14 + 4) / 45000);
      assert.equal(marks.length, 2);
      assert.ok(Math.abs(marks[1] - marks[0] - 35) < 0.1, String(marks));
      // 1080i25: progressive frames flagged interlaced (frame_mbs_only_flag = 0), High@4.1
      const th = spawnSync('ffmpeg', ['-hide_banner', '-i', m2ts, '-map', '0:v', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
      assert.match(th.stderr, /frame_mbs_only_flag\s+0 = 0/);
      assert.match(th.stderr, /level_idc\s+00101001 = 41/);
    } else {
      assert.ok(out.endsWith('.iso') && fs.statSync(out).size > 1_000_000);
      const head = Buffer.alloc(8);
      const fd = fs.openSync(out, 'r');
      fs.readSync(fd, head, 0, 6, 16 * 2048);
      fs.closeSync(fd);
      // tsMuxeR writes a UDF-only image; sector 16 holds the "BEA01" recognition descriptor
      assert.ok(/BEA01|CD001/.test(head.toString('latin1')), head.toString('latin1'));
    }
  }
});

test('drive listing never throws and burning without a drive fails clearly', { skip: SKIP_E2E || (process.platform !== 'win32' && 'Windows only'), timeout: 600_000 }, async () => {
  const { mod, runner } = await setup();
  const drives = (await mod.handlers['disc.drives']!(undefined)) as unknown[];
  assert.ok(Array.isArray(drives));
  if (drives.length) return; // a real burner is attached — don't try to burn in tests
  const inputs = makeInputs().slice(1);
  const spec: DiscSpec = { type: 'dvd', standard: 'pal', aspect: '16:9', title: 'Burn', menu: 'none', output: 'burn', discSize: 'dvd5' };
  const job = (await mod.handlers['disc.create']!({ inputs, spec, outputDir: path.join(WORK, 'out-burn') })) as ConvertJob;
  await assert.rejects(runner(job, makeRuntime('burn')), /No disc burner was found/);
});

test('too much video for a DVD is rejected before encoding', async () => {
  const { mod, runner } = await setup();
  const info: MediaInfo = { path: 'C:\\x.mp4', name: 'x.mp4', size: 1, duration: 20 * 3600, formatName: 'mp4', video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 25 }, audioTracks: [], subtitleTracks: [], isImage: false, isAudioOnly: false, browserPlayable: true };
  const spec: DiscSpec = { type: 'dvd', standard: 'pal', aspect: '16:9', title: 'Long', menu: 'none', output: 'folder', discSize: 'dvd5' };
  const job = (await mod.handlers['disc.create']!({ inputs: [{ path: info.path, edit: defaultEdit(), info }], spec, outputDir: WORK })) as ConvertJob;
  await assert.rejects(runner(job, makeRuntime('long')), /too long for one DVD/);
});
