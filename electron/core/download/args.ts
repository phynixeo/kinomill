// Pure helpers for building yt-dlp command lines and parsing its output.
import path from 'node:path';
import type { DownloadItem, DownloadOptions, Settings } from '../../../shared/types';
import { sanitizeFilename } from '../util';

export interface ArgsEnv {
  settings: Settings;
  ffmpegDir?: string;
  denoPath?: string;
  /** Cookie file to pass with --cookies (already resolved for cookiesMode 'app' / 'file'). */
  cookiesFile?: string;
  archivePath: string;
}

/** Options every yt-dlp invocation gets (analysis, search, downloads). */
export function commonArgs(env: ArgsEnv): string[] {
  const s = env.settings;
  const a = ['--ignore-config', '--color', 'never', '--socket-timeout', '30'];
  if (env.denoPath) a.push('--js-runtimes', `deno:${env.denoPath}`);
  if (env.ffmpegDir) a.push('--ffmpeg-location', env.ffmpegDir);
  if (s.proxyEnabled && s.proxyUrl.trim()) a.push('--proxy', s.proxyUrl.trim());
  if (s.cookiesMode === 'browser') a.push('--cookies-from-browser', s.cookiesBrowser);
  else if ((s.cookiesMode === 'app' || s.cookiesMode === 'file') && env.cookiesFile) a.push('--cookies', env.cookiesFile);
  return a;
}

export const PROGRESS_TEMPLATE =
  'download:VFPROG %(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta,fragment_index,fragment_count,filename,tmpfilename})j VFSEP %(info.{format_id,vcodec,acodec})j';
export const PP_TEMPLATE = 'postprocess:VFPP %(progress.{status,postprocessor})j';
export const META_PRINT =
  'before_dl:VFMETA %(.{id,title,thumbnail,duration,uploader,channel,extractor_key,webpage_url,format_id,ext,filesize,filesize_approx,vcodec,acodec,height,fps,abr})j';
export const REQ_PRINT = 'before_dl:VFREQ %(requested_formats.:.{format_id,filesize,filesize_approx,vcodec,acodec})j';
export const DONE_PRINT = 'after_move:VFDONE %(filepath)j';

const AUDIO_FORMAT: Record<string, string> = { mp3: 'mp3', m4a: 'm4a', opus: 'opus', ogg: 'vorbis', wav: 'wav', flac: 'flac' };
const LOSSLESS = new Set(['wav', 'flac']);

/** Format (-f) and sort (-S) expressions for the given options. */
export function formatSelection(o: DownloadOptions): { format: string; sort?: string } {
  const lang = o.audioLanguage ? `[language^=${o.audioLanguage}]` : '';
  const alts: string[] = [];
  const push = (...xs: string[]) => {
    for (const x of xs) if (!alts.includes(x)) alts.push(x);
  };

  if (o.kind === 'audio') {
    if (o.audioFormatId) push(o.audioFormatId);
    if (lang) push(`ba${lang}`);
    push('ba', 'b');
    const c = o.container;
    const sort = c === 'm4a' ? '+acodec:m4a' : c === 'opus' || c === 'ogg' ? 'acodec:opus' : undefined;
    return { format: alts.join('/'), sort };
  }

  const q = /^\d+$/.test(o.quality) ? Number(o.quality) : 0;
  const h = q ? `[height<=${q}]` : '';
  const webm = o.container === 'webm';
  const ew = webm ? '[ext=webm]' : '';

  if (o.videoFormatId) {
    const v = o.videoFormatId;
    if (o.audioFormatId) push(`${v}+${o.audioFormatId}`);
    if (lang) push(`${v}+ba${ew}${lang}`, `${v}+ba${lang}`);
    if (ew) push(`${v}+ba${ew}`);
    push(`${v}+ba`, v);
  }
  if (webm) {
    if (lang) push(`bv${ew}${h}+ba${ew}${lang}`);
    push(`bv${ew}${h}+ba${ew}`);
  }
  if (lang) push(`bv${h}+ba${lang}`);
  push(`bv${h}+ba`, `bv*${h}+ba`, `b${h}`, 'bv*+ba', 'b');

  const sort: string[] = [q ? `res:${q}` : 'res', 'fps'];
  const pref = o.codecPreference;
  if (pref === 'h264') sort.push('+vcodec:avc');
  else if (pref === 'vp9') sort.push('vcodec:vp9');
  else if (pref === 'av1') sort.push('vcodec:av01');
  else if (pref === 'hevc') sort.push('vcodec:h265');
  else if (o.container === 'mp4' || o.container === 'mov') sort.push('+vcodec:avc');
  else if (webm) sort.push('vcodec:vp9');
  if (o.container === 'mp4' || o.container === 'mov') sort.push('+acodec:m4a');
  else if (webm) sort.push('acodec:opus');
  return { format: alts.join('/'), sort: sort.join(',') };
}

