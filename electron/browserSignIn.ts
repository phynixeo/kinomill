// Sign-in through the user's own Chrome / Edge / Brave instead of an embedded window.
//
// Google refuses sign-ins from embedded browsers such as Electron windows
// ("Couldn't sign you in — this browser or app may not be secure"). So we start
// the real browser with a separate profile kept in the app's data folder (the
// user's everyday profile is never touched) and read that profile's cookies over
// the DevTools protocol. We only talk to the browser itself, never attach to the
// pages, so sites cannot tell anything is different from a normal browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export interface FoundBrowser {
  name: string;
  exe: string;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
}

export interface SignInResult {
  cookiesTxt: string;
  count: number;
  sites: string[];
}

export function findBrowser(): FoundBrowser | null {
  const env = process.env;
  const cands: [string, string | undefined, string][] = [];
  if (process.platform === 'win32') {
    const pf = env['ProgramFiles'];
    const pf86 = env['ProgramFiles(x86)'];
    const local = env['LOCALAPPDATA'];
    // Chrome first: a fresh Edge profile signs itself into the PC's Microsoft account.
    for (const base of [pf, pf86, local]) cands.push(['Google Chrome', base, 'Google/Chrome/Application/chrome.exe']);
    for (const base of [pf, local]) cands.push(['Brave', base, 'BraveSoftware/Brave-Browser/Application/brave.exe']);
    for (const base of [pf86, pf]) cands.push(['Microsoft Edge', base, 'Microsoft/Edge/Application/msedge.exe']);
  } else if (process.platform === 'darwin') {
    cands.push(['Google Chrome', '/Applications', 'Google Chrome.app/Contents/MacOS/Google Chrome']);
    cands.push(['Brave', '/Applications', 'Brave Browser.app/Contents/MacOS/Brave Browser']);
    cands.push(['Microsoft Edge', '/Applications', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) cands.push([bin, '/usr/bin', bin]);
  }
  for (const [name, base, rel] of cands) {
    if (!base) continue;
    const exe = path.join(base, rel);
    if (fs.existsSync(exe)) return { name, exe };
  }
  return null;
}

/** "accounts.google.co.in" → "google.co.in", "www.youtube.com" → "youtube.com" (good enough for grouping cookies). */
export function siteOf(host: string): string {
  const parts = host.replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const n = tld.length === 2 && ['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go'].includes(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const GOOGLE_FAMILY = /^(google\.[a-z.]+|youtube\.com|youtube-nocookie\.com|googleusercontent\.com)$/;

/** Keeps only cookies of sites the user actually opened in the sign-in browser. */
export function filterCookies<T extends { domain: string }>(cookies: T[], visited: Set<string>): T[] {
  const sites = new Set([...visited].map(siteOf));
  const google = [...sites].some((s) => GOOGLE_FAMILY.test(s));
  return cookies.filter((c) => {
    const s = siteOf(c.domain);
    return sites.has(s) || (google && GOOGLE_FAMILY.test(s));
  });
}

export function toCookiesTxt(cookies: CdpCookie[], appName: string): SignInResult {
  const lines = ['# Netscape HTTP Cookie File', `# Written by ${appName}. Do not share this file.`, ''];
  const sites = new Set<string>();
  for (const c of cookies) {
    if (!c.domain) continue;
    sites.add(c.domain.replace(/^\./, ''));
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = c.session || !(c.expires > 0) ? 0 : Math.floor(c.expires);
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + c.domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', String(exp), c.name, c.value].join('\t'));
  }
  return { cookiesTxt: lines.join('\n') + '\n', count: cookies.length, sites: [...sites] };
}

export interface BrowserSignIn {
  /** Cookies of the visited sites once the user is done, or null when cancelled. */
  result: Promise<CdpCookie[] | null>;
  /** Save (or discard) and close the sign-in browser. */
  finish(save: boolean): Promise<void>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBrowserSignIn(browser: FoundBrowser, profileDir: string, url: string): Promise<BrowserSignIn> {
  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });

  const proc = spawn(
    browser.exe,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--new-window',
      url,
    ],
    { stdio: 'ignore', detached: false },
  );
  let exited = false;
  const exitedP = new Promise<void>((r) => {
    proc.once('exit', () => {
      exited = true;
      r();
    });
    proc.once('error', () => {
      exited = true;
      r();
    });
  });

  // the browser writes its DevTools port into the profile once it is up
  const t0 = Date.now();
  let port = '';
  let wsPath = '';
  for (;;) {
    try {
      [port = '', wsPath = ''] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
    } catch {
      /* not written yet */
    }
    if (/^\d+$/.test(port) && wsPath.startsWith('/devtools/browser/')) break;
    if (exited) throw new Error(`${browser.name} closed straight away. If a sign-in window from earlier is still open, close it and try again.`);
    if (Date.now() - t0 > 30_000) {
      proc.kill();
      throw new Error(`${browser.name} did not start in time. Try again.`);
    }
    await delay(150);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new Error(`Could not connect to ${browser.name}: ${e.message}`)));
  }).catch((e) => {
    proc.kill();
    throw e;
  });
  ws.on('error', () => undefined); // a later socket error just ends the session ('close' follows)

  let nextId = 1;
  const pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      const cb = msg.id ? pending.get(msg.id) : undefined;
      if (cb) {
        pending.delete(msg.id);
        cb(msg);
      }
    } catch {
      /* ignore */
    }
  });
  const send = <R>(method: string, params: object = {}, timeoutMs = 4000) =>
    new Promise<R | null>((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) return resolve(null);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.error ? null : ((msg.result as R) ?? null));
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const visited = new Set<string>();
  try {
    visited.add(new URL(url).hostname);
  } catch {
    /* ignore */
  }
  let latest: CdpCookie[] = [];
  let noPagesSince = 0;
  let settled = false;
  let resolveResult!: (v: CdpCookie[] | null) => void;
  const result = new Promise<CdpCookie[] | null>((r) => (resolveResult = r));

  const snapshot = async () => {
    const targets = await send<{ targetInfos: { type: string; url: string }[] }>('Target.getTargets');
    const pages = targets?.targetInfos.filter((t) => t.type === 'page') ?? [];
    for (const p of pages) {
      if (/^https?:/i.test(p.url)) {
        try {
          visited.add(new URL(p.url).hostname);
        } catch {
          /* ignore */
        }
      }
    }
    const c = await send<{ cookies: CdpCookie[] }>('Storage.getCookies');
    if (c?.cookies) latest = c.cookies;
    return { pages: targets ? pages.length : -1 };
  };

  const settle = (save: boolean) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    resolveResult(save ? filterCookies(latest, visited) : null);
  };

  const close = async () => {
    await send('Browser.close', {}, 2000);
    ws.close();
    await Promise.race([exitedP, delay(3000)]);
    if (!exited) proc.kill();
  };

  let polling = false;
  const poll = setInterval(async () => {
    if (polling || settled) return;
    polling = true;
    try {
      const { pages } = await snapshot();
      // all windows closed but the browser keeps running in the background
      if (pages === 0) {
        noPagesSince ||= Date.now();
        if (Date.now() - noPagesSince > 2500) {
          settle(true);
          void close();
        }
      } else noPagesSince = 0;
    } finally {
      polling = false;
    }
  }, 1500);

  // user closed the browser: keep what we read last (at most 1.5 s old)
  ws.on('close', () => settle(true));
  void exitedP.then(() => settle(true));

  return {
    result,
    async finish(save) {
      if (settled) return;
      if (save) await snapshot();
      settle(save);
      await close();
    },
  };
}
