// Download queue: starts yt-dlp processes (respecting the concurrency limit),
// tracks progress, supports pause / resume / retry / remove, and persists items.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItem, DownloadOptions } from '../../../shared/types';
import { JsonStore, type Ctx } from '../context';
import { ensureDir, errMessage, fileExists, fileSize, killTree, makeThrottle, onLines, uid } from '../util';
import { buildDownloadArgs, friendlyError, normalizeUrl, parseLine, stageForPostprocessor, type ParsedLine } from './args';
import type { YtDlp } from './ytdlp';

/** Item as persisted (internal fields are stripped before reaching the UI). */
export type StoredItem = DownloadItem & { extraFiles?: string[] };

export interface NewEntry {
  url: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  playlistTitle?: string;
  playlistIndex?: number;
  qualityLabel?: string;
}

interface Run {
  child: ChildProcess;
  stopReason?: 'pause' | 'remove' | 'shutdown';
  formats: { id: string; size?: number }[];
  finished: Set<string>;
  doneBytes: number;
  files: string[];
  tail: string[];
  archiveSkip: boolean;
  lastStage?: string;
}

const SUB_EXT = /\.(srt|vtt|ass|ssa|lrc|ttml|srv[123]|json3)$/i;

export function publicItem(it: StoredItem): DownloadItem {
  const { extraFiles: _x, ...rest } = it;
  return rest;
}

export function defaultQualityLabel(o: DownloadOptions): string {
  const c = o.container.toUpperCase();
  if (o.kind === 'audio') return `${c} ${/^\d+$/.test(o.quality) ? o.quality + ' kbps' : 'best'}`;
  return `${/^\d+$/.test(o.quality) ? o.quality + 'p' : 'Best'} ${c}`;
}

export class DownloadManager {
  private store: JsonStore<StoredItem[]>;
  private runs = new Map<string, Run>();
  private throttle = makeThrottle(250);
  private doneBatch: { title: string; path?: string }[] = [];
  private doneTimer?: NodeJS.Timeout;
  private offBus: () => void;

  constructor(
    private ctx: Ctx,
    private ytdlp: YtDlp,
  ) {
    this.store = new JsonStore<StoredItem[]>(path.join(ctx.paths.data, 'downloads.json'), []);
    const items = Array.isArray(this.store.get()) ? this.store.get() : [];
    for (const it of items) {
      if (it.status === 'downloading' || it.status === 'processing') {
        it.status = 'paused';
        it.speed = undefined;
        it.eta = undefined;
        it.stage = undefined;
      }
    }
    this.store.set(items);
    this.offBus = ctx.bus.on((ev) => {
      if (ev.type === 'engines' || ev.type === 'settings') this.pump();
    });
    setImmediate(() => this.pump());
  }

  private get items(): StoredItem[] {
    return this.store.get();
  }

  partialDir(id: string): string {
    return path.join(this.ctx.paths.data, 'partial', id);
  }

  list(): DownloadItem[] {
    return this.items.filter((i) => !this.ctx.privacy.isHidden(i)).map(publicItem);
  }

  /** All items including hidden private ones (for export / duplicate checks). */
  all(): StoredItem[] {
    return this.items;
  }

  isBusy(): boolean {
    return this.runs.size > 0;
  }

  private emit(it: StoredItem, force = false): void {
    if (force || this.throttle(it.id)) this.ctx.bus.emit({ type: 'download', item: publicItem(it) });
  }

  private changed(it: StoredItem): void {
    this.store.touch();
    this.emit(it, true);
  }

  add(entries: NewEntry[], options: DownloadOptions, extra: { subscriptionId?: string } = {}): DownloadItem[] {
    const now = Date.now();
    const s = this.ctx.settings();
    const created: StoredItem[] = entries
      .filter((e) => e && typeof e.url === 'string' && e.url.trim())
      .map((e, i) => {
        const url = normalizeUrl(e.url);
        return {
          id: uid('d'),
          url,
          title: e.title?.trim() || url,
          thumbnail: e.thumbnail,
          duration: e.duration,
          uploader: e.uploader,
          options: JSON.parse(JSON.stringify(options)) as DownloadOptions,
          qualityLabel: e.qualityLabel || defaultQualityLabel(options),
          status: 'queued',
          progress: 0,
          createdAt: now + i,
          playlistTitle: e.playlistTitle,
          playlistIndex: e.playlistIndex,
          subscriptionId: extra.subscriptionId,
          private: s.privateMode ? true : undefined,
        } satisfies StoredItem;
      });
    if (!created.length) return [];
    this.items.push(...created);
    this.store.touch();
    for (const it of created) this.emit(it, true);
    this.pump();
    return created.map(publicItem);
  }

