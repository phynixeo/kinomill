import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';

export function uid(prefix = ''): string {
  return prefix + Date.now().toString(36) + randomBytes(5).toString('hex');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileExists(p: string | undefined | null): p is string {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string | undefined | null): p is string {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make a string safe to use as a Windows file name (no extension handling). */
export function sanitizeFilename(name: string, maxLen = 150): string {
  let s = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!s) s = 'untitled';
  if (RESERVED.test(s)) s = '_' + s;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/** Returns dir/name.ext, adding " (2)", " (3)" … if the file already exists. */
export function uniquePath(dir: string, name: string, ext: string, taken?: Set<string>): string {
  const base = sanitizeFilename(name);
  const e = ext.startsWith('.') ? ext : '.' + ext;
  let candidate = path.join(dir, base + e);
  let n = 2;
  while (fs.existsSync(candidate) || taken?.has(candidate.toLowerCase())) {
    candidate = path.join(dir, `${base} (${n})${e}`);
    n++;
  }
  taken?.add(candidate.toLowerCase());
  return candidate;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a process to completion and capture its output. */
export function runCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {},
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout?.on('data', (d: Buffer) => {
      if (outLen < max) {
        out.push(d);
        outLen += d.length;
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < max) {
        err.push(d);
        errLen += d.length;
      }
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killTree(child);
      }, opts.timeoutMs);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Run a process and return a binary stdout buffer (e.g. a JPEG frame from ffmpeg). */
export function runBuffer(cmd: string, args: string[], timeoutMs = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20000) stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(lastLines(stderr, 3) || `exit code ${code}`));
    });
  });
}

export function spawnProc(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { windowsHide: true, ...opts });
}

/** Kill a process and all of its children (yt-dlp spawns ffmpeg, etc.). */
export function killTree(child: ChildProcess | number | undefined): void {
  const pid = typeof child === 'number' ? child : child?.pid;
  if (!pid) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Split a stream into lines (handles \r progress updates too). */
export function onLines(stream: NodeJS.ReadableStream | null | undefined, cb: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (d: Buffer | string) => {
    buf += d.toString();
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop() ?? '';
    for (const p of parts) if (p.length) cb(p);
  });
  stream.on('end', () => {
    if (buf.length) cb(buf);
    buf = '';
  });
}

export function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n');
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { flush(): void } {
  let t: NodeJS.Timeout | undefined;
  let lastArgs: Parameters<T> | undefined;
  const wrapped = ((...args: Parameters<T>) => {
    lastArgs = args;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...(lastArgs as Parameters<T>));
    }, ms);
  }) as T & { flush(): void };
  wrapped.flush = () => {
    if (t) {
      clearTimeout(t);
      t = undefined;
      fn(...(lastArgs as Parameters<T>));
    }
  };
  return wrapped;
}

/** Throttle per key: returns true if the caller may emit now. */
export function makeThrottle(ms: number): (key: string) => boolean {
  const last = new Map<string, number>();
  return (key: string) => {
    const now = Date.now();
    const prev = last.get(key) ?? 0;
    if (now - prev >= ms) {
      last.set(key, now);
      return true;
    }
    return false;
  };
}

export function formatSeconds(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`;
}

/** Find an executable on PATH (Windows: uses `where`). */
export async function which(name: string): Promise<string | undefined> {
  try {
    const r = await runCapture(isWin ? 'where' : 'which', [name], { timeoutMs: 5000 });
    if (r.code !== 0) return undefined;
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
