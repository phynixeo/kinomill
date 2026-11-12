// Locates, installs and updates the external engines Kinomill drives:
//   yt-dlp  – downloading from YouTube and 1000+ sites
//   ffmpeg  – converting, trimming, joining, burning subtitles …
//   deno    – JavaScript runtime yt-dlp uses for YouTube's player challenges
//   tsMuxeR – Blu-ray authoring
// Engines installed by Kinomill live in <data>/bin and always come from the
// projects' official GitHub releases (checksums verified where published).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineName, EngineStatus } from '../../shared/types';
import type { Bus } from './context';
import { ensureDir, errMessage, fileExists, isWin, runCapture, which } from './util';

interface EngineDef {
  name: EngineName;
  label: string;
  description: string;
  required: boolean;
  exe: string; // file name inside bin dir
  repo: string; // GitHub owner/repo
  /** Pick the asset to download from a release. */
  asset: RegExp;
  /** Checksum file asset (optional). */
  checksum?: RegExp;
  /** For zip archives: files to copy out of the archive (matched by basename). */
  extract?: string[];
  versionArgs: string[];
  parseVersion(out: string): string | undefined;
}

const DEFS: EngineDef[] = [
  {
    name: 'ytdlp',
    label: 'yt-dlp',
    description: 'Download engine for YouTube and 1000+ other sites',
    required: true,
    exe: isWin ? 'yt-dlp.exe' : 'yt-dlp',
    repo: 'yt-dlp/yt-dlp',
    asset: isWin ? /^yt-dlp\.exe$/ : process.platform === 'darwin' ? /^yt-dlp_macos$/ : /^yt-dlp_linux$/,
    checksum: /^SHA2-256SUMS$/,
    versionArgs: ['--version'],
    parseVersion: (o) => o.trim().split(/\s+/)[0] || undefined,
  },
  {
    name: 'ffmpeg',
    label: 'FFmpeg',
    description: 'Conversion engine (also used to merge downloaded video and audio)',
    required: true,
    exe: isWin ? 'ffmpeg.exe' : 'ffmpeg',
    repo: 'BtbN/FFmpeg-Builds',
    asset: /^ffmpeg-master-latest-win64-gpl\.zip$/,
    checksum: /^checksums\.sha256$/,
    extract: isWin ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe'],
    versionArgs: ['-hide_banner', '-version'],
    parseVersion: (o) => /ffmpeg version (\S+)/.exec(o)?.[1],
  },
  {
    name: 'deno',
    label: 'Deno',
    description: 'JavaScript runtime yt-dlp needs to unlock YouTube formats',
    required: true,
    exe: isWin ? 'deno.exe' : 'deno',
    repo: 'denoland/deno',
    asset: /^deno-x86_64-pc-windows-msvc\.zip$/,
    checksum: /^deno-x86_64-pc-windows-msvc\.zip\.sha256sum$/,
    extract: [isWin ? 'deno.exe' : 'deno'],
    versionArgs: ['--version'],
    parseVersion: (o) => /deno (\S+)/.exec(o)?.[1],
  },
  {
    name: 'tsmuxer',
    label: 'tsMuxeR',
    description: 'Blu-ray disc authoring (only needed for "to Blu-ray")',
    required: false,
    exe: isWin ? 'tsMuxeR.exe' : 'tsMuxeR',
    repo: 'justdan96/tsMuxer',
    asset: /^tsMuxer-[\d.]+-win64\.zip$/,
    extract: [isWin ? 'tsMuxeR.exe' : 'tsMuxeR'],
    versionArgs: [],
    parseVersion: (o) => /tsMuxeR version ([\w.]+)/i.exec(o)?.[1]?.replace(/\.$/, ''),
  },
];

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export class Engines {
  private st = new Map<EngineName, EngineStatus>();
  private paths = new Map<EngineName, string>();

  constructor(
    private binDir: string,
    private bus: Bus,
  ) {
    for (const d of DEFS) {
      this.st.set(d.name, { name: d.name, label: d.label, description: d.description, required: d.required, installed: false });
    }
  }

  status(): EngineStatus[] {
    return DEFS.map((d) => ({ ...this.st.get(d.name)! }));
  }

  /** Absolute path of an engine executable, if available. */
  path(name: EngineName): string | undefined {
    return this.paths.get(name);
  }

  ffprobePath(): string | undefined {
    const ff = this.paths.get('ffmpeg');
    if (!ff) return undefined;
    const probe = path.join(path.dirname(ff), isWin ? 'ffprobe.exe' : 'ffprobe');
    return fileExists(probe) ? probe : undefined;
  }

  /** Path or a friendly error explaining what is missing. */
  require(name: EngineName): string {
    const p = this.paths.get(name);
    if (!p) {
      const label = DEFS.find((d) => d.name === name)?.label ?? name;
      throw new Error(`${label} is not installed yet. Open Settings → Components and click Install.`);
    }
    return p;
  }

  private emit(): void {
    this.bus.emit({ type: 'engines', engines: this.status() });
  }

  private patch(name: EngineName, p: Partial<EngineStatus>): void {
    const cur = this.st.get(name)!;
    this.st.set(name, { ...cur, ...p });
    this.emit();
  }

  /** Detect installed engines (managed copy in bin dir first, then system PATH). */
  async refresh(): Promise<void> {
    await Promise.all(DEFS.map((d) => this.detect(d)));
    this.emit();
  }

  private async detect(d: EngineDef): Promise<void> {
    const managed = path.join(this.binDir, d.exe);
    const candidates: { p: string; source: 'managed' | 'system' }[] = [];
    if (fileExists(managed)) candidates.push({ p: managed, source: 'managed' });
    const sys = await which(d.exe.replace(/\.exe$/, ''));
    if (sys) candidates.push({ p: sys, source: 'system' });
    for (const c of candidates) {
      if (d.name === 'ffmpeg') {
        const probe = path.join(path.dirname(c.p), isWin ? 'ffprobe.exe' : 'ffprobe');
        // winget installs shims in WinGet\Links; ffprobe sits next to it as well
        if (!fileExists(probe)) continue;
      }
      const version = await this.readVersion(d, c.p);
      if (version !== undefined) {
        this.paths.set(d.name, c.p);
        const cur = this.st.get(d.name)!;
        this.st.set(d.name, { ...cur, installed: true, version, path: c.p, source: c.source, error: undefined });
        return;
      }
    }
    this.paths.delete(d.name);
    const cur = this.st.get(d.name)!;
    this.st.set(d.name, { ...cur, installed: false, version: undefined, path: undefined, source: undefined });
  }

  private async readVersion(d: EngineDef, exe: string): Promise<string | undefined> {
    try {
      const r = await runCapture(exe, d.versionArgs, { timeoutMs: 20000 });
      const v = d.parseVersion(r.stdout + '\n' + r.stderr);
      if (v) return v;
      return r.code === 0 ? 'unknown' : undefined;
    } catch {
      return undefined;
    }
  }

  private async latestRelease(repo: string, tag?: string): Promise<Release> {
    const url = tag ? `https://api.github.com/repos/${repo}/releases/tags/${tag}` : `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Kinomill', Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}`);
    return (await res.json()) as Release;
  }

  /** Compare installed versions with the latest releases. */
  async checkUpdates(): Promise<EngineStatus[]> {
    await Promise.all(
      DEFS.map(async (d) => {
        const cur = this.st.get(d.name)!;
        if (!cur.installed || cur.source !== 'managed') return;
        try {
          const rel = await this.latestRelease(d.repo);
          const latest = rel.tag_name.replace(/^v/, '');
          const installed = (cur.version ?? '').replace(/^v/, '');
          // ffmpeg "latest" builds are rolling; only yt-dlp/deno/tsmuxer have comparable tags
          const comparable = d.name !== 'ffmpeg';
          this.st.set(d.name, { ...cur, updateAvailable: comparable && latest && latest !== installed ? latest : undefined });
        } catch {
          /* offline – ignore */
        }
      }),
    );
    this.emit();
    return this.status();
  }

  private installing = new Map<EngineName, Promise<void>>();

  install(name: EngineName): Promise<void> {
    const running = this.installing.get(name);
    if (running) return running;
    const p = this.doInstall(name).finally(() => this.installing.delete(name));
    this.installing.set(name, p);
    return p;
  }

  private async doInstall(name: EngineName): Promise<void> {
    const d = DEFS.find((x) => x.name === name);
    if (!d) throw new Error('Unknown engine ' + name);
    if (!isWin && d.extract) throw new Error(`Automatic install of ${d.label} is only available on Windows. Please install it with your package manager.`);
    this.patch(name, { busy: true, progress: 0, error: undefined });
    const work = ensureDir(path.join(this.binDir, '.download', name + '-' + Date.now()));
    try {
      const rel = await this.latestRelease(d.repo);
      const asset = rel.assets.find((a) => d.asset.test(a.name));
      if (!asset) throw new Error(`Could not find a download for ${d.label} in release ${rel.tag_name}`);
      const file = path.join(work, asset.name);
      await this.download(asset.browser_download_url, file, (p) => this.patch(name, { progress: p * 0.9 }));

      if (d.checksum) {
        const sumAsset = rel.assets.find((a) => d.checksum!.test(a.name));
        if (sumAsset) {
          const sums = await (await fetch(sumAsset.browser_download_url, { headers: { 'User-Agent': 'Kinomill' } })).text();
          const expected = parseChecksum(sums, asset.name);
          const actual = await sha256(file);
          if (expected && expected.toLowerCase() !== actual) {
            throw new Error(`Checksum mismatch for ${asset.name}; the download was discarded.`);
          }
        }
      }

      ensureDir(this.binDir);
      if (d.extract) {
        const out = ensureDir(path.join(work, 'x'));
        await extractZip(file, out);
        for (const want of d.extract) {
          const found = findFile(out, want);
          if (!found) throw new Error(`${want} was not found inside ${asset.name}`);
          replaceFile(found, path.join(this.binDir, want));
        }
      } else {
        replaceFile(file, path.join(this.binDir, d.exe));
        if (!isWin) fs.chmodSync(path.join(this.binDir, d.exe), 0o755);
      }
      this.patch(name, { progress: 1 });
      await this.detect(d);
      this.patch(name, { busy: false, progress: undefined, updateAvailable: undefined });
    } catch (e) {
      this.patch(name, { busy: false, progress: undefined, error: errMessage(e) });
      throw e;
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => undefined);
    }
  }

  private async download(url: string, dest: string, onProgress: (p: number) => void): Promise<void> {
    const res = await fetch(url, { headers: { 'User-Agent': 'Kinomill' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(dest);
    let got = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        const now = Date.now();
        if (total && now - lastEmit > 250) {
          lastEmit = now;
          onProgress(got / total);
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    if (total && got < total) throw new Error('Download was interrupted');
  }

  /** Install every required engine that is missing. */
  async installMissing(): Promise<void> {
    for (const d of DEFS) {
      if (d.required && !this.st.get(d.name)!.installed) {
        try {
          await this.install(d.name);
        } catch {
          /* status carries the error */
        }
      }
    }
  }
}

function parseChecksum(text: string, fileName: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && path.basename(m[2].trim()) === fileName) return m[1];
  }
  // single-hash files (deno's .sha256sum may contain only the hash, or "hash  file")
  const only = /\b([a-f0-9]{64})\b/i.exec(text);
  return only?.[1];
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function extractZip(zip: string, outDir: string): Promise<void> {
  // Windows 10+ ships bsdtar in System32, which understands .zip archives.
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
  const args = isWin ? ['-xf', zip, '-C', outDir] : ['-o', zip, '-d', outDir];
  const r = await runCapture(tar, args, { timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) throw new Error('Could not extract archive: ' + (r.stderr || r.stdout).slice(0, 300));
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return undefined;
}

/** Replace an executable even if an old copy is locked (rename the old one aside first). */
function replaceFile(src: string, dest: string): void {
  if (fs.existsSync(dest)) {
    const old = dest + '.old-' + Date.now();
    try {
      fs.renameSync(dest, old);
      fs.rm(old, { force: true }, () => undefined);
    } catch {
      fs.rmSync(dest, { force: true });
    }
  }
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}
