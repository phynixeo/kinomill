// The conversion job queue. Owns every ConvertJob (convert, slideshow, disc and
// audio-tool jobs), runs them through registered runners with a JobRuntime that
// wraps ffmpeg/process execution, progress reporting and cancellation.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ConvertJob, JobKind } from '../../../shared/types';
import { JsonStore, type Ctx, type JobQueue, type JobRunner, type JobRuntime } from '../context';
import { ensureDir, errMessage, isWin, killTree, makeThrottle, onLines, spawnProc, uid } from '../util';

class CanceledError extends Error {
  constructor() {
    super('Canceled');
  }
}

interface Active {
  ac: AbortController;
  children: Set<ChildProcess>;
  outputs: Set<string>;
}

/** Turn the tail of ffmpeg's log into a message a person can act on. */
export function friendlyFfmpegError(tail: string): string {
  const t = tail.toLowerCase();
  if (/no space left on device/.test(t)) return 'The disk is full. Free some space or choose another output folder.';
  if (/permission denied|access is denied/.test(t)) return 'Kinomill cannot write to the output folder. Choose another folder in Settings.';
  if (/no such file or directory/.test(t) && !/font/.test(t)) return 'A file could not be found — it may have been moved or deleted.';
  if (/invalid data found when processing input|moov atom not found/.test(t)) return 'The file is damaged or is not a supported media file.';
  if (/(openencodesessionex|nvenc|cuda).*(fail|error)|no capable devices found|driver does not support/.test(t))
    return 'The GPU encoder failed. Update your graphics driver or turn off hardware acceleration in Settings.';
  if (/unknown encoder/.test(t)) return 'This FFmpeg build does not include the needed encoder. Update FFmpeg in Settings → Components.';
  if (/frame size.*not.*supported|invalid frame size|width or height not divisible/.test(t)) return 'This format does not support the selected frame size. Pick another size.';
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !/^(conversion failed|error while|exiting|\[out#|\[aost|\[vost)/i.test(l));
  const errorish = meaningful.filter((l) => /error|invalid|unable|cannot|could not|not supported|failed|no such/i.test(l));
  return (errorish.pop() ?? meaningful.pop() ?? lines.pop() ?? 'Conversion failed').replace(/^\[[^\]]+\]\s*/, '').slice(0, 300);
}

export class Queue implements JobQueue {
  private store: JsonStore<ConvertJob[]>;
  private runners = new Map<JobKind, JobRunner>();
  private active = new Map<string, Active>();
  private throttle = makeThrottle(250);
  /** Set by the module once ffmpeg is known to be available. */
  ready = false;

  constructor(private ctx: Ctx) {
    this.store = new JsonStore<ConvertJob[]>(path.join(ctx.paths.data, 'jobs.json'), []);
    let changed = false;
    for (const j of this.store.get()) {
      if (j.status === 'running') {
        Object.assign(j, { status: 'failed', error: 'Interrupted — click Retry', stage: undefined, speed: undefined, eta: undefined });
        changed = true;
      }
    }
    if (changed) this.store.touch();
  }

  list(): ConvertJob[] {
    return this.store.get();
  }

  get(id: string): ConvertJob | undefined {
    return this.store.get().find((j) => j.id === id);
  }

  isBusy(): boolean {
    return this.active.size > 0 || this.store.get().some((j) => j.status === 'queued');
  }

  registerRunner(kind: JobKind, runner: JobRunner): void {
    this.runners.set(kind, runner);
    this.pump();
  }

  enqueue(init: Omit<ConvertJob, 'status' | 'progress' | 'createdAt' | 'id'> & { id?: string }): ConvertJob {
    const job: ConvertJob = { ...init, id: init.id ?? uid('j'), status: 'queued', progress: 0, createdAt: Date.now() };
    this.store.get().push(job);
    this.store.touch();
    this.emit(job);
    this.ctx.busyChanged();
    queueMicrotask(() => this.pump());
    return job;
  }

  private emit(job: ConvertJob): void {
    this.ctx.bus.emit({ type: 'job', job: { ...job } });
  }

  private patch(id: string, p: Partial<ConvertJob>, opts: { throttled?: boolean } = {}): ConvertJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    Object.assign(job, p);
    if (opts.throttled) {
      if (this.throttle(id)) {
        this.emit(job);
        this.store.touch();
      }
    } else {
      this.emit(job);
      this.store.touch();
    }
    return job;
  }

  pump(): void {
    if (!this.ready) return;
    const max = Math.max(1, Math.min(8, this.ctx.settings().maxConcurrentConversions || 1));
    while (this.active.size < max) {
      const next = this.store.get().find((j) => j.status === 'queued' && !this.active.has(j.id) && this.runners.has(j.kind));
      if (!next) break;
      void this.start(next);
    }
  }

  cancel(ids: string[]): void {
    for (const id of ids) {
      const job = this.get(id);
      if (!job) continue;
      const act = this.active.get(id);
      if (act) {
        act.ac.abort();
        for (const c of act.children) killTree(c);
      } else if (job.status === 'queued') {
        this.patch(id, { status: 'canceled', stage: undefined });
      }
    }
    this.ctx.busyChanged();
  }

  remove(ids: string[]): void {
    this.cancel(ids);
    const set = new Set(ids);
    const jobs = this.store.get();
    const keep = jobs.filter((j) => !set.has(j.id));
    if (keep.length === jobs.length) return;
    this.store.set(keep);
    for (const id of ids) this.ctx.bus.emit({ type: 'job-removed', id });
    this.ctx.busyChanged();
  }

  retry(ids: string[]): void {
    for (const id of ids) {
      const job = this.get(id);
      if (!job || this.active.has(id) || job.status === 'queued' || job.status === 'running') continue;
      this.patch(id, {
        status: 'queued',
        progress: 0,
        error: undefined,
        stage: undefined,
        speed: undefined,
        eta: undefined,
        outputPaths: undefined,
        startedAt: undefined,
        completedAt: undefined,
      });
    }
    this.ctx.busyChanged();
    this.pump();
  }

  clearCompleted(): void {
    const done = this.store.get().filter((j) => j.status === 'completed' || j.status === 'canceled').map((j) => j.id);
    this.remove(done);
  }

  private async start(job: ConvertJob): Promise<void> {
    const runner = this.runners.get(job.kind)!;
    const act: Active = { ac: new AbortController(), children: new Set(), outputs: new Set() };
    this.active.set(job.id, act);
    const tempDir = ensureDir(path.join(this.ctx.paths.temp, 'job-' + job.id));
    const startedAt = Date.now();
    this.patch(job.id, { status: 'running', startedAt, progress: 0, stage: 'Starting', error: undefined, speed: undefined, eta: undefined });
    this.ctx.busyChanged();

    const rt = this.runtime(job.id, act, tempDir, startedAt);
    try {
      const snapshot: ConvertJob = JSON.parse(JSON.stringify(this.get(job.id) ?? job));
      const outputs = await runner(snapshot, rt);
      if (act.ac.signal.aborted) throw new CanceledError();
      this.patch(job.id, { status: 'completed', progress: 1, stage: undefined, speed: undefined, eta: 0, outputPaths: outputs, completedAt: Date.now() });
      const done = this.get(job.id);
      if (done) this.ctx.notifyDone(job.kind === 'disc' ? 'Disc ready' : 'Conversion complete', done.title, outputs[0]);
    } catch (e) {
      const canceled = act.ac.signal.aborted || e instanceof CanceledError;
      for (const o of act.outputs) fs.rm(o, { recursive: true, force: true }, () => undefined);
      if (canceled) this.patch(job.id, { status: 'canceled', stage: undefined, speed: undefined, eta: undefined });
      else {
        this.ctx.log('job failed', job.id, e);
        this.patch(job.id, { status: 'failed', error: errMessage(e), stage: undefined, speed: undefined, eta: undefined });
      }
    } finally {
      this.active.delete(job.id);
      fs.rm(tempDir, { recursive: true, force: true }, () => undefined);
      this.ctx.busyChanged();
      this.pump();
    }
  }

  private runtime(id: string, act: Active, tempDir: string, startedAt: number): JobRuntime {
    const report = (p: number, stage?: string, speed?: string, eta?: number) => {
      const progress = Math.max(0, Math.min(1, p));
      let e = eta;
      if (e === undefined && progress > 0.02) {
        const elapsed = (Date.now() - startedAt) / 1000;
        e = Math.round((elapsed * (1 - progress)) / progress);
      }
      const patch: Partial<ConvertJob> = { progress, eta: e };
      if (stage !== undefined) patch.stage = stage;
      if (speed !== undefined) patch.speed = speed;
      this.patch(id, patch, { throttled: true });
    };

    const track = (child: ChildProcess) => {
      act.children.add(child);
      const onAbort = () => killTree(child);
      act.ac.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => {
        act.children.delete(child);
        act.ac.signal.removeEventListener('abort', onAbort);
      });
    };

    const rt: JobRuntime = {
      signal: act.ac.signal,
      tempDir,
      progress: report,
      ffmpeg: (args, opts) =>
        new Promise<void>((resolve, reject) => {
          if (act.ac.signal.aborted) return reject(new CanceledError());
          const ffmpeg = this.ctx.engines.require('ffmpeg');
          const from = opts.from ?? 0;
          const to = opts.to ?? 1;
          const out = args[args.length - 1];
          if (out && out !== '-' && !/^(nul|\/dev\/null|pipe:)/i.test(out) && path.isAbsolute(out) && !fs.existsSync(out)) act.outputs.add(out);
          if (opts.stage) report(from, opts.stage);
          const child = spawnProc(ffmpeg, ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { cwd: tempDir });
          track(child);
          const tailLines: string[] = [];
          onLines(child.stderr, (l) => {
            tailLines.push(l);
            if (tailLines.length > 60) tailLines.shift();
          });
          let outTime = 0;
          let speedStr: string | undefined;
          onLines(child.stdout, (l) => {
            const eq = l.indexOf('=');
            if (eq < 0) return;
            const k = l.slice(0, eq);
            const v = l.slice(eq + 1).trim();
            if (k === 'out_time_us' || k === 'out_time_ms') {
              const n = Number(v);
              if (Number.isFinite(n) && n > 0) outTime = n / 1e6;
            } else if (k === 'speed') {
              speedStr = v && v !== 'N/A' ? v.replace(/\s+/g, '') : undefined;
            } else if (k === 'progress') {
              const dur = opts.durationSec;
              const frac = dur > 0 ? Math.min(1, outTime / dur) : 0;
              const sp = speedStr ? parseFloat(speedStr) : 0;
              const remainingThis = dur > 0 && sp > 0 ? (dur - outTime) / sp : undefined;
              // later passes of the same job are assumed to run at a similar speed
              const later = dur > 0 && sp > 0 && to < 1 && to > from ? (dur / sp) * ((1 - to) / (to - from)) : 0;
              const eta = remainingThis !== undefined ? Math.max(0, Math.round(remainingThis + later)) : undefined;
              report(from + (to - from) * frac, undefined, speedStr, eta);
            }
          });
          child.on('error', (e) => reject(e));
          child.on('close', (code) => {
            if (act.ac.signal.aborted) return reject(new CanceledError());
            if (code === 0) {
              report(to);
              resolve();
            } else reject(new Error(friendlyFfmpegError(tailLines.join('\n'))));
          });
        }),
      run: (cmd, args, opts = {}) =>
        new Promise((resolve, reject) => {
          if (act.ac.signal.aborted) return reject(new CanceledError());
          const child = spawnProc(cmd, args, { cwd: opts.cwd ?? tempDir, env: opts.env ?? process.env });
          track(child);
          const tail: string[] = [];
          const onLine = (l: string) => {
            tail.push(l);
            if (tail.length > 60) tail.shift();
            try {
              opts.onLine?.(l);
            } catch {
              /* ignore listener errors */
            }
          };
          onLines(child.stdout, onLine);
          onLines(child.stderr, onLine);
          child.on('error', (e) => reject(e));
          child.on('close', (code) => {
            if (act.ac.signal.aborted) return reject(new CanceledError());
            resolve({ code, tail: tail.join('\n') });
          });
        }),
    };
    return rt;
  }

  flush(): void {
    this.store.flush();
  }

  dispose(): void {
    for (const [, act] of this.active) {
      act.ac.abort();
      for (const c of act.children) killTree(c);
    }
    // jobs that were running are marked interrupted on next start
    this.store.flush();
  }
}

export const NULL_DEVICE = isWin ? 'NUL' : '/dev/null';