  pause(ids: string[]): void {
    for (const id of ids) {
      const it = this.items.find((x) => x.id === id);
      if (!it) continue;
      const run = this.runs.get(id);
      if (run) {
        run.stopReason = 'pause';
        killTree(run.child);
      }
      if (run || it.status === 'queued') {
        it.status = 'paused';
        it.speed = undefined;
        it.eta = undefined;
        it.stage = undefined;
        this.changed(it);
      }
    }
    this.ctx.busyChanged();
  }

  resume(ids: string[]): void {
    for (const id of ids) {
      const it = this.items.find((x) => x.id === id);
      if (it && (it.status === 'paused' || it.status === 'failed' || it.status === 'canceled')) {
        it.status = 'queued';
        it.error = undefined;
        this.changed(it);
      }
    }
    this.pump();
  }

  retry(ids: string[]): void {
    for (const id of ids) {
      const it = this.items.find((x) => x.id === id);
      if (it && it.status !== 'downloading' && it.status !== 'processing' && it.status !== 'queued') {
        it.status = 'queued';
        it.error = undefined;
        it.progress = 0;
        it.stage = undefined;
        if (it.status === 'queued' && it.filePath && !fileExists(it.filePath)) it.filePath = undefined;
        this.changed(it);
      }
    }
    this.pump();
  }

  pauseAll(): void {
    this.pause(this.items.filter((i) => ['queued', 'downloading', 'processing'].includes(i.status)).map((i) => i.id));
  }

  resumeAll(): void {
    this.resume(this.items.filter((i) => i.status === 'paused').map((i) => i.id));
  }

  clearCompleted(): void {
    const gone = this.items.filter((i) => i.status === 'completed' && !this.ctx.privacy.isHidden(i));
    if (!gone.length) return;
    const ids = new Set(gone.map((g) => g.id));
    this.store.set(this.items.filter((i) => !ids.has(i.id)));
    for (const g of gone) this.ctx.bus.emit({ type: 'download-removed', id: g.id });
  }

  remove(ids: string[], deleteFiles: boolean): void {
    const set = new Set(ids);
    const gone = this.items.filter((i) => set.has(i.id));
    for (const it of gone) {
      const run = this.runs.get(it.id);
      if (run) {
        run.stopReason = 'remove';
        killTree(run.child);
      }
    }
    this.store.set(this.items.filter((i) => !set.has(i.id)));
    for (const it of gone) {
      this.ctx.bus.emit({ type: 'download-removed', id: it.id });
      // unfinished data is always cleaned up; finished files only on request
      this.removeLater([this.partialDir(it.id)]);
      if (deleteFiles) this.removeLater(this.outputFiles(it));
    }
    this.ctx.busyChanged();
    this.pump();
  }

