import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiArgs, ApiMethod, ApiResult, AppEvent, AppState, Capabilities, ConvertJob, JobKind, Settings } from '../../shared/types';
import { debounce, ensureDir } from './util';
import type { Engines } from './engines';
import type { MediaServer } from './mediaServer';

/** What the surrounding shell (Electron, or the plain-Node dev server) provides to the core. */
export interface Host {
  kind: 'electron' | 'server';
  appVersion: string;
  dataDir: string;
  videosDir: string;
  notify(title: string, body: string, onClick?: () => void): void;
  openPath(p: string): Promise<void>;
  showInFolder(p: string): void;
  openExternal(url: string): Promise<void>;
  readClipboard(): Promise<string>;
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
  pickFiles(opts: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean; folders?: boolean }): Promise<string[]>;
  saveFile(opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  preventSleep(on: boolean): void;
  /**
   * Opens a browser window so the user can sign in; calls `opened` with the browser's name once it is up.
   * Resolves with Netscape cookies.txt content, or null when the user cancelled.
   */
  signIn?(url: string, opened: (browser: string) => void): Promise<{ cookiesTxt: string; count: number; sites: string[] } | null>;
  /** Ends a running sign-in: save the cookies (true) or discard them (false). */
  finishSignIn?(save: boolean): void;
  signOut?(): Promise<void>;
}

/* ───────── Event bus ───────── */

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(50);
  }
  emit(ev: AppEvent): void {
    this.ee.emit('event', ev);
  }
  on(cb: (ev: AppEvent) => void): () => void {
    this.ee.on('event', cb);
    return () => this.ee.off('event', cb);
  }
}

/* ───────── JSON persistence ───────── */

export class JsonStore<T> {
  private value: T;
  private writeSoon: (() => void) & { flush(): void };
  constructor(
    private file: string,
    defaults: T,
  ) {
    let loaded: T = defaults;
    try {
      if (fs.existsSync(file)) loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (e) {
      // keep a copy of the corrupt file for inspection and start fresh
      try {
        fs.copyFileSync(file, file + '.corrupt');
      } catch {
        /* ignore */
      }
      console.error('[store] failed to read', file, e);
    }
    this.value = loaded;
    this.writeSoon = debounce(() => this.writeNow(), 400);
  }
  get(): T {
    return this.value;
  }
  set(v: T): void {
    this.value = v;
    this.writeSoon();
  }
  /** Mark as changed after mutating get() in place. */
  touch(): void {
    this.writeSoon();
  }
  flush(): void {
    this.writeSoon.flush();
  }
  private writeNow(): void {
    try {
      ensureDir(path.dirname(this.file));
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] write failed', this.file, e);
    }
  }
}

/* ───────── Module contract ───────── */

export type Handler<M extends ApiMethod> = (args: ApiArgs<M>) => Promise<ApiResult<M>> | ApiResult<M>;
export type Handlers = { [M in ApiMethod]?: Handler<M> };

export interface CoreModule {
  handlers: Handlers;
  /** Contribute to the initial app state. */
  state?(): Partial<AppState>;
  /** Contribute capability flags (merged into AppState.capabilities). */
  capabilities?(): Partial<Capabilities>;
  /** True while the module has active work (prevents sleep, delays "after queue" action). */
  isBusy?(): boolean;
  dispose?(): void | Promise<void>;
}

export interface Paths {
  data: string;
  bin: string;
  temp: string;
  cookies: string; // cookies.txt written by in-app sign in
  archive: string; // yt-dlp download archive (skip duplicates)
}

export interface Privacy {
  /** True if this item must be hidden from the UI right now. */
  isHidden(item: { private?: boolean }): boolean;
}

export interface Ctx {
  host: Host;
  paths: Paths;
  bus: Bus;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  engines: Engines;
  media: MediaServer;
  privacy: Privacy;
  log(...args: unknown[]): void;
  toast(level: 'info' | 'success' | 'warning' | 'error', message: string): void;
  /** Desktop notification (respects settings.notifyOnComplete). */
  notifyDone(title: string, body: string, filePath?: string): void;
  /** Modules call this whenever their busy state may have changed. */
  busyChanged(): void;
  /** Recompute capabilities and broadcast them (e.g. after the AI pack finished installing). */
  capabilitiesChanged(): void;
}

/* ───────── Job queue (owned by the convert module, used by disc + audio modules) ───────── */

export interface JobRuntime {
  /** Aborted when the user cancels the job. */
  signal: AbortSignal;
  /** Report progress 0..1 with optional stage text, speed ("2.3x") and ETA seconds. */
  progress(p: number, stage?: string, speed?: string, eta?: number): void;
  /** A private temp folder for this job (deleted afterwards). */
  tempDir: string;
  /**
   * Run ffmpeg with the given args (without the leading "-hide_banner -y" — added automatically),
   * parsing `-progress` output against `durationSec` to report progress in [from, to] of the job.
   * Rejects with the tail of ffmpeg's stderr on failure; killed automatically on cancel.
   */
  ffmpeg(args: string[], opts: { durationSec: number; from?: number; to?: number; stage?: string }): Promise<void>;
  /** Run any other process; killed on cancel. Lines from stdout+stderr are passed to onLine. */
  run(cmd: string, args: string[], opts?: { onLine?: (line: string) => void; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; tail: string }>;
}

/** Runs one job of a given kind; returns the output file (or folder) paths. */
export type JobRunner = (job: ConvertJob, rt: JobRuntime) => Promise<string[]>;

export interface JobQueue {
  /** Add a job (status 'queued') and start it when a slot is free. */
  enqueue(job: Omit<ConvertJob, 'status' | 'progress' | 'createdAt' | 'id'> & { id?: string }): ConvertJob;
  registerRunner(kind: JobKind, runner: JobRunner): void;
}
