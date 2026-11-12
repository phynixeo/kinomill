// Electron main process: creates the window, implements the Host for the core,
// and bridges the core's invoke/events to the renderer over IPC.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerSaveBlocker, session, shell, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createCore, type Core } from './core';
import type { Host } from './core/context';
import { findBrowser, startBrowserSignIn, toCookiesTxt, type BrowserSignIn, type SignInResult } from './browserSignIn';

const APP_NAME = 'Kinomill';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.phynixeo.kinomill');
// lets tests run against a separate data folder
if (process.env.KINOMILL_DATA) app.setPath('userData', process.env.KINOMILL_DATA);
else migrateOldDataDir();

/** Kinomill used to be called VidForge: carry its settings, engines, history and logins over once. */
function migrateOldDataDir(): void {
  try {
    const oldDir = path.join(app.getPath('appData'), 'VidForge');
    const newDir = app.getPath('userData');
    if (!fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
    if (!fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      return;
    }
    // the new folder may already hold a few files Chromium created at start-up
    for (const name of fs.readdirSync(oldDir)) {
      const to = path.join(newDir, name);
      if (!fs.existsSync(to)) fs.renameSync(path.join(oldDir, name), to);
    }
    fs.rmdirSync(oldDir); // only succeeds when everything was moved; otherwise the rest stays put
  } catch {
    /* the old app may still be running; start with fresh settings */
  }
}

const AUTH_PARTITION = 'persist:vf-auth';
const CHROME_UA = (ua: string) => ua.replace(/\s*Electron\/\S+/, '').replace(/\s*Kinomill\/\S+/, '');

let win: BrowserWindow | null = null;
let core: Core | null = null;
let sleepBlocker: number | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('Kinomill could not start', String(e?.stack ?? e));
    app.quit();
  });
}

/* ───── window state ───── */
interface WinState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}
const winStateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadWinState(): WinState {
  try {
    return { width: 1320, height: 860, ...JSON.parse(fs.readFileSync(winStateFile(), 'utf8')) };
  } catch {
    return { width: 1320, height: 860 };
  }
}
function saveWinState(): void {
  if (!win) return;
  const b = win.getNormalBounds();
  try {
    fs.writeFileSync(winStateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* ignore */
  }
}

/* ───── host implementation ───── */
const host: Host = {
  kind: 'electron',
  appVersion: app.getVersion(),
  dataDir: app.getPath('userData'),
  videosDir: app.getPath('videos'),
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  },
  async openPath(p) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
  showInFolder(p) {
    shell.showItemInFolder(p);
  },
  async openExternal(url) {
    await shell.openExternal(url);
  },
  readClipboard() {
    return clipboard.readText();
  },
  async pickFolder({ title, defaultPath }) {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  async pickFiles({ title, filters, multi, folders }) {
    const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [folders ? 'openDirectory' : 'openFile'];
    if (multi) props.push('multiSelections');
    const r = await dialog.showOpenDialog(win!, { title, filters, properties: props });
    return r.canceled ? [] : r.filePaths;
  },
  async saveFile({ title, defaultPath, filters }) {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath, filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  preventSleep(on) {
    if (on && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
  },
  async signIn(url, opened) {
    // Preferred: the user's real Chrome / Edge / Brave (Google blocks sign-in inside embedded windows).
    const browser = findBrowser();
    if (browser) {
      const s = await startBrowserSignIn(browser, signInProfileDir(), url);
      browserSignIn = s;
      opened(browser.name);
      try {
        const cookies = await s.result;
        return cookies ? toCookiesTxt(cookies, APP_NAME) : null;
      } finally {
        browserSignIn = null;
      }
    }
    // Fallback when no Chromium browser is installed: an app window (works for most sites, not Google).
    opened(`a ${APP_NAME} window`);
    return embeddedSignIn(url);
  },
  finishSignIn(save) {
    if (browserSignIn) void browserSignIn.finish(save);
    else if (embeddedWin && !embeddedWin.isDestroyed()) {
      embeddedDiscard = !save;
      embeddedWin.close();
    }
  },
  async signOut() {
    if (browserSignIn) await browserSignIn.finish(false);
    await session.fromPartition(AUTH_PARTITION).clearStorageData();
    // the browser can hold its profile files for a moment after closing
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(signInProfileDir(), { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  },
};

/* ───── sign-in helpers ───── */
let browserSignIn: BrowserSignIn | null = null;
let embeddedWin: BrowserWindow | null = null;
let embeddedDiscard = false;
const signInProfileDir = () => path.join(app.getPath('userData'), 'sign-in-browser');

function embeddedSignIn(url: string): Promise<SignInResult | null> {
  return new Promise((resolve) => {
    const ses = session.fromPartition(AUTH_PARTITION);
    ses.setUserAgent(CHROME_UA(ses.getUserAgent()));
    embeddedDiscard = false;
    const w = new BrowserWindow({
      width: 1100,
      height: 800,
      parent: win ?? undefined,
      title: 'Sign in — close this window when you are done',
      autoHideMenuBar: true,
      webPreferences: { partition: AUTH_PARTITION, contextIsolation: true, sandbox: true },
    });
    embeddedWin = w;
    w.webContents.setWindowOpenHandler(({ url: u }) => {
      void w.loadURL(u);
      return { action: 'deny' };
    });
    void w.loadURL(url);
    w.on('closed', async () => {
      embeddedWin = null;
      if (embeddedDiscard) return resolve(null);
      const cookies = await ses.cookies.get({});
      resolve(
        toCookiesTxt(
          cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain ?? '',
            path: c.path ?? '/',
            expires: c.expirationDate ?? 0,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            session: !!c.session,
          })),
          APP_NAME,
        ),
      );
    });
  });
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  core = await createCore(host);

  ipcMain.handle('vf:invoke', async (_e, method: string, args: unknown) => {
    try {
      return { ok: true, result: await core!.invoke(method as never, args as never) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.on('vf:titlebar', (_e, opts: { color: string; symbolColor: string }) => {
    try {
      win?.setTitleBarOverlay({ color: opts.color, symbolColor: opts.symbolColor, height: 40 });
    } catch {
      /* not supported on this platform */
    }
  });
  core.onEvent((ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('vf:event', ev);
  });

  createWindow();
}

function createWindow(): void {
  const st = loadWinState();
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Kinomill',
    backgroundColor: dark ? '#14161b' : '#f6f7f9',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#14161b' : '#f6f7f9', symbolColor: dark ? '#e6e8ec' : '#1f2328', height: 40 },
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', saveWinState);
  win.on('closed', () => {
    win = null;
  });

  // never navigate the app window away; open links in the user's browser
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && process.env.KINOMILL_DEBUG) win?.webContents.toggleDevTools();
  });

  const devUrl = process.env.KINOMILL_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.on('window-all-closed', () => {
  app.quit();
});

let disposing = false;
app.on('before-quit', (e) => {
  if (!core || disposing) return;
  disposing = true;
  e.preventDefault();
  core
    .dispose()
    .catch(() => undefined)
    .finally(() => {
      core = null;
      app.quit();
    });
});
