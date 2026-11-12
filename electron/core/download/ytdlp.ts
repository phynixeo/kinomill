// Runs yt-dlp for analysis / search and spawns download processes.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AnalyzeResult, ChannelTab, PlaylistEntry, SearchResult } from '../../../shared/types';
import type { Ctx } from '../context';
import { ensureDir, runCapture, spawnProc, uid } from '../util';
import { buildAnalyzeResult, buildSearchResults, channelBaseUrl, isYoutubeChannelUrl, normalizeChannelUrl } from './analyze';
import { commonArgs, friendlyError, isWatchWithList, normalizeUrl, type ArgsEnv } from './args';

export const YTDLP_ENV: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

export class YtDlp {
  constructor(private ctx: Ctx) {}

  exe(): string {
    return this.ctx.engines.require('ytdlp');
  }

  /**
   * Build the shared environment. Cookie files are copied into `cookieDir` so that
   * parallel yt-dlp processes never write to the same file at the same time.
   */
  env(cookieDir: string): ArgsEnv {
    const settings = this.ctx.settings();
    const ff = this.ctx.engines.path('ffmpeg');
    let cookiesFile: string | undefined;
    const src = settings.cookiesMode === 'app' ? this.ctx.paths.cookies : settings.cookiesMode === 'file' ? settings.cookiesFile : '';
    if (src && fs.existsSync(src)) {
      ensureDir(cookieDir);
      cookiesFile = path.join(cookieDir, 'cookies.txt');
      try {
        fs.copyFileSync(src, cookiesFile);
      } catch {
        cookiesFile = undefined;
      }
    }
    return {
      settings,
      ffmpegDir: ff ? path.dirname(ff) : undefined,
      denoPath: this.ctx.engines.path('deno'),
      cookiesFile,
      archivePath: this.ctx.paths.archive,
    };
  }

  /** Run yt-dlp with -J style args and parse the JSON it prints. */
  async json(extra: string[], timeoutMs: number): Promise<Record<string, unknown>> {
    const exe = this.exe();
    const scratch = path.join(this.ctx.paths.temp, uid('yj-'));
    try {
      const args = [...commonArgs(this.env(scratch)), ...extra];
      const r = await runCapture(exe, args, { timeoutMs, env: YTDLP_ENV, maxBuffer: 256 * 1024 * 1024 });
      const out = r.stdout.trim();
      if (r.code !== 0 || !out) {
        if (r.code === null) throw new Error('Timed out while reading the page. Try again, or check your connection.');
        throw new Error(friendlyError(r.stderr || out));
      }
      // -J prints a single JSON document; be tolerant of stray lines before it
      const start = out.indexOf('{');
      return JSON.parse(start > 0 ? out.slice(start) : out) as Record<string, unknown>;
    } finally {
      fs.rm(scratch, { recursive: true, force: true }, () => undefined);
    }
  }

  async analyze(rawUrl: string, flat?: boolean, channelTab?: ChannelTab): Promise<AnalyzeResult> {
    let url = normalizeUrl(rawUrl);
    if (!/^https?:\/\//i.test(url) && !/^ytsearch/i.test(url)) throw new Error('Please paste a valid link (it should start with https://).');
    if (isYoutubeChannelUrl(url) && channelTab) return this.analyzeChannel(channelBaseUrl(url), channelTab);
    if (isYoutubeChannelUrl(url)) url = normalizeChannelUrl(url);
    const args = ['-J', '--flat-playlist'];
    if (flat) args.push('--yes-playlist');
    else if (isWatchWithList(url)) args.push('--no-playlist');
    args.push('--', url);
    const playlistLike = flat || isYoutubeChannelUrl(url) || /[?&]list=|\/playlist|\/sets\/|\/showcase\//i.test(url);
    const info = await this.json(args, playlistLike ? 10 * 60_000 : 120_000);
    const res = buildAnalyzeResult(info, url);
    if (res.type === 'playlist' && isYoutubeChannelUrl(url)) {
      res.isChannel = true;
      res.channelTab = /\/shorts\b/i.test(url) ? 'shorts' : /\/(streams|live)\b/i.test(url) ? 'streams' : 'videos';
    }
    return res;
  }

  /**
   * Every video of a channel tab — or of all tabs (regular videos, Shorts and past live streams)
   * merged without duplicates. Tabs a channel doesn't have are skipped.
   */
  private async analyzeChannel(base: string, tab: ChannelTab): Promise<AnalyzeResult> {
    const tabs: Exclude<ChannelTab, 'all'>[] = tab === 'all' ? ['videos', 'shorts', 'streams'] : [tab];
    const results = await Promise.all(
      tabs.map(async (t) => {
        try {
          const info = await this.json(['-J', '--flat-playlist', '--yes-playlist', '--', `${base}/${t}`], 15 * 60_000);
          return { t, res: buildAnalyzeResult(info, `${base}/${t}`) };
        } catch (e) {
          if (tabs.length === 1) throw e;
          return null; // e.g. "This channel does not have a shorts tab"
        }
      }),
    );
    const ok = results.filter((r): r is NonNullable<typeof r> => !!r && r.res.type === 'playlist');
    if (!ok.length) throw new Error('No videos were found on this channel.');
    const seen = new Set<string>();
    const entries: PlaylistEntry[] = [];
    for (const { t, res } of ok) {
      for (const e of res.entries ?? []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push({ ...e, index: entries.length + 1, section: t === 'shorts' ? 'short' : t === 'streams' ? 'live' : 'video' });
      }
    }
    const first = ok[0].res;
    return {
      ...first,
      url: tab === 'all' ? base : `${base}/${tab}`,
      webpageUrl: base,
      title: first.title.replace(/ - (Videos|Shorts|Live|Streams)$/i, ''),
      entries,
      entryCount: entries.length,
      isChannel: true,
      channelTab: tab,
    };
  }

  /** Newest entries of a playlist / channel (used by subscriptions). */
  async listEntries(url: string, limit?: number): Promise<AnalyzeResult> {
    const u = isYoutubeChannelUrl(url) ? normalizeChannelUrl(url) : url;
    const args = ['-J', '--flat-playlist', '--yes-playlist'];
    if (limit) args.push('--playlist-end', String(limit));
    args.push('--', u);
    const info = await this.json(args, limit ? 180_000 : 10 * 60_000);
    return buildAnalyzeResult(info, u);
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const n = Math.min(100, Math.max(1, Math.floor(limit)));
    const info = await this.json(['-J', '--flat-playlist', '--', `ytsearch${n}:${q}`], 90_000);
    return buildSearchResults(info);
  }

  spawn(args: string[]): ChildProcess {
    return spawnProc(this.exe(), args, { env: YTDLP_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  }
}
