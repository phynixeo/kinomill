// Pure functions that turn yt-dlp's JSON (-J) output into Kinomill's AnalyzeResult.
import type { AnalyzeResult, AudioOption, Chapter, PlaylistEntry, QualityOption, SearchResult, SubtitleTrack } from '../../../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

/** Short codec family from a yt-dlp codec string ("avc1.640028" → "h264"). */
export function codecFamily(codec: string | undefined | null): string {
  const c = (codec ?? '').toLowerCase();
  if (!c || c === 'none') return 'none';
  if (c.startsWith('avc') || c.startsWith('h264')) return 'h264';
  if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return 'hevc';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('av01') || c.startsWith('av1')) return 'av1';
  if (c.startsWith('mp4a') || c === 'aac') return 'aac';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('vorbis')) return 'vorbis';
  if (c.startsWith('mp3')) return 'mp3';
  if (c.startsWith('ac-3') || c.startsWith('ac3')) return 'ac3';
  if (c.startsWith('ec-3') || c.startsWith('eac3')) return 'eac3';
  if (c.startsWith('flac')) return 'flac';
  return c.split('.')[0];
}

function isVideo(f: Json): boolean {
  const vc = f.vcodec;
  if (vc === 'none') return false;
  if (vc) return true;
  // unknown codec: treat as video when it has a height
  return !!num(f.height);
}

function hasAudio(f: Json): boolean {
  const ac = f.acodec;
  if (ac === 'none') return false;
  if (ac) return true;
  return !isVideo(f) || f.audio_ext !== 'none';
}

function isUsable(f: Json): boolean {
  if (f.has_drm) return false;
  const note = String(f.format_note ?? '').toLowerCase();
  if (note.includes('storyboard') || f.ext === 'mhtml') return false;
  if (f.protocol === 'mhtml') return false;
  return true;
}

function estSize(f: Json, duration?: number): number | undefined {
  const s = num(f.filesize) ?? num(f.filesize_approx);
  if (s) return s;
  const tbr = num(f.tbr);
  if (tbr && duration) return Math.round(tbr * 125 * duration);
  return undefined;
}

const resolutionName = (h: number): string => {
  if (h >= 4320) return '8K';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '2K';
  if (h >= 1080) return 'Full HD';
  if (h >= 720) return 'HD';
  return '';
};

/** Codec rank when picking the representative format of a quality group (lower = better). */
function codecRank(fam: string, hdr: boolean): number {
  if (hdr) return ({ vp9: 0, av1: 1, hevc: 2 } as Record<string, number>)[fam] ?? 5;
  return ({ h264: 0, vp9: 1, av1: 2, hevc: 3, vp8: 4 } as Record<string, number>)[fam] ?? 6;
}

function protoRank(p: string | undefined): number {
  if (!p || p === 'https' || p === 'http') return 0;
  if (p.startsWith('http_dash') || p === 'dash') return 1;
  return 2; // m3u8 etc.
}

export function pickAudioFormats(formats: Json[], duration?: number): AudioOption[] {
  let audios = formats.filter((f) => isUsable(f) && !isVideo(f) && hasAudio(f));
  // HLS audio renditions often lack codec/bitrate info; prefer direct (DASH/https) streams when present
  if (audios.some((f) => protoRank(f.protocol) < 2)) audios = audios.filter((f) => protoRank(f.protocol) < 2);
  if (audios.some((f) => f.acodec)) audios = audios.filter((f) => f.acodec);
  // drop dynamic-range-compressed duplicates when a regular variant exists
  const ids = new Set(audios.map((f) => String(f.format_id)));
  const regular = audios.filter((f) => !(String(f.format_id).endsWith('-drc') && ids.has(String(f.format_id).replace(/-drc$/, ''))));
  // best per (language, codec family)
  const best = new Map<string, Json>();
  for (const f of regular) {
    const key = `${f.language ?? ''}|${codecFamily(f.acodec)}`;
    const cur = best.get(key);
    const score = (x: Json) => (num(x.abr) ?? num(x.tbr) ?? 0) - protoRank(x.protocol) * 1000;
    if (!cur || score(f) > score(cur)) best.set(key, f);
  }
  const out: AudioOption[] = [...best.values()].map((f) => {
    const note = String(f.format_note ?? '');
    const isDefault = (num(f.language_preference) ?? -1) >= 10 || /default|original/i.test(note);
    const languageName = str(f.language) ? note.split(',')[0].replace(/\s*(original|\(default\)|default)\s*/gi, ' ').replace(/\s+/g, ' ').trim() || f.language : undefined;
    const abr = num(f.abr) ?? num(f.tbr);
    const acodec = codecFamily(f.acodec);
    return {
      key: `a:${f.format_id}`,
      label: `${abr ? Math.round(abr) + ' kbps ' : ''}${acodec}${languageName ? ' — ' + languageName : ''}${isDefault && languageName ? ' (original)' : ''}`,
      formatId: String(f.format_id),
      abr: abr ? Math.round(abr) : undefined,
      acodec,
      ext: String(f.ext ?? ''),
      language: str(f.language),
      languageName,
      isDefault,
      filesize: estSize(f, duration),
    };
  });
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.languageName ?? '').localeCompare(b.languageName ?? '') || (b.abr ?? 0) - (a.abr ?? 0));
  return out;
}

