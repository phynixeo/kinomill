// Converter module: probing, previews, black-bar detection, the job queue and
// the "convert" + "slideshow" job runners. Also exposes the queue (JobQueue) so
// the disc and audio-tool modules can run their own job kinds through it.
import fs from 'node:fs';
import path from 'node:path';
import type { ConvertInput, ConvertJob, MediaInfo, OutputSpec } from '../../../shared/types';
import { getTarget } from '../../../shared/presets';
import type { CoreModule, Ctx, JobQueue, JobRuntime } from '../context';
import { dirExists, ensureDir, errMessage, fileExists, sanitizeFilename, uniquePath } from '../util';
import { buildConvertPlan, isBitmapSubtitle, type BuildEnv, type ResolvedInput, type WatermarkFiles, estimateOutputBytes } from './ffmpegArgs';
import { detectCrop } from './crop';
import { detectHwEncoders } from './hw';
import { probeDuration, probeFile } from './probe';
import { NULL_DEVICE, Queue } from './queue';
import { buildSlideshowPlan } from './slideshow';

export { buildConvertPlan } from './ffmpegArgs';

const FONT_CANDIDATES = ['arial.ttf', 'segoeui.ttf', 'calibri.ttf', 'tahoma.ttf', 'verdana.ttf'];

function systemFont(): string | undefined {
  const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), '/usr/share/fonts/truetype/dejavu', '/System/Library/Fonts/Supplemental', '/Library/Fonts'];
  for (const d of dirs) for (const f of [...FONT_CANDIDATES, 'DejaVuSans.ttf', 'Arial.ttf']) if (fileExists(path.join(d, f))) return path.join(d, f);
  return undefined;
}

/** A DVD folder (or its VIDEO_TS) → ffmpeg concat input of the main title's VOBs. */
export function dvdConcatInput(dir: string): { input: string; size: number; title: string } | null {
  const vts = dirExists(path.join(dir, 'VIDEO_TS')) ? path.join(dir, 'VIDEO_TS') : path.basename(dir).toUpperCase() === 'VIDEO_TS' ? dir : null;
  if (!vts) return null;
  const groups = new Map<string, { files: string[]; size: number }>();
  for (const f of fs.readdirSync(vts)) {
    const m = /^VTS_(\d\d)_([1-9])\.VOB$/i.exec(f);
    if (!m) continue;
    const g = groups.get(m[1]) ?? { files: [], size: 0 };
    const full = path.join(vts, f);
    g.files.push(full);
    g.size += fs.statSync(full).size;
    groups.set(m[1], g);
  }
  let best: [string, { files: string[]; size: number }] | undefined;
  for (const e of groups) if (!best || e[1].size > best[1].size) best = e;
  if (!best) return null;
  best[1].files.sort();
  const label = path.basename(path.basename(vts).toUpperCase() === 'VIDEO_TS' ? path.dirname(vts) : vts) || 'DVD';
  return { input: 'concat:' + best[1].files.join('|'), size: best[1].size, title: `${label} (DVD title ${Number(best[0])})` };
}

