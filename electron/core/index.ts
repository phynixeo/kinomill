// Creates the Kinomill backend: settings, engines, media server and all feature
// modules, and exposes a single `invoke(method, args)` entry point plus an event
// stream. Used by both the Electron main process and the browser dev server.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ApiArgs, ApiMethod, ApiResult, AppEvent, AppState, AuthState, Capabilities, PrivacyState, Settings } from '../../shared/types';
import { defaultDownloadOptions, defaultSettings } from '../../shared/defaults';
import { Bus, JsonStore, type CoreModule, type Ctx, type Handlers, type Host, type Paths } from './context';
import { Engines } from './engines';
import { MediaServer } from './mediaServer';
import { ensureDir, errMessage, isWin } from './util';
import { createDownloadModule } from './download';
import { createConvertModule } from './convert';
import { createDiscModule } from './disc';
import { createAudioModule } from './audio';

export interface Core {
  invoke<M extends ApiMethod>(method: M, args: ApiArgs<M>): Promise<ApiResult<M>>;
  onEvent(cb: (ev: AppEvent) => void): () => void;
  dispose(): Promise<void>;
}

interface PrivateFile {
  salt?: string;
  hash?: string;
}

export async function createCore(host: Host): Promise<Core> {
  const paths: Paths = {
    data: ensureDir(host.dataDir),
    bin: ensureDir(path.join(host.dataDir, 'bin')),
    temp: ensureDir(path.join(host.dataDir, 'temp')),
    cookies: path.join(host.dataDir, 'cookies.txt'),
    archive: path.join(host.dataDir, 'download-archive.txt'),
  };
  // clean leftovers of previous runs
  for (const f of fs.readdirSync(paths.temp)) fs.rm(path.join(paths.temp, f), { recursive: true, force: true }, () => undefined);

  const bus = new Bus();
  const defaults = defaultSettings(host.videosDir, path.sep);
  const settingsStore = new JsonStore<Settings>(path.join(paths.data, 'settings.json'), defaults);
  // fill in keys added in newer versions
  settingsStore.set({ ...defaults, ...settingsStore.get(), smartOptions: { ...defaultDownloadOptions(), ...settingsStore.get().smartOptions } });

  const engines = new Engines(paths.bin, bus);
  const media = new MediaServer(engines);
  await media.start();

  /* ───── privacy (password-protected private downloads) ───── */
  const privateStore = new JsonStore<PrivateFile>(path.join(paths.data, 'private.json'), {});
  let unlocked = false;
  const privacyState = (): PrivacyState => ({ hasPassword: !!privateStore.get().hash, unlocked: unlocked || !privateStore.get().hash });
  const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString('hex');
  const verifyPw = (pw: string): boolean => {
    const { salt, hash } = privateStore.get();
    if (!salt || !hash) return true;
    const a = Buffer.from(hashPw(pw, salt), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /* ───── sign-in cookies ───── */
  let signInPending: string | null = null;
  const authState = (): AuthState => {
    try {
      const txt = fs.readFileSync(paths.cookies, 'utf8');
      const lines = txt.split(/\r?\n/).filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')));
      const sites = [...new Set(lines.map((l) => l.replace(/^#HttpOnly_/, '').split('\t')[0].replace(/^\./, '')).map((d) => d.split('.').slice(-2).join('.')))].filter(Boolean);
      // these cookies only exist once a Google account is signed in on YouTube
      const youtube = lines.some((l) => /youtube\.com\t/.test(l) && /\t(LOGIN_INFO|SAPISID|__Secure-3PAPISID)\t/.test(l));
      return { signedIn: lines.length > 0, cookieCount: lines.length, sites, youtube, pending: signInPending };
    } catch {
      return { signedIn: false, cookieCount: 0, sites: [], youtube: false, pending: signInPending };
    }
  };

  const modules: CoreModule[] = [];

  const ctx: Ctx = {
    host,
    paths,
    bus,
    settings: () => settingsStore.get(),
    updateSettings: (patch) => {
      const next = { ...settingsStore.get(), ...patch };
      settingsStore.set(next);
      bus.emit({ type: 'settings', settings: next });
      return next;
    },
    engines,
    media,
    privacy: {
      isHidden: (item) => !!item.private && !privacyState().unlocked,
    },
    log: (...args) => console.log('[kinomill]', ...args),
    toast: (level, message) => bus.emit({ type: 'toast', level, message }),
    notifyDone: (title, body, filePath) => {
      if (!settingsStore.get().notifyOnComplete) return;
      host.notify(title, body, filePath ? () => host.showInFolder(filePath) : undefined);
    },
    busyChanged: () => onBusyChanged(),
    capabilitiesChanged: () => bus.emit({ type: 'capabilities', capabilities: capabilities() }),
  };

  /* ───── feature modules ───── */
  const convert = createConvertModule(ctx);
  modules.push(createDownloadModule(ctx), convert, createDiscModule(ctx, convert), createAudioModule(ctx, convert));

  const capabilities = (): Capabilities => {
    let caps: Capabilities = {
      electron: host.kind === 'electron',
      platform: process.platform,
      hwEncoders: [],
      aiAudioAvailable: false,
      appVersion: host.appVersion,
    };
    for (const m of modules) if (m.capabilities) caps = { ...caps, ...m.capabilities() };
    return caps;
  };

  /* ───── busy tracking: keep PC awake, run "after queue" action ───── */
  let wasBusy = false;
  let afterTimer: NodeJS.Timeout | undefined;
  function onBusyChanged(): void {
    const busy = modules.some((m) => m.isBusy?.());
    host.preventSleep(busy && settingsStore.get().preventSleep);
    if (busy && afterTimer) {
      clearTimeout(afterTimer);
      afterTimer = undefined;
    }
    if (wasBusy && !busy) {
      const action = settingsStore.get().afterQueue;
      if (action !== 'nothing') {
        ctx.toast('warning', `All tasks finished. The PC will ${action === 'shutdown' ? 'shut down' : 'go to sleep'} in 60 seconds (change "When everything is done" in Settings to cancel).`);
        afterTimer = setTimeout(() => {
          afterTimer = undefined;
          const now = settingsStore.get().afterQueue;
          if (now === 'nothing' || modules.some((m) => m.isBusy?.())) return;
          if (!isWin) return;
          if (now === 'shutdown') spawn('shutdown', ['/s', '/t', '0'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          else spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }, 60_000);
      }
    }
    wasBusy = busy;
  }

  /* ───── clipboard monitoring ───── */
  let lastClip = '';
  void host
    .readClipboard()
    .then((t) => (lastClip = t.trim()))
    .catch(() => undefined);
  let clipBusy = false;
  const clipTimer = setInterval(async () => {
    if (!settingsStore.get().monitorClipboard || host.kind !== 'electron' || clipBusy) return;
    let text = '';
    clipBusy = true;
    try {
      text = (await host.readClipboard()).trim();
    } catch {
      return;
    } finally {
      clipBusy = false;
    }
    if (!text || text === lastClip) return;
    lastClip = text;
    if (/^https?:\/\/\S+$/i.test(text) && text.length < 2000) bus.emit({ type: 'clipboard-link', url: text });
  }, 1500);

  /* ───── core handlers ───── */
  const core: Handlers = {
    'app.state': () => {
      let state: AppState = {
        settings: settingsStore.get(),
        downloads: [],
        subscriptions: [],
        jobs: [],
        engines: engines.status(),
        privacy: privacyState(),
        auth: authState(),
        capabilities: capabilities(),
        mediaBase: media.base,
      };
      for (const m of modules) if (m.state) state = { ...state, ...m.state() };
      return state;
    },
    'app.openExternal': async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
      await host.openExternal(url);
    },
    'app.openPath': async ({ path: p }) => host.openPath(p),
    'app.showInFolder': ({ path: p }) => host.showInFolder(p),
    'app.readClipboard': () => host.readClipboard(),
    'app.pickFolder': (a) => host.pickFolder(a),
    'app.pickFiles': (a) => host.pickFiles(a),
    'app.saveFile': (a) => host.saveFile(a),
    'app.writeTextFile': ({ path: p, content }) => {
      fs.writeFileSync(p, content, 'utf8');
    },
    'app.readTextFile': ({ path: p }) => {
      const st = fs.statSync(p);
      if (st.size > 20 * 1024 * 1024) throw new Error('File is too large');
      return fs.readFileSync(p, 'utf8');
    },
    'settings.update': (patch) => {
      const prev = settingsStore.get();
      const next = ctx.updateSettings(patch);
      if (prev.afterQueue !== 'nothing' && next.afterQueue === 'nothing' && afterTimer) {
        clearTimeout(afterTimer);
        afterTimer = undefined;
        ctx.toast('info', 'Automatic shutdown/sleep canceled.');
      }
      return next;
    },
    'engines.install': async ({ name }) => {
      await engines.install(name);
    },
    'engines.checkUpdates': () => engines.checkUpdates(),
    'privacy.setPassword': ({ password, current }) => {
      const st = privateStore.get();
      if (st.hash && !verifyPw(current ?? '')) throw new Error('The current password is not correct');
      if (!password) {
        privateStore.set({});
      } else {
        const salt = randomBytes(16).toString('hex');
        privateStore.set({ salt, hash: hashPw(password, salt) });
      }
      privateStore.flush();
      unlocked = true;
      const ps = privacyState();
      bus.emit({ type: 'privacy', privacy: ps });
      return ps;
    },
    'privacy.unlock': ({ password }) => {
      if (!verifyPw(password)) throw new Error('Wrong password');
      unlocked = true;
      const ps = privacyState();
      bus.emit({ type: 'privacy', privacy: ps });
      return ps;
    },
    'privacy.lock': () => {
      unlocked = false;
      const ps = privacyState();
      bus.emit({ type: 'privacy', privacy: ps });
      return ps;
    },
    'auth.signIn': async ({ url }) => {
      if (!host.signIn) throw new Error('In-app sign in is only available in the desktop app');
      if (signInPending) throw new Error(`Finish the sign-in that is open in ${signInPending} first.`);
      try {
        const r = await host.signIn(url || 'https://www.youtube.com/', (browser) => {
          signInPending = browser;
          bus.emit({ type: 'auth', auth: authState() });
        });
        if (r && r.count > 0) {
          fs.writeFileSync(paths.cookies, r.cookiesTxt, 'utf8');
          ctx.updateSettings({ cookiesMode: 'app' });
        }
      } finally {
        signInPending = null;
      }
      const st = authState();
      bus.emit({ type: 'auth', auth: st });
      return st;
    },
    'auth.finishSignIn': ({ save }) => {
      host.finishSignIn?.(save);
    },
    'auth.signOut': async () => {
      await host.signOut?.();
      fs.rmSync(paths.cookies, { force: true });
      if (settingsStore.get().cookiesMode === 'app') ctx.updateSettings({ cookiesMode: 'none' });
      const st = authState();
      bus.emit({ type: 'auth', auth: st });
      return st;
    },
  };

  const handlers: Handlers = { ...core };
  for (const m of modules) Object.assign(handlers, m.handlers);

  // privacy: hide private downloads from events while locked
  const subscribers = new Set<(ev: AppEvent) => void>();
  bus.on((ev) => {
    if (ev.type === 'download' && ctx.privacy.isHidden(ev.item)) return;
    for (const s of subscribers) {
      try {
        s(ev);
      } catch (e) {
        console.error('[kinomill] subscriber failed', e);
      }
    }
  });

  // detect engines in the background, then install what's missing
  void engines.refresh().then(() => {
    ctx.capabilitiesChanged();
    const missing = engines.status().filter((e) => e.required && !e.installed);
    if (missing.length) {
      ctx.toast('info', `Setting up ${missing.map((m) => m.label).join(', ')} — this happens once.`);
      void engines.installMissing().then(() => {
        const still = engines.status().filter((e) => e.required && !e.installed);
        if (still.length) ctx.toast('error', `Could not install ${still.map((m) => m.label).join(', ')}. Check your internet connection and try again in Settings → Components.`);
        else ctx.toast('success', 'All components are ready.');
        ctx.capabilitiesChanged();
      });
    }
  });

  // Sites change often, so check for a new yt-dlp once a day and update Kinomill's own copy quietly.
  const updateFile = path.join(paths.data, 'update-check.json');
  const autoUpdate = async () => {
    let last = 0;
    try {
      last = JSON.parse(fs.readFileSync(updateFile, 'utf8')).ytdlp ?? 0;
    } catch {
      /* first run */
    }
    if (Date.now() - last < 20 * 3600_000) return;
    const st = (await engines.checkUpdates()).find((e) => e.name === 'ytdlp');
    fs.writeFileSync(updateFile, JSON.stringify({ ytdlp: Date.now() }));
    if (st?.installed && st.source === 'managed' && st.updateAvailable && !modules.some((m) => m.isBusy?.())) {
      await engines.install('ytdlp');
      ctx.toast('success', `The download engine was updated to version ${st.updateAvailable}.`);
    }
  };
  const updateTimer = setInterval(() => void autoUpdate().catch(() => undefined), 6 * 3600_000);
  const firstUpdate = setTimeout(() => void autoUpdate().catch(() => undefined), 60_000);

  return {
    async invoke(method, args) {
      const h = handlers[method] as ((a: unknown) => unknown) | undefined;
      if (!h) throw new Error(`"${method}" is not available`);
      try {
        return (await h(args)) as never;
      } catch (e) {
        throw new Error(errMessage(e));
      }
    },
    onEvent(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    async dispose() {
      clearInterval(clipTimer);
      clearInterval(updateTimer);
      clearTimeout(firstUpdate);
      if (afterTimer) clearTimeout(afterTimer);
      for (const m of modules) await m.dispose?.();
      settingsStore.flush();
      privateStore.flush();
      media.stop();
    },
  };
}