export function bestAudioSize(audios: AudioOption[]): number {
  const def = audios.filter((a) => a.isDefault || !a.language);
  const pool = def.length ? def : audios;
  return pool.reduce((m, a) => Math.max(m, a.filesize ?? 0), 0);
}

export function groupVideoFormats(formats: Json[], duration?: number, audioSize = 0): QualityOption[] {
  const videos = formats.filter((f) => isUsable(f) && isVideo(f) && num(f.height));
  const groups = new Map<string, Json[]>();
  for (const f of videos) {
    const h = num(f.height)!;
    const fps = Math.round(num(f.fps) ?? 30);
    const fpsClass = fps > 30 ? fps : 30; // 24/25/30 fps all count as "normal"
    const hdr = !!f.dynamic_range && f.dynamic_range !== 'SDR';
    const key = `${h}|${fpsClass}|${hdr ? 1 : 0}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const out: QualityOption[] = [];
  for (const [key, list] of groups) {
    const [h, fpsClass, hdrFlag] = key.split('|').map(Number);
    const hdr = hdrFlag === 1;
    list.sort((a, b) => {
      const pa = protoRank(a.protocol);
      const pb = protoRank(b.protocol);
      if (pa !== pb) return pa - pb;
      // prefer video-only streams (combined formats are usually lower quality)
      const ca = hasAudio(a) ? 1 : 0;
      const cb = hasAudio(b) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const ra = codecRank(codecFamily(a.vcodec), hdr);
      const rb = codecRank(codecFamily(b.vcodec), hdr);
      if (ra !== rb) return ra - rb;
      return (num(b.tbr) ?? 0) - (num(a.tbr) ?? 0);
    });
    const f = list[0];
    const fps = num(f.fps);
    const vsize = estSize(f, duration);
    const combined = hasAudio(f);
    const name = resolutionName(h);
    out.push({
      key: `v:${h}:${fpsClass}:${hdr ? 'hdr' : 'sdr'}`,
      label: `${name ? name + ' ' : ''}${h}p${fps && fps > 30 ? Math.round(fps) : ''}${hdr ? ' HDR' : ''}`,
      height: h,
      width: num(f.width),
      fps: fps ? Math.round(fps * 100) / 100 : undefined,
      hdr,
      vcodec: codecFamily(f.vcodec),
      ext: String(f.ext ?? ''),
      formatId: String(f.format_id),
      filesize: vsize !== undefined ? vsize + (combined ? 0 : audioSize) : undefined,
      tbr: num(f.tbr),
    });
  }
  out.sort((a, b) => b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || Number(b.hdr) - Number(a.hdr));
  return out;
}

export function pickSubtitles(info: Json): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const nameOf = (list: unknown, fallback: string): string => {
    if (Array.isArray(list)) for (const x of list) if (x && typeof x.name === 'string' && x.name) return x.name;
    return fallback;
  };
  const manual = (info.subtitles ?? {}) as Record<string, unknown>;
  for (const [lang, list] of Object.entries(manual)) {
    if (lang === 'live_chat' || lang === 'rechat') continue;
    out.push({ lang, name: nameOf(list, lang), auto: false });
  }
  const auto = (info.automatic_captions ?? {}) as Record<string, unknown>;
  const autoEntries = Object.entries(auto);
  // the original-language auto caption is published as "<lang>-orig"
  const origLangs = new Set(autoEntries.map(([l]) => l).filter((l) => l.endsWith('-orig')).map((l) => l.replace(/-orig$/, '')));
  for (const [lang, list] of autoEntries) {
    if (lang === 'live_chat') continue;
    const base = lang.replace(/-orig$/, '');
    if (lang.endsWith('-orig')) {
      out.push({ lang, name: `${nameOf(list, base).replace(/\s*\(Original\)\s*/i, '')} (auto-generated)`, auto: true });
    } else if (origLangs.has(lang)) {
      continue; // same language as the original auto caption – listed once as "-orig"
    } else {
      const generated = origLangs.size === 0 && autoEntries.length <= 2;
      out.push({ lang, name: `${nameOf(list, lang)} (${generated ? 'auto-generated' : 'auto-translated'})`, auto: true });
    }
  }
  return out;
}

export function pickChapters(info: Json): Chapter[] | undefined {
  if (!Array.isArray(info.chapters) || !info.chapters.length) return undefined;
  return info.chapters
    .map((c: Json) => ({ title: String(c.title ?? ''), start: num(c.start_time) ?? 0, end: num(c.end_time) ?? 0 }))
    .filter((c: Chapter) => c.end > c.start);
}

export function bestThumbnail(info: Json): string | undefined {
  const t = str(info.thumbnail);
  if (t) return t;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
    const sorted = [...info.thumbnails].filter((x: Json) => str(x.url)).sort((a: Json, b: Json) => (num(a.preference) ?? 0) - (num(b.preference) ?? 0) || (num(a.width) ?? 0) - (num(b.width) ?? 0));
    return sorted.length ? str(sorted[sorted.length - 1].url) : undefined;
  }
  return undefined;
}

function entryUrl(e: Json): string | undefined {
  const u = str(e.url) ?? str(e.webpage_url) ?? str(e.original_url);
  if (u && /^https?:\/\//i.test(u)) return u;
  const id = str(e.id);
  const ie = String(e.ie_key ?? e.extractor_key ?? '');
  if (id && /^youtube$/i.test(ie)) return `https://www.youtube.com/watch?v=${id}`;
  return u;
}

const UNAVAILABLE = /^\[(private|deleted|unavailable) video\]$/i;

export function mapEntries(info: Json): PlaylistEntry[] {
  const entries: Json[] = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  const out: PlaylistEntry[] = [];
  let index = 0;
  for (const e of entries) {
    index++;
    const url = entryUrl(e);
    if (!url) continue;
    const title = str(e.title) ?? url;
    if (UNAVAILABLE.test(title)) continue;
    out.push({
      id: String(e.id ?? url),
      url,
      title,
      duration: num(e.duration),
      thumbnail: bestThumbnail(e),
      uploader: str(e.channel) ?? str(e.uploader) ?? str(info.channel) ?? str(info.uploader),
      index: num(e.playlist_index) ?? index,
      live: e.live_status === 'is_live' ? 'now' : e.live_status === 'is_upcoming' ? 'upcoming' : undefined,
    });
  }
  return out;
}

export function isYoutubeChannelUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.|m\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)(\/(videos|shorts|streams|featured|live|playlists)?)?\/?([?#].*)?$/i.test(url);
}

/** https://www.youtube.com/@name/shorts → https://www.youtube.com/@name */
export function channelBaseUrl(url: string): string {
  const m = /^(https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+))/i.exec(url);
  return m ? m[1] : url;
}