  /** Output file plus extra outputs and sidecar subtitle files with the same base name. */
  private outputFiles(it: StoredItem): string[] {
    const files = new Set<string>();
    for (const f of [it.filePath, ...(it.extraFiles ?? [])]) if (f) files.add(f);
    if (it.filePath) {
      const dir = path.dirname(it.filePath);
      const stem = path.basename(it.filePath, path.extname(it.filePath));
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(stem + '.') && SUB_EXT.test(name)) files.add(path.join(dir, name));
        }
      } catch {
        /* folder gone */
      }
    }
    return [...files];
  }

  /** Delete files/folders, retrying while a just-killed process still holds them. */
  private removeLater(targets: string[], attempt = 0): void {
    const left: string[] = [];
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
      } catch {
        left.push(t);
      }
    }
    if (left.length && attempt < 8) setTimeout(() => this.removeLater(left, attempt + 1), 750);
  }

  pump(): void {
    if (!this.ctx.engines.path('ytdlp')) return;
    const max = Math.max(1, this.ctx.settings().maxConcurrentDownloads || 1);
    for (const it of this.items) {
      if (this.runs.size >= max) break;
      if (it.status === 'queued' && !this.runs.has(it.id)) this.start(it);
    }
  }

  private start(it: StoredItem): void {
    const settings = this.ctx.settings();
    try {
      const tempDir = ensureDir(this.partialDir(it.id));
      const env = this.ytdlp.env(tempDir);
      const plan = buildDownloadArgs(it, { ...env, tempDir, limitDivisor: settings.maxConcurrentDownloads });
      ensureDir(plan.outputDir);
      const child = this.ytdlp.spawn(plan.args);
      const run: Run = { child, formats: [], finished: new Set(), doneBytes: 0, files: [], tail: [], archiveSkip: false };
      this.runs.set(it.id, run);
      it.status = 'downloading';
      it.stage = 'Preparing download…';
      it.error = undefined;
      it.speed = undefined;
      it.eta = undefined;
      this.changed(it);
      const handle = (line: string) => {
        try {
          this.onLine(it, run, parseLine(line));
        } catch (e) {
          this.ctx.log('download line handler failed', e);
        }
      };
      onLines(child.stdout, handle);
      onLines(child.stderr, handle);
      let ended = false;
      child.on('error', (e) => {
        if (ended) return;
        ended = true;
        run.tail.push('ERROR: ' + errMessage(e));
        this.finish(it, run, -1);
      });
      child.on('close', (code) => {
        if (ended) return;
        ended = true;
        this.finish(it, run, code);
      });
      this.ctx.busyChanged();
    } catch (e) {
      it.status = 'failed';
      it.error = friendlyError(errMessage(e));
      this.changed(it);
    }
  }

  private onLine(it: StoredItem, run: Run, p: ParsedLine): void {
    switch (p.kind) {
      case 'meta': {
        const d = p.data;
        const title = typeof d.title === 'string' ? d.title : undefined;
        if (title && (!it.title || it.title === it.url)) it.title = title;
        if (!it.thumbnail && typeof d.thumbnail === 'string') it.thumbnail = d.thumbnail;
        if (!it.duration && typeof d.duration === 'number') it.duration = d.duration;
        if (!it.uploader) it.uploader = (typeof d.channel === 'string' && d.channel) || (typeof d.uploader === 'string' ? d.uploader : undefined);
        if (!it.extractor && typeof d.extractor_key === 'string') it.extractor = d.extractor_key;
        if (typeof d.format_id === 'string' && !run.formats.length) {
          const size = typeof d.filesize === 'number' ? d.filesize : typeof d.filesize_approx === 'number' ? d.filesize_approx : undefined;
          run.formats = d.format_id.split('+').map((id, i, arr) => ({ id, size: arr.length === 1 ? size : undefined }));
        }
        if (it.options.kind === 'video' && typeof d.height === 'number' && !/^\d+p/.test(it.qualityLabel ?? '')) {
          const fps = typeof d.fps === 'number' && d.fps > 30 ? Math.round(d.fps) : '';
          it.qualityLabel = `${d.height}p${fps} ${it.options.container.toUpperCase()}`;
        }
        this.changed(it);
        break;
      }
      case 'req': {
        if (p.formats.length) run.formats = p.formats.map((f) => ({ id: String(f.format_id), size: f.filesize ?? f.filesize_approx ?? undefined }));
        break;
      }
      case 'progress': {
        if (!p.formatId) return; // subtitle / thumbnail downloads
        const isVid = !!p.vcodec && p.vcodec !== 'none';
        const isAud = !!p.acodec && p.acodec !== 'none';
        const stage = isVid && isAud ? 'Downloading' : isVid ? 'Downloading video' : isAud ? 'Downloading audio' : 'Downloading';
        if (!run.formats.some((f) => f.id === p.formatId)) run.formats.push({ id: p.formatId, size: p.total });
        if (p.status === 'finished' && !run.finished.has(p.formatId)) {
          run.finished.add(p.formatId);
          run.doneBytes += p.downloaded ?? p.total ?? 0;
        }
        const sizes = run.formats.map((f) => f.size);
        const allKnown = sizes.length > 0 && sizes.every((s) => typeof s === 'number' && s > 0);
        let progress: number;
        if (allKnown) {
          const total = sizes.reduce<number>((a, b) => a + (b ?? 0), 0);
          const done = run.doneBytes + (p.status === 'finished' ? 0 : p.downloaded ?? 0);
          progress = total ? done / total : 0;
          it.totalBytes = Math.max(total, done);
          it.downloadedBytes = done;
        } else {
          const n = Math.max(1, run.formats.length);
          const frac = p.total ? (p.downloaded ?? 0) / p.total : p.fragCount ? (p.fragIndex ?? 0) / p.fragCount : 0;
          progress = (run.finished.size - (p.status === 'finished' ? 1 : 0) + (p.status === 'finished' ? 1 : frac)) / n;
          it.totalBytes = p.total;
          it.downloadedBytes = p.downloaded;
        }
        it.progress = Math.max(it.status === 'downloading' ? it.progress : 0, Math.min(0.995, progress));
        it.speed = p.speed;
        it.eta = p.eta;
        const stageChanged = it.stage !== stage || it.status !== 'downloading';
        it.status = 'downloading';
        it.stage = stage;
        this.emit(it, stageChanged);
        break;
      }
      case 'pp': {
        if (p.status === 'started') {
          const stage = stageForPostprocessor(p.postprocessor);
          if (it.status !== 'processing' || it.stage !== stage) {
            it.status = 'processing';
            it.stage = stage;
            it.speed = undefined;
            it.eta = undefined;
            this.emit(it, true);
          }
        }
        break;
      }
      case 'done':
        run.files.push(p.path);
        break;
      case 'error':
        run.tail.push('ERROR: ' + p.message);
        break;
      case 'other':
        if (/has already been recorded in the archive/i.test(p.text)) run.archiveSkip = true;
        run.tail.push(p.text);
        if (run.tail.length > 40) run.tail.splice(0, run.tail.length - 40);
        break;
    }
  }

  private finish(it: StoredItem, run: Run, code: number | null): void {
    this.runs.delete(it.id);
    const stillListed = this.items.includes(it);
    if (run.stopReason === 'remove' || !stillListed) {
      this.ctx.busyChanged();
      this.pump();
      return;
    }
    it.speed = undefined;
    it.eta = undefined;
    if (run.stopReason === 'pause' || run.stopReason === 'shutdown') {
      it.status = 'paused';
      it.stage = undefined;
      this.changed(it);
    } else if (code === 0 && run.files.length) {
      const files = [...new Set(run.files)];
      const main = files.find((f) => path.extname(f).slice(1).toLowerCase() === it.options.container) ?? files[0];
      it.filePath = main;
      it.extraFiles = files.filter((f) => f !== main);
      it.fileSize = fileSize(main) || undefined;
      it.status = 'completed';
      it.progress = 1;
      it.stage = undefined;
      it.error = undefined;
      it.completedAt = Date.now();
      this.changed(it);
      this.removeLater([this.partialDir(it.id)]);
      this.queueNotify(it.title, main);
    } else if (code === 0) {
      it.stage = undefined;
      if (run.archiveSkip || this.ctx.settings().skipDuplicates) {
        it.status = 'canceled';
        it.error = 'Skipped: this video was downloaded before. Turn off "Skip duplicates" in Settings to download it again.';
      } else {
        it.status = 'failed';
        it.error = friendlyError(run.tail.join('\n')) || 'Nothing was downloaded.';
      }
      this.changed(it);
      this.removeLater([this.partialDir(it.id)]);
    } else {
      it.status = 'failed';
      it.stage = undefined;
      it.error = friendlyError(run.tail.join('\n'));
      this.changed(it);
    }
    this.ctx.busyChanged();
    this.pump();
  }

  private queueNotify(title: string, filePath?: string): void {
    this.doneBatch.push({ title, path: filePath });
    if (this.doneTimer) return;
    this.doneTimer = setTimeout(() => {
      const batch = this.doneBatch;
      this.doneBatch = [];
      this.doneTimer = undefined;
      if (batch.length === 1) this.ctx.notifyDone('Download complete', batch[0].title, batch[0].path);
      else if (batch.length > 1) this.ctx.notifyDone('Downloads complete', `${batch.length} files downloaded`, batch[batch.length - 1].path);
    }, 2500);
  }

  async dispose(): Promise<void> {
    this.offBus();
    if (this.doneTimer) clearTimeout(this.doneTimer);
    for (const [id, run] of this.runs) {
      run.stopReason = 'shutdown';
      const it = this.items.find((x) => x.id === id);
      if (it) {
        it.status = 'paused';
        it.stage = undefined;
      }
      killTree(run.child);
    }
    this.store.flush();
  }
}
