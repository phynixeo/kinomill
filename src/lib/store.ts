// Global UI store: the backend AppState (kept live by events) plus UI-only state.
import { useSyncExternalStore } from 'react';
import type { ApiArgs, ApiMethod, ApiResult, AppEvent, AppState, EditSpec, MediaInfo, SlideshowSpec } from '../../shared/types';
import { defaultEdit } from '../../shared/defaults';
import { invoke, onEvent, onReconnect } from './api';
import { playChime } from './sound';
import type { DlDialog } from './actions';

export type Page = 'downloads' | 'subscriptions' | 'converter' | 'slideshow' | 'audio' | 'tasks' | 'settings';

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export interface ConvItem {
  key: string;
  info: MediaInfo;
  edit: EditSpec;
}

export interface Full {
  app: AppState | null;
  loadError?: string;
  page: Page;
  toasts: Toast[];
  conv: ConvItem[];
  join: boolean;
  /** download ids whose result should be added to the converter when finished */
  toConverter: string[];
  /** download ids whose result should be added to Audio Tools when finished */
  toAudio: string[];
  audioFiles: string[];
  slideshow: SlideshowSpec;
  subsFilter?: string; // subscription id to filter downloads by
  dlDialog?: DlDialog;
}

const initial: Full = {
  app: null,
  page: 'downloads',
  toasts: [],
  conv: [],
  join: false,
  toConverter: [],
  toAudio: [],
  audioFiles: [],
  slideshow: {
    images: [],
    secondsPerImage: 4,
    transition: 'fade',
    transitionSeconds: 1,
    panZoom: true,
    music: [],
    width: 1920,
    height: 1080,
    fps: 30,
    shuffle: false,
  },
};

let state: Full = initial;
const listeners = new Set<() => void>();

export function getState(): Full {
  return state;
}

export function setState(patch: Partial<Full> | ((s: Full) => Partial<Full>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function setApp(fn: (a: AppState) => Partial<AppState>): void {
  setState((s) => (s.app ? { app: { ...s.app, ...fn(s.app) } } : {}));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Select a slice of the store. The selector must return existing references (no new arrays/objects). */
export function useStore<T>(sel: (s: Full) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function useApp(): AppState {
  const app = useStore((s) => s.app);
  if (!app) throw new Error('App state not loaded');
  return app;
}

/* ───────── toasts ───────── */
let toastId = 1;
export function toast(level: Toast['level'], message: string, opts: { action?: Toast['action']; sticky?: boolean; ms?: number } = {}): number {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, message, action: opts.action, sticky: opts.sticky }] }));
  if (!opts.sticky) setTimeout(() => dismissToast(id), opts.ms ?? (level === 'error' ? 9000 : 5000));
  return id;
}
export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Call the backend; on failure show an error toast and return undefined. */
export async function call<M extends ApiMethod>(method: M, ...args: ApiArgs<M> extends void ? [] : [ApiArgs<M>]): Promise<ApiResult<M> | undefined> {
  try {
    return await invoke(method, ...args);
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

export function go(page: Page): void {
  setState({ page });
}

/* ───────── converter list helpers ───────── */
let convKey = 1;
export function addToConverter(infos: MediaInfo[]): void {
  const items = infos.filter((i) => !i.isImage).map((info) => ({ key: `c${convKey++}`, info, edit: { ...defaultEdit(), audioTrack: info.audioTracks.length ? 0 : -1 } }));
  if (items.length) setState((s) => ({ conv: [...s.conv, ...items] }));
}

export async function addPathsToConverter(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const infos = await call('convert.probe', { paths });
  if (!infos) return;
  const bad = paths.length - infos.length;
  if (bad > 0) toast('warning', `${bad} file(s) could not be read as video or audio.`);
  addToConverter(infos);
}

/* ───────── event handling ───────── */
function upsert<T extends { id: string }>(list: T[], item: T, prepend = true): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function applyEvent(ev: AppEvent): void {
  const app = state.app;
  if (!app) return;
  switch (ev.type) {
    case 'download': {
      const prev = app.downloads.find((d) => d.id === ev.item.id);
      setApp((a) => ({ downloads: upsert(a.downloads, ev.item) }));
      if (ev.item.status === 'completed' && prev && prev.status !== 'completed') {
        if (app.settings.playSoundOnComplete) playChime();
        if (ev.item.filePath && state.toConverter.includes(ev.item.id)) {
          setState((s) => ({ toConverter: s.toConverter.filter((x) => x !== ev.item.id) }));
          void addPathsToConverter([ev.item.filePath]).then(() => toast('success', `"${ev.item.title}" was added to the Converter.`));
        }
        if (ev.item.filePath && state.toAudio.includes(ev.item.id)) {
          const fp = ev.item.filePath;
          setState((s) => ({ toAudio: s.toAudio.filter((x) => x !== ev.item.id), audioFiles: [...s.audioFiles, fp] }));
          toast('success', `"${ev.item.title}" was added to Audio Tools.`);
        }
      }
      break;
    }
    case 'download-removed':
      setApp((a) => ({ downloads: a.downloads.filter((d) => d.id !== ev.id) }));
      break;
    case 'downloads-reset':
      setApp(() => ({ downloads: ev.items }));
      break;
    case 'subscription':
      setApp((a) => ({ subscriptions: upsert(a.subscriptions, ev.item, false) }));
      break;
    case 'subscription-removed':
      setApp((a) => ({ subscriptions: a.subscriptions.filter((x) => x.id !== ev.id) }));
      break;
    case 'job': {
      const prev = app.jobs.find((j) => j.id === ev.job.id);
      setApp((a) => ({ jobs: upsert(a.jobs, ev.job) }));
      if (ev.job.status === 'completed' && prev && prev.status !== 'completed' && app.settings.playSoundOnComplete) playChime();
      if (ev.job.status === 'failed' && prev && prev.status !== 'failed') toast('error', `"${ev.job.title}" failed: ${ev.job.error ?? 'unknown error'}`);
      break;
    }
    case 'job-removed':
      setApp((a) => ({ jobs: a.jobs.filter((j) => j.id !== ev.id) }));
      break;
    case 'engines':
      setApp(() => ({ engines: ev.engines }));
      break;
    case 'settings':
      setApp(() => ({ settings: ev.settings }));
      break;
    case 'privacy':
      setApp(() => ({ privacy: ev.privacy }));
      void reload(); // private items appear/disappear
      break;
    case 'auth':
      setApp(() => ({ auth: ev.auth }));
      break;
    case 'capabilities':
      setApp(() => ({ capabilities: ev.capabilities }));
      break;
    case 'clipboard-link':
      clipboardHandler?.(ev.url);
      break;
    case 'toast':
      toast(ev.level, ev.message);
      break;
  }
}

let clipboardHandler: ((url: string) => void) | undefined;
export function setClipboardHandler(fn: (url: string) => void): void {
  clipboardHandler = fn;
}

export async function reload(): Promise<void> {
  try {
    const app = await invoke('app.state');
    setState({ app, loadError: undefined });
  } catch (e) {
    setState({ loadError: e instanceof Error ? e.message : String(e) });
  }
}

let started = false;
export function startStore(): void {
  if (started) return;
  started = true;
  onEvent(applyEvent);
  onReconnect(() => void reload());
  void reload();
}