export function createConvertModule(ctx: Ctx): CoreModule & JobQueue {
  const queue = new Queue(ctx);
  let hwEncoders: string[] = [];
  let hwState: 'idle' | 'detecting' | 'done' = 'idle';

  const env = (): BuildEnv => ({ hwEncoders, hwPref: ctx.settings().hwAccel, nullDevice: NULL_DEVICE, passLog: 'ffpass' });

  const onEngines = () => {
    const ff = ctx.engines.path('ffmpeg');
    if (!ff || hwState !== 'idle') return;
    hwState = 'detecting';
    detectHwEncoders(ff)
      .then((list) => {
        hwEncoders = list;
        ctx.log('hardware encoders:', list.join(', ') || 'none');
      })
      .catch(() => undefined)
      .finally(() => {
        hwState = 'done';
        queue.ready = true;
        ctx.capabilitiesChanged();
        queue.pump();
      });
  };
  const off = ctx.bus.on((ev) => {
    if (ev.type === 'engines') onEngines();
    else if (ev.type === 'settings') queue.pump();
  });
  onEngines();

  /* ───────── helpers ───────── */

  const ffprobe = (): string => {
    ctx.engines.require('ffmpeg');
    const p = ctx.engines.ffprobePath();
    if (!p) throw new Error('ffprobe was not found next to FFmpeg. Reinstall FFmpeg in Settings → Components.');
    return p;
  };

  async function probeOne(p: string): Promise<MediaInfo> {
    const dvd = dirExists(p) ? dvdConcatInput(p) : null;
    if (dirExists(p) && !dvd) throw new Error(`"${path.basename(p)}" is a folder without a DVD (VIDEO_TS) inside.`);
    const target = dvd ? dvd.input : p;
    const info = await probeFile(ffprobe(), target);
    if (dvd) return { ...info, path: dvd.input, name: dvd.title, size: dvd.size, browserPlayable: false };
    return { ...info, mediaUrl: ctx.media.mediaUrl(p) };
  }

  async function prepareWatermark(output: OutputSpec, rt: JobRuntime): Promise<WatermarkFiles> {
    const wm = output.watermark;
    if (!wm) return {};
    if (wm.type === 'image') {
      if (!wm.imagePath || !fileExists(wm.imagePath)) throw new Error('The watermark image was not found.');
      return {};
    }
    if (!wm.text?.trim()) return {};
    const font = systemFont();
    if (!font) throw new Error('No font found for the text watermark.');
    fs.writeFileSync(path.join(rt.tempDir, 'wm.txt'), wm.text, 'utf8');
    fs.copyFileSync(font, path.join(rt.tempDir, 'wmfont.ttf'));
    return { textFile: 'wm.txt', fontFile: 'wmfont.ttf' };
  }

  async function resolveInputs(job: ConvertJob, rt: JobRuntime): Promise<ResolvedInput[]> {
    const ff = ctx.engines.require('ffmpeg');
    const out: ResolvedInput[] = [];
    for (const [k, original] of job.inputs.entries()) {
      // DVD folders were probed into a "concat:VTS_01_1.VOB|…" input
      const isConcat = original.info.path?.startsWith('concat:');
      const inp = isConcat ? { ...original, path: original.info.path } : original;
      if (isConcat) {
        const first = inp.path.slice('concat:'.length).split('|')[0];
        if (!fileExists(first)) throw new Error(`The DVD "${inp.info.name}" is no longer available.`);
      } else if (!fileExists(inp.path)) throw new Error(`"${path.basename(inp.path)}" was moved or deleted.`);
      let crop = inp.edit.crop;
      if (!crop && inp.edit.autoRemoveBlackBars && inp.info.video && !inp.info.isAudioOnly) {
        rt.progress(0, 'Detecting black bars');
        crop = await detectCrop(ff, inp.path, inp.info.duration, inp.info.video.width, inp.info.video.height, rt.signal);
      }
      let subtitleFile: string | undefined;
      let bitmapSubtitle: number | undefined;
      const sb = inp.edit.subtitles;
      if (sb?.path) {
        if (!fileExists(sb.path)) throw new Error(`The subtitle file "${path.basename(sb.path)}" was not found.`);
        const ext = path.extname(sb.path).toLowerCase() || '.srt';
        subtitleFile = `sub${k}${ext}`;
        fs.copyFileSync(sb.path, path.join(rt.tempDir, subtitleFile));
      } else if (sb && sb.streamOrder !== undefined) {
        const st = inp.info.subtitleTracks[sb.streamOrder];
        if (!st) throw new Error('The selected subtitle track does not exist in this file.');
        if (isBitmapSubtitle(st.codec)) bitmapSubtitle = st.order;
        else {
          subtitleFile = `sub${k}.ass`;
          await rt.ffmpeg(['-i', inp.path, '-map', `0:s:${st.order}`, '-c:s', 'ass', subtitleFile], { durationSec: inp.info.duration, from: 0, to: 0, stage: 'Preparing subtitles' });
        }
      }
      out.push({ ...inp, crop, subtitleFile, bitmapSubtitle });
    }
    return out;
  }

  function outputPathFor(job: ConvertJob): string {
    const dir = ensureDir(job.outputDir || ctx.settings().convertDir);
    const first = job.inputs[0];
    const base = sanitizeFilename(job.outputName || (first ? first.info.name.replace(/\.[^.]+$/, '') : 'output'));
    const target = getTarget(job.output.targetId);
    if (target?.special === 'html5') {
      let name = base;
      let n = 2;
      while (['mp4', 'webm', 'ogv', 'html'].some((e) => fs.existsSync(path.join(dir, `${name}.${e}`)))) name = `${base} (${n++})`;
      return path.join(dir, `${name}.mp4`);
    }
    return uniquePath(dir, base, job.output.container);
  }

  async function runPlan(plan: ReturnType<typeof buildConvertPlan>, rt: JobRuntime): Promise<string[]> {
    const n = plan.passes.length;
    // first passes of two-pass encodes are faster; give them a smaller share
    const weights = plan.passes.map((p) => (/pass 1 of 2/i.test(p.stage) ? 0.35 : 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const from = acc / sum;
      acc += weights[k];
      await rt.ffmpeg(plan.passes[k].args, { durationSec: plan.passes[k].durationSec, from, to: acc / sum, stage: plan.passes[k].stage });
    }
    for (const f of plan.files) fs.writeFileSync(f.path, f.content, 'utf8');
    return plan.outputs;
  }

  /* ───────── runners ───────── */

  queue.registerRunner('convert', async (job, rt) => {
    const inputs = await resolveInputs(job, rt);
    const wm = await prepareWatermark(job.output, rt);
    const outPath = outputPathFor(job);
    const plan = buildConvertPlan({ inputs, output: job.output, outPath, env: env(), wm });
    return runPlan(plan, rt);
  });

  queue.registerRunner('slideshow', async (job, rt) => {
    const spec = job.slideshow;
    if (!spec) throw new Error('Missing slideshow settings');
    let images = spec.images.filter((p) => fileExists(p));
    if (!images.length) throw new Error('None of the photos could be found.');
    if (spec.shuffle) {
      images = [...images];
      for (let i = images.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [images[i], images[j]] = [images[j], images[i]];
      }
    }
    const probe = ffprobe();
    const music = await Promise.all(spec.music.filter((m) => fileExists(m)).map(async (m) => ({ path: m, duration: await probeDuration(probe, m) })));
    const wm = await prepareWatermark(job.output, rt);
    const dir = ensureDir(job.outputDir || ctx.settings().convertDir);
    const outPath = uniquePath(dir, sanitizeFilename(job.outputName || 'Slideshow'), job.output.container);
    const plan = buildSlideshowPlan({ spec: { ...spec, images }, images, music, output: job.output, outPath, env: env(), wm });
    return runPlan(plan, rt);
  });

  /* ───────── handlers ───────── */

  function validateTarget(output: OutputSpec): void {
    const t = getTarget(output.targetId);
    if (t?.special === 'dvd' || t?.special === 'bluray') throw new Error(`Use "to ${t.label}" in the disc tools to create a ${t.label}.`);
  }

  function dryRun(inputs: ConvertInput[], output: OutputSpec): void {
    // surfaces problems (no audio, nothing left after cuts, photos …) before queuing
    const resolved: ResolvedInput[] = inputs.map((i) => ({
      ...i,
      crop: i.edit.crop,
      subtitleFile: i.edit.subtitles?.path || (i.edit.subtitles?.streamOrder !== undefined && !isBitmapSubtitle(i.info.subtitleTracks[i.edit.subtitles.streamOrder]?.codec ?? '') ? 'sub.ass' : undefined),
      bitmapSubtitle: i.edit.subtitles?.streamOrder !== undefined && isBitmapSubtitle(i.info.subtitleTracks[i.edit.subtitles.streamOrder]?.codec ?? '') ? i.edit.subtitles.streamOrder : undefined,
    }));
    buildConvertPlan({ inputs: resolved, output, outPath: 'C:\\out\\x.' + output.container, env: env(), wm: { textFile: 'wm.txt', fontFile: 'f.ttf' } });
  }

  const targetLabel = (o: OutputSpec) => getTarget(o.targetId)?.label ?? o.container.toUpperCase();

  const module: CoreModule & JobQueue = {
    enqueue: (j) => queue.enqueue(j),
    registerRunner: (k, r) => queue.registerRunner(k, r),
    state: () => ({ jobs: queue.list() }),
    capabilities: () => ({ hwEncoders: [...hwEncoders] }),
    isBusy: () => queue.isBusy(),
    dispose: () => {
      off();
      queue.dispose();
    },
    handlers: {
      'convert.probe': async ({ paths }) => {
        const results = await Promise.allSettled(paths.map((p) => probeOne(p)));
        const ok = results.filter((r): r is PromiseFulfilledResult<MediaInfo> => r.status === 'fulfilled').map((r) => r.value);
        const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (!ok.length && bad.length) throw new Error(errMessage(bad[0].reason));
        for (const b of bad) ctx.toast('warning', errMessage(b.reason));
        return ok;
      },
      'convert.frame': async ({ path: p, time, width }) => {
        const buf = await ctx.media.frame(p, Math.max(0, time || 0), Math.min(1920, Math.max(32, width ?? 640)));
        return 'data:image/jpeg;base64,' + buf.toString('base64');
      },
      'convert.thumbs': async ({ path: p, count, width }) => {
        const dur = await probeDuration(ffprobe(), p);
        const n = Math.max(1, Math.min(60, count || 10));
        return Array.from({ length: n }, (_, k) => ctx.media.frameUrl(p, dur > 0 ? ((k + 0.5) * dur) / n : 0, width ?? 160));
      },
      'convert.detectCrop': async ({ path: p }) => {
        const info = await probeOne(p);
        if (!info.video) return null;
        return detectCrop(ctx.engines.require('ffmpeg'), info.path, info.duration, info.video.width, info.video.height);
      },
      'convert.add': ({ inputs, join, output, outputDir, outputName }) => {
        if (!inputs.length) throw new Error('Add some files first.');
        validateTarget(output);
        const dir = outputDir || ctx.settings().convertDir;
        const label = targetLabel(output);
        if (join && inputs.length > 1) {
          dryRun(inputs, output);
          return [
            queue.enqueue({
              kind: 'convert',
              title: `Join ${inputs.length} files → ${label}`,
              inputs,
              join: true,
              output,
              outputDir: dir,
              outputName: outputName || `${inputs[0].info.name.replace(/\.[^.]+$/, '')} (joined)`,
            }),
          ];
        }
        for (const i of inputs) dryRun([i], output);
        return inputs.map((i) =>
          queue.enqueue({
            kind: 'convert',
            title: `${i.info.name} → ${label}`,
            inputs: [i],
            join: false,
            output,
            outputDir: dir,
            outputName: inputs.length === 1 ? outputName : undefined,
          }),
        );
      },
      'convert.slideshow': ({ spec, output, outputDir, outputName }) => {
        if (!spec.images.length) throw new Error('Add at least one photo.');
        validateTarget(output);
        return queue.enqueue({
          kind: 'slideshow',
          title: `Photo slideshow (${spec.images.length} photo${spec.images.length === 1 ? '' : 's'}) → ${targetLabel(output)}`,
          inputs: [],
          join: false,
          output,
          outputDir: outputDir || ctx.settings().convertDir,
          outputName,
          slideshow: spec,
        });
      },
      'convert.estimateSize': ({ inputs, join, output }) => {
        try {
          return estimateOutputBytes(inputs, join, output);
        } catch {
          return 0;
        }
      },
      'convert.cancel': ({ ids }) => queue.cancel(ids),
      'convert.remove': ({ ids }) => queue.remove(ids),
      'convert.retry': ({ ids }) => queue.retry(ids),
      'convert.clearCompleted': () => queue.clearCompleted(),
    },
  };
  return module;
}