export interface DownloadPlan {
  args: string[];
  outputDir: string;
}

/** Full argument list for downloading one item. */
export function buildDownloadArgs(item: DownloadItem, env: ArgsEnv & { tempDir: string; limitDivisor: number }): DownloadPlan {
  const s = env.settings;
  const o = item.options;
  const a = commonArgs(env);
  a.push('--newline', '--progress', '--no-simulate', '--no-playlist', '--no-quiet');
  a.push('--progress-template', PROGRESS_TEMPLATE, '--progress-template', PP_TEMPLATE);
  a.push('--print', META_PRINT, '--print', REQ_PRINT, '--print', DONE_PRINT);
  a.push('--retries', String(s.retries), '--fragment-retries', String(s.retries), '--extractor-retries', String(Math.min(3, s.retries)));
  a.push('--concurrent-fragments', '4', '--trim-filenames', '150', '--windows-filenames');
  if (s.speedLimitKBps > 0) a.push('--limit-rate', `${Math.max(1, Math.floor(s.speedLimitKBps / Math.max(1, env.limitDivisor)))}K`);
  if (s.skipDuplicates) a.push('--download-archive', env.archivePath);

  // output location
  let outputDir = o.outputDir || s.downloadDir;
  if (item.playlistTitle && s.playlistSubfolder) outputDir = path.join(outputDir, sanitizeFilename(item.playlistTitle, 100));
  let tpl = (s.filenameTemplate || '%(title)s').replace(/\.%\(ext\)s$/i, '').trim() || '%(title)s';
  if (s.numberPlaylistItems && item.playlistIndex) tpl = `${String(item.playlistIndex).padStart(2, '0')} - ${tpl}`;
  a.push('-P', outputDir, '-P', `temp:${env.tempDir}`, '-o', `${tpl}.%(ext)s`);

  const sel = formatSelection(o);
  a.push('-f', sel.format);
  if (sel.sort) a.push('-S', sel.sort);

  if (o.kind === 'audio') {
    const fmt = AUDIO_FORMAT[o.container] ?? 'mp3';
    a.push('-x', '--audio-format', fmt);
    if (!LOSSLESS.has(o.container)) a.push('--audio-quality', /^\d+$/.test(o.quality) ? `${o.quality}K` : '0');
    if (s.embedThumbnail && o.container !== 'wav') a.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    if (s.embedMetadata) a.push('--embed-metadata');
  } else {
    const c = o.container;
    a.push('--merge-output-format', c === 'webm' ? 'webm/mkv' : c);
    if (c !== 'webm') a.push('--remux-video', c);
    if (s.embedThumbnail && c !== 'webm') a.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    if (s.embedMetadata) a.push('--embed-metadata');
    if (s.embedChapters) a.push('--embed-chapters');
  }

  const subs = o.subtitles;
  if (subs?.enabled && subs.langs.length) {
    const langs = subs.langs.includes('*') ? 'all,-live_chat' : subs.langs.join(',');
    a.push('--sub-langs', langs);
    if (subs.includeAuto) a.push('--write-auto-subs');
    const embed = subs.embed && o.kind === 'video';
    if (embed) {
      const fmt = o.container === 'webm' ? 'vtt' : o.container === 'mkv' ? subs.format : 'srt';
      a.push('--embed-subs', '--convert-subs', fmt);
    } else {
      a.push('--write-subs', '--convert-subs', subs.format);
    }
  }

  if (o.section && o.section.end > o.section.start) {
    a.push('--download-sections', `*${fmtTime(o.section.start)}-${fmtTime(o.section.end)}`);
  }
  if (o.splitChapters) {
    a.push('--split-chapters', '-o', `chapter:${tpl} - %(section_number)02d %(section_title)s.%(ext)s`);
  }
  if (s.sponsorBlockRemove) a.push('--sponsorblock-remove', 'sponsor');

  a.push('--', item.url);
  return { args: a, outputDir };
}

function fmtTime(sec: number): string {
  return (Math.round(sec * 1000) / 1000).toString();
}

/* ───────── output parsing ───────── */