/** For bare YouTube channel URLs, analyze the "Videos" tab (what people mean by "the channel"). */
export function normalizeChannelUrl(url: string): string {
  const m = /^(https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+))(?:\/featured)?\/?([?#].*)?$/i.exec(url);
  return m ? `${m[1]}/videos` : url;
}

export function buildAnalyzeResult(info: Json, requestedUrl: string): AnalyzeResult {
  const base = {
    url: requestedUrl,
    id: String(info.id ?? ''),
    title: str(info.title) ?? str(info.fulltitle) ?? requestedUrl,
    uploader: str(info.channel) ?? str(info.uploader) ?? str(info.playlist_uploader),
    thumbnail: bestThumbnail(info),
    extractor: String(info.extractor_key ?? info.extractor ?? 'Generic'),
    webpageUrl: str(info.webpage_url) ?? requestedUrl,
  };
  if (info._type === 'playlist' || (Array.isArray(info.entries) && !info.formats)) {
    const entries = mapEntries(info);
    const isChannel = isYoutubeChannelUrl(requestedUrl) || isYoutubeChannelUrl(base.webpageUrl) || (base.extractor === 'YoutubeTab' && /^UC[\w-]{20,}$/.test(base.id));
    return {
      ...base,
      type: 'playlist',
      // YouTube names channel tabs "Channel - Videos"
      title: isChannel ? base.title.replace(/ - (Videos|Shorts|Live|Streams)$/i, '') : base.title,
      thumbnail: base.thumbnail ?? entries.find((e) => e.thumbnail)?.thumbnail,
      entries,
      isChannel,
      entryCount: num(info.playlist_count) ?? entries.length,
    };
  }
  const duration = num(info.duration);
  const formats: Json[] = Array.isArray(info.formats) ? info.formats : [info];
  const audioQualities = pickAudioFormats(formats, duration);
  const videoQualities = groupVideoFormats(formats, duration, bestAudioSize(audioQualities));
  const text = `${info.title ?? ''} ${(info.tags ?? []).join(' ')}`;
  const formatNotes = formats.map((f) => String(f.format_note ?? '')).join(' ');
  return {
    ...base,
    type: 'video',
    duration,
    isLive: info.is_live === true || info.live_status === 'is_live',
    is360: /360°|\b360\b.*\bvr\b|\bvr\b.*\b360\b|\b360 ?video/i.test(text) || /360°|spherical|vr180/i.test(formatNotes) || info.projection === 'equirectangular',
    is3D: !!info.stereo_mode || /\b3d\b/i.test(formatNotes),
    videoQualities,
    audioQualities,
    subtitles: pickSubtitles(info),
    chapters: pickChapters(info),
  };
}

export function buildSearchResults(info: Json): SearchResult[] {
  return mapEntries(info).map((e) => {
    const raw = (Array.isArray(info.entries) ? info.entries : []).find((x: Json) => x && String(x.id) === e.id) as Json | undefined;
    return {
      id: e.id,
      url: e.url,
      title: e.title,
      uploader: e.uploader,
      duration: e.duration,
      thumbnail: e.thumbnail,
      viewCount: raw ? num(raw.view_count) : undefined,
    };
  });
}
