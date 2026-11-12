// "to DVD" / "to Blu-ray": encode the inputs to disc-compliant
// streams, author a DVD-Video (VIDEO_TS) or Blu-ray (BDMV) structure, then save
// it as a folder, an ISO image, or burn it to a disc.
import fs from 'node:fs';
import path from 'node:path';
import type { ConvertInput, ConvertJob, DiscSpec, EditSpec } from '../../../shared/types';
import { outputFromPreset } from '../../../shared/defaults';
import type { CoreModule, Ctx, JobQueue, JobRuntime } from '../context';
import { errMessage, fileSize, sanitizeFilename, uniquePath } from '../util';
import { detectCrop } from '../convert/crop';
import { buildEditGraph, dvdTarget, type FrameTarget } from './editGraph';
import { authorDvd } from './dvdAuthor';
import { dvdVideoTree, writeUdfIso } from './udfIso';
import { blurayAudioArgs, blurayFormat, blurayMeta, blurayVideoArgs, chapterTimes, discCapacity, fitVideoKbps, parseTsMuxerProgress } from './bluray';
import { burnInvocation, listDrives, parseBurnLine } from './imapi';

const CHAPTER_SECONDS = 300;
const DVD_AUDIO_KBPS = 192;
const BD_AUDIO_KBPS = 448;

const ISO639: Record<string, string> = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', rus: 'ru', jpn: 'ja', zho: 'zh', chi: 'zh', por: 'pt', nld: 'nl', dut: 'nl',
  pol: 'pl', kor: 'ko', ara: 'ar', hin: 'hi', tur: 'tr', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', heb: 'he',
  hun: 'hu', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', ron: 'ro', rum: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk',
};

function lang2(l?: string): string | undefined {
  if (!l) return undefined;
  const s = l.toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  return ISO639[s];
}
function lang3(l?: string): string | undefined {
  if (!l) return undefined;
  const s = l.toLowerCase();
  if (/^[a-z]{3}$/.test(s)) return s;
  const hit = Object.entries(ISO639).find(([, two]) => two === s);
  return hit?.[0];
}