export type ParsedLine =
  | { kind: 'progress'; status: string; downloaded?: number; total?: number; speed?: number; eta?: number; fragIndex?: number; fragCount?: number; filename?: string; tmpfilename?: string; formatId?: string; vcodec?: string; acodec?: string }
  | { kind: 'pp'; status: string; postprocessor: string }
  | { kind: 'meta'; data: Record<string, unknown> }
  | { kind: 'req'; formats: { format_id: string; filesize?: number; filesize_approx?: number; vcodec?: string; acodec?: string }[] }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string }
  | { kind: 'other'; text: string };

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseLine(line: string): ParsedLine {
  if (line.startsWith('VFPROG ')) {
    const [p, i] = line.slice(7).split(' VFSEP ');
    const prog = (safeJson(p) ?? {}) as Record<string, unknown>;
    const info = (safeJson(i ?? '{}') ?? {}) as Record<string, unknown>;
    return {
      kind: 'progress',
      status: String(prog.status ?? 'downloading'),
      downloaded: n(prog.downloaded_bytes),
      total: n(prog.total_bytes) ?? n(prog.total_bytes_estimate),
      speed: n(prog.speed),
      eta: n(prog.eta),
      fragIndex: n(prog.fragment_index),
      fragCount: n(prog.fragment_count),
      filename: typeof prog.filename === 'string' ? prog.filename : undefined,
      tmpfilename: typeof prog.tmpfilename === 'string' ? prog.tmpfilename : undefined,
      formatId: typeof info.format_id === 'string' ? info.format_id : undefined,
      vcodec: typeof info.vcodec === 'string' ? info.vcodec : undefined,
      acodec: typeof info.acodec === 'string' ? info.acodec : undefined,
    };
  }
  if (line.startsWith('VFPP ')) {
    const d = (safeJson(line.slice(5)) ?? {}) as Record<string, unknown>;
    return { kind: 'pp', status: String(d.status ?? ''), postprocessor: String(d.postprocessor ?? '') };
  }
  if (line.startsWith('VFMETA ')) {
    const d = safeJson(line.slice(7));
    return { kind: 'meta', data: (d && typeof d === 'object' ? d : {}) as Record<string, unknown> };
  }
  if (line.startsWith('VFREQ ')) {
    const d = safeJson(line.slice(6));
    return { kind: 'req', formats: Array.isArray(d) ? (d as never[]) : [] };
  }
  if (line.startsWith('VFDONE ')) {
    const d = safeJson(line.slice(7));
    return { kind: 'done', path: typeof d === 'string' ? d : line.slice(7).trim() };
  }
  if (/^ERROR:/.test(line)) return { kind: 'error', message: line.replace(/^ERROR:\s*/, '') };
  return { kind: 'other', text: line };
}

const PP_STAGES: Record<string, string> = {
  Merger: 'Merging video and audio',
  VideoRemuxer: 'Remuxing',
  VideoConvertor: 'Converting video',
  ExtractAudio: 'Converting audio',
  EmbedThumbnail: 'Embedding thumbnail',
  ThumbnailsConvertor: 'Preparing thumbnail',
  EmbedSubtitle: 'Embedding subtitles',
  SubtitlesConvertor: 'Converting subtitles',
  Metadata: 'Writing metadata',
  SponsorBlock: 'Finding sponsor segments',
  ModifyChapters: 'Removing sponsor segments',
  SplitChapters: 'Splitting chapters',
  FixupM3u8: 'Fixing container',
  FixupM4a: 'Fixing container',
  FixupStretched: 'Fixing aspect ratio',
  FixupDuplicateMoov: 'Fixing container',
  FixupTimestamp: 'Fixing timestamps',
  MoveFiles: 'Finishing',
};

export function stageForPostprocessor(pp: string): string {
  return PP_STAGES[pp] ?? PP_STAGES[pp.replace(/^FFmpeg/, '').replace(/PP$/, '')] ?? 'Processing';
}

/* ───────── errors ───────── */