function uniqueDir(dir: string, name: string): string {
  const base = sanitizeFilename(name) || 'Disc';
  let p = path.join(dir, base);
  let n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})`);
  return p;
}

/** The language shared by every input's chosen audio track, if any. */
function commonLanguage(inputs: ConvertInput[]): string | undefined {
  const langs = inputs.map((i) => (i.edit.audioTrack >= 0 ? i.info.audioTracks[Math.min(i.edit.audioTrack, i.info.audioTracks.length - 1)]?.language : undefined));
  if (!langs.length || langs.some((l) => !l || l === 'und')) return undefined;
  return langs.every((l) => l === langs[0]) ? langs[0] : undefined;
}

export function createDiscModule(ctx: Ctx, queue: JobQueue): CoreModule {
  /** Resolve "remove black bars automatically" into a concrete crop rectangle. */
  async function resolveEdits(inputs: ConvertInput[], rt: JobRuntime, ffmpeg: string): Promise<EditSpec[]> {
    const out: EditSpec[] = [];
    for (const inp of inputs) {
      let edit = inp.edit;
      const v = inp.info.video;
      if (edit.autoRemoveBlackBars && !edit.crop && v && !inp.info.isImage) {
        rt.progress(0, `Detecting black bars in ${inp.info.name}`);
        try {
          const crop = await detectCrop(ffmpeg, inp.path, inp.info.duration, v.width, v.height, rt.signal);
          if (crop) edit = { ...edit, crop };
        } catch (e) {
          if (rt.signal.aborted) throw e;
        }
      }
      out.push(edit);
    }
    return out;
  }

  async function burn(rt: JobRuntime, spec: DiscSpec, iso: string, from: number): Promise<string[]> {
    const drives = await listDrives(ctx.paths.temp);
    if (!drives.length) throw new Error('No disc burner was found on this PC. Choose "Save as ISO" or "Save as folder" instead.');
    const drive = drives.find((d) => d.id === spec.drive) ?? drives.find((d) => (spec.type === 'bluray' ? d.canWriteBd : d.canWriteDvd));
    if (!drive) throw new Error(spec.type === 'bluray' ? 'None of the drives on this PC can write Blu-ray discs.' : 'None of the drives on this PC can write DVDs.');
    const inv = burnInvocation(rt.tempDir, drive.id, iso, spec.title);
    rt.progress(from, 'Preparing the burner');
    try {
      let lastErr = '';
      const r = await rt.run(inv.cmd, inv.args, {
        onLine: (line) => {
          const b = parseBurnLine(line);
          if (b) rt.progress(b.progress >= 0 ? from + (1 - from) * b.progress : from, b.stage);
          else if (/^\s*(Exception|.*: )/.test(line) || /throw|disc|burner/i.test(line)) lastErr = line.trim();
        },
      });
      if (r.code !== 0) {
        const msg = (r.tail.split(/\r?\n/).find((l) => /blank disc|not blank|too small|cannot write|not supported|No disc burner/i.test(l)) ?? lastErr ?? r.tail).trim();
        throw new Error(msg || 'Burning failed');
      }
    } finally {
      inv.cleanup();
    }
    return [drive.letter ?? drive.name];
  }

  /* ───────── DVD ───────── */
  async function runDvd(job: ConvertJob, rt: JobRuntime): Promise<string[]> {
    const spec = job.disc!;
    const ffmpeg = ctx.engines.require('ffmpeg');
    const target = dvdTarget(spec.standard, spec.aspect);
    const edits = await resolveEdits(job.inputs, rt, ffmpeg);
    const graphs = job.inputs.map((inp, i) => buildEditGraph(inp.info, edits[i], target));
    const total = graphs.reduce((s, g) => s + g.duration, 0);
    const capacity = discCapacity(spec.discSize === 'dvd9' ? 'dvd9' : 'dvd5');
    const raw = (capacity * 0.95 * 8) / total / 1000 - DVD_AUDIO_KBPS;
    if (raw < 900) {
      const hours = ((capacity * 0.95 * 8) / ((900 + DVD_AUDIO_KBPS) * 1000) / 3600).toFixed(1);
      throw new Error(`The videos are too long for one ${spec.discSize === 'dvd9' ? 'dual-layer DVD (DVD9)' : 'DVD (DVD5)'} — about ${hours} hours fit. ${spec.discSize === 'dvd9' ? 'Remove some videos.' : 'Choose DVD9 or remove some videos.'}`);
    }
    const videoKbps = fitVideoKbps(capacity, total, DVD_AUDIO_KBPS, 0.05, 900, 8000);
    const quality = videoKbps >= 4500 ? 'high' : videoKbps >= 2500 ? 'standard' : 'low';
    if (quality === 'low') ctx.toast('warning', `The videos are long for one DVD, so picture quality will be reduced (${videoKbps} kbps).`);
    if (spec.menu !== 'none') ctx.toast('info', 'DVD menus are not available yet — the disc will start playing the first video automatically.');

    // 1. encode (0 → 0.8)
    const vobs: string[] = [];
    let done = 0;
    for (let i = 0; i < job.inputs.length; i++) {
      const g = graphs[i];
      const out = path.join(rt.tempDir, `title${String(i + 1).padStart(2, '0')}.mpg`);
      const from = (done / total) * 0.8;
      const to = ((done + g.duration) / total) * 0.8;
      await rt.ffmpeg(
        [
          '-i', job.inputs[i].path,
          '-filter_complex', g.filterComplex,
          '-map', g.videoLabel, '-map', g.audioLabel,
          '-target', `${spec.standard}-dvd`, '-aspect', spec.aspect,
          '-b:v', `${videoKbps}k`, '-maxrate', '9000k', '-bufsize', '1835k',
          '-flags', '+cgop', '-sc_threshold', '1000000000',
          '-c:a', 'ac3', '-b:a', `${DVD_AUDIO_KBPS}k`, '-ar', '48000', '-ac', '2',
          '-f', 'dvd', out,
        ],
        { durationSec: g.duration, from, to, stage: `Encoding video ${i + 1} of ${job.inputs.length} for DVD (${quality} quality)` },
      );
      vobs.push(out);
      done += g.duration;
    }
    const bytes = vobs.reduce((s, v) => s + fileSize(v), 0);
    if (bytes > capacity) throw new Error(`The encoded video (${(bytes / 1e9).toFixed(2)} GB) does not fit on the disc. Choose a larger disc or remove some videos.`);

    // 2. author (0.8 → 0.9)
    const discDir = spec.output === 'folder' ? uniqueDir(job.outputDir, spec.title || job.title) : path.join(rt.tempDir, 'disc');
    fs.mkdirSync(discDir, { recursive: true });
    await authorDvd({
      standard: spec.standard,
      aspect: spec.aspect,
      outDir: discDir,
      titles: vobs.map((v) => ({ vobPath: v, chapterInterval: CHAPTER_SECONDS })),
      audioLang: lang2(commonLanguage(job.inputs)),
      signal: rt.signal,
      onProgress: (p) => rt.progress(0.8 + p * 0.1, 'Creating the DVD structure'),
    });
    for (const v of vobs) fs.rmSync(v, { force: true });
    if (spec.output === 'folder') {
      rt.progress(1, 'Done');
      return [discDir];
    }

    // 3. ISO (0.9 → 1, or → 0.93 before burning)
    const iso = spec.output === 'iso' ? uniquePath(job.outputDir, spec.title || job.title, 'iso') : path.join(rt.tempDir, 'disc.iso');
    const isoEnd = spec.output === 'iso' ? 1 : 0.93;
    await writeUdfIso({
      volumeLabel: spec.title || 'DVD_VIDEO',
      root: dvdVideoTree(discDir),
      out: iso,
      signal: rt.signal,
      onProgress: (p) => rt.progress(0.9 + p * (isoEnd - 0.9), 'Creating the ISO image'),
    });
    if (spec.output === 'iso') return [iso];
    fs.rmSync(discDir, { recursive: true, force: true });
    return burn(rt, spec, iso, 0.93);
  }

  /* ───────── Blu-ray ───────── */
  async function runBluray(job: ConvertJob, rt: JobRuntime): Promise<string[]> {
    const spec = job.disc!;
    const ffmpeg = ctx.engines.require('ffmpeg');
    if (!ctx.engines.path('tsmuxer')) {
      rt.progress(0, 'Downloading the Blu-ray authoring tool (tsMuxeR)');
      await ctx.engines.install('tsmuxer');
    }
    const tsmuxer = ctx.engines.require('tsmuxer');
    const firstVideo = job.inputs.find((i) => i.info.video && !i.info.isImage)?.info.video;
    const fmt = blurayFormat(spec.standard, spec.resolution ?? '1080', firstVideo?.fps ?? (spec.standard === 'pal' ? 25 : 29.97));
    const frame: FrameTarget = fmt.frame;
    const edits = await resolveEdits(job.inputs, rt, ffmpeg);
    const graphs = job.inputs.map((inp, i) => buildEditGraph(inp.info, edits[i], frame));
    const total = graphs.reduce((s, g) => s + g.duration, 0);
    const capacity = discCapacity(spec.discSize === 'bd50' ? 'bd50' : 'bd25');
    const videoKbps = fitVideoKbps(capacity, total, BD_AUDIO_KBPS, 0.1, 3000, 30000);
    if (videoKbps <= 3000 && (capacity * 0.9 * 8) / total / 1000 - BD_AUDIO_KBPS < 3000) {
      throw new Error(`The videos are too long for one ${spec.discSize === 'bd50' ? 'BD-50' : 'BD-25'} disc. ${spec.discSize === 'bd50' ? 'Remove some videos.' : 'Choose BD-50 or remove some videos.'}`);
    }
    if (spec.menu !== 'none') ctx.toast('info', 'Blu-ray menus are not available yet — the disc will start playing automatically.');

    // 1. encode (0 → 0.85)
    const videos: string[] = [];
    const audios: string[] = [];
    let done = 0;
    for (let i = 0; i < job.inputs.length; i++) {
      const g = graphs[i];
      const v = path.join(rt.tempDir, `title${String(i + 1).padStart(2, '0')}.264`);
      const a = path.join(rt.tempDir, `title${String(i + 1).padStart(2, '0')}.ac3`);
      await rt.ffmpeg(
        ['-i', job.inputs[i].path, '-filter_complex', g.filterComplex, '-map', g.videoLabel, ...blurayVideoArgs(fmt, videoKbps, v), '-map', g.audioLabel, ...blurayAudioArgs(a, BD_AUDIO_KBPS)],
        { durationSec: g.duration, from: (done / total) * 0.85, to: ((done + g.duration) / total) * 0.85, stage: `Encoding video ${i + 1} of ${job.inputs.length} for Blu-ray (${fmt.label})` },
      );
      videos.push(v);
      audios.push(a);
      done += g.duration;
    }

    // 2. mux with tsMuxeR (0.85 → 1, or → 0.93 before burning)
    const meta = path.join(rt.tempDir, 'disc.meta');
    fs.writeFileSync(
      meta,
      blurayMeta({ videos, audios, fmt, chapters: chapterTimes(graphs.map((g) => g.duration), CHAPTER_SECONDS), label: spec.title || 'BLURAY', lang: lang3(commonLanguage(job.inputs)) }),
      'utf8',
    );
    const out =
      spec.output === 'folder'
        ? uniqueDir(job.outputDir, spec.title || job.title)
        : spec.output === 'iso'
          ? uniquePath(job.outputDir, spec.title || job.title, 'iso')
          : path.join(rt.tempDir, 'disc.iso');
    const end = spec.output === 'burn' ? 0.93 : 1;
    const r = await rt.run(tsmuxer, [meta, out], {
      onLine: (line) => {
        const p = parseTsMuxerProgress(line);
        if (p !== null) rt.progress(0.85 + p * (end - 0.85), 'Building the Blu-ray disc');
      },
    });
    if (r.code !== 0) throw new Error('tsMuxeR failed: ' + r.tail.split(/\r?\n/).slice(-3).join(' '));
    for (const f of [...videos, ...audios]) fs.rmSync(f, { force: true });
    if (spec.output !== 'burn') return [out];
    return burn(rt, spec, out, 0.93);
  }

  queue.registerRunner('disc', async (job, rt) => {
    if (!job.disc) throw new Error('This job has no disc settings');
    if (!job.inputs.length) throw new Error('Add at least one video');
    try {
      return job.disc.type === 'dvd' ? await runDvd(job, rt) : await runBluray(job, rt);
    } catch (e) {
      if (rt.signal.aborted) throw new Error('Canceled');
      throw new Error(errMessage(e));
    }
  });

  return {
    handlers: {
      'disc.drives': () => listDrives(ctx.paths.temp),
      'disc.create': ({ inputs, spec, outputDir }) => {
        if (!inputs.length) throw new Error('Add at least one video first');
        if (inputs.length > 99) throw new Error('A disc can hold at most 99 videos');
        const usable = inputs.filter((i) => !i.info.isImage);
        if (!usable.length) throw new Error('Photos cannot be put on a disc directly — make a slideshow first');
        const dir = outputDir || ctx.settings().convertDir;
        fs.mkdirSync(dir, { recursive: true });
        const fixed: DiscSpec = {
          ...spec,
          discSize: spec.type === 'dvd' ? (spec.discSize === 'dvd9' ? 'dvd9' : 'dvd5') : spec.discSize === 'bd50' ? 'bd50' : 'bd25',
          title: (spec.title || usable[0].info.name.replace(/\.[^.]+$/, '')).slice(0, 60),
        };
        const output = outputFromPreset(spec.type === 'dvd' ? 'dvd' : 'bluray', spec.type === 'dvd' ? spec.standard : spec.resolution ?? '1080');
        return queue.enqueue({
          kind: 'disc',
          title: `${spec.type === 'dvd' ? 'DVD' : 'Blu-ray'}: ${fixed.title}`,
          inputs: usable,
          join: true,
          output,
          outputDir: dir,
          disc: fixed,
        });
      },
    },
  };
}