export function friendlyError(raw: string): string {
  const text = raw || '';
  const errLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^ERROR:/.test(l))
      .pop()
      ?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '') ?? '';
  const t = text.toLowerCase();
  if (/sign in to confirm you.?re not a bot|confirm you are not a robot|bot detection/.test(t))
    return 'YouTube wants to confirm you are not a bot. Open Settings → Sign in (or use cookies from your browser) and try again.';
  if (/could not copy .*cookie database|failed to decrypt with dpapi|app.?bound encryption|cookies? from browser/.test(t) && /cookie/.test(t))
    return 'Could not read cookies from your browser. Close the browser completely, or use Settings → Sign in inside Kinomill instead (Chrome/Edge often block this; Firefox works best).';
  if (/private video/.test(t)) return 'This video is private. Sign in with an account that has access (Settings → Sign in) and try again.';
  if (/members?[- ]only|join this channel/.test(t)) return 'This video is for channel members only. Sign in with a member account (Settings → Sign in).';
  if (/sign in to confirm your age|age[- ]restricted|inappropriate for some users/.test(t))
    return 'This video is age-restricted. Sign in with an adult account (Settings → Sign in) to download it.';
  if (/not available in your country|geo[- ]?restrict|blocked it in your country|not made this video available in your country/.test(t))
    return 'This video is not available in your country. You can try a proxy (Settings → Connection).';
  if (/unsupported url/.test(t)) return 'This link is not supported. Check that it points to a video, playlist or channel page.';
  if (/video unavailable|this video has been removed|does not exist|404: not found|http error 404/.test(t)) return 'The video is unavailable — it may have been removed or the link is wrong.';
  if (/http error 403|403: forbidden/.test(t)) return 'The site refused the download (HTTP 403). Try again later, update yt-dlp in Settings → Components, or sign in.';
  if (/http error 429|too many requests/.test(t)) return 'The site is rate-limiting downloads (too many requests). Wait a while, reduce simultaneous downloads, or sign in.';
  if (/certificate ?verify|certificateverifyerror|ssl: |ssl certificate|curl: \(60\)|certificate_verify_failed/.test(t))
    return 'A secure (HTTPS) connection to the site could not be verified. An antivirus, firewall or proxy that inspects HTTPS traffic may be interfering — try disabling it or using a different network.';
  if (/getaddrinfo failed|name or service not known|failed to resolve|no address associated|network is unreachable|connection refused|timed out|unable to download webpage/.test(t))
    return 'Could not connect. Check your internet connection or proxy settings.';
  if (/drm protected|drm-protected|has_drm/.test(t)) return 'This video is DRM-protected and cannot be downloaded.';
  if (/requested format is not available/.test(t)) return 'The selected quality is no longer available. Pick another quality and try again.';
  if (/ffmpeg (is )?not (found|installed)|ffprobe.*not found|ffmpeg could not be found/.test(t)) return 'FFmpeg is missing. Install it in Settings → Components.';
  if (/no space left on device|disk full|errno 28/.test(t)) return 'The disk is full. Free some space or choose another download folder.';
  if (/permission denied|access is denied|errno 13/.test(t)) return 'Kinomill could not write to the download folder. Choose another folder in Settings.';
  if (/this live event will begin|premieres in|live event will begin/.test(t)) return 'This live stream or premiere has not started yet.';
  if (/javascript runtime|js runtime|no supported javascript|n challenge|signature extraction failed/.test(t))
    return 'YouTube changed something on their side. Update yt-dlp and Deno in Settings → Components and try again.';
  return errLine || text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'Download failed';
}

/* ───────── URL helpers ───────── */

export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!u) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(u)) u = 'https://' + u;
  return u;
}

/** URLs that certainly point at a single video (Smart Mode enqueues these without analyzing first). */
export function looksLikeSingleVideo(url: string): boolean {
  const u = url.toLowerCase();
  if (/youtube\.com\/watch\?/.test(u)) return /[?&]v=/.test(u);
  return [
    /youtu\.be\/[\w-]{6,}/,
    /youtube\.com\/(shorts|live|embed)\/[\w-]{6,}/,
    /vimeo\.com\/\d+/,
    /tiktok\.com\/@[^/]+\/video\/\d+/,
    /instagram\.com\/(p|reel|reels|tv)\/[\w-]+/,
    /(twitter|x)\.com\/[^/]+\/status\/\d+/,
    /facebook\.com\/(.+\/videos\/|watch\/?\?v=|reel\/)/,
    /fb\.watch\//,
    /dailymotion\.com\/video\//,
    /dai\.ly\//,
    /twitch\.tv\/(videos\/\d+|[^/]+\/clip\/|clips\.)/,
    /reddit\.com\/r\/[^/]+\/comments\//,
    /rumble\.com\/v[\w-]+/,
    /bilibili\.com\/video\//,
    /soundcloud\.com\/[^/]+\/(?!sets\/)[^/?#]+/,
  ].some((r) => r.test(u));
}

/** URLs that look like a playlist / channel / collection. */
export function looksLikeCollection(url: string): boolean {
  const u = url.toLowerCase();
  if (/youtube\.com\/(playlist\?|.*[?&]list=)/.test(u) && !/[?&]v=/.test(u)) return true;
  return [
    /youtube\.com\/(@[^/?#]+|channel\/|c\/|user\/)/,
    /soundcloud\.com\/[^/]+\/sets\//,
    /vimeo\.com\/(showcase|channels|album|groups)\//,
    /tiktok\.com\/@[^/?#]+\/?($|\?)/,
    /bandcamp\.com\/album\//,
    /dailymotion\.com\/(playlist|user)\//,
  ].some((r) => r.test(u));
}

/** True for youtube watch URLs that also carry a playlist (list=). */
export function isWatchWithList(url: string): boolean {
  return /youtube\.com\/watch\?/.test(url.toLowerCase()) && /[?&]v=/.test(url) && /[?&]list=/.test(url);
}

/** Extract every http(s) URL from a text/CSV file. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>,;]+/gi)) {
    const u = m[0].replace(/[).\]]+$/, '');
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
