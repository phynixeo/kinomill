export function formatBytes(n?: number, digits = 1): string {
  if (!n || n <= 0 || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? digits : 0)} ${units[i]}`;
}

export function formatSpeed(bps?: number): string {
  if (!bps) return '';
  return formatBytes(bps) + '/s';
}

/** 75 → "1:15", 3725 → "1:02:05" */
export function formatDuration(sec?: number): string {
  if (sec === undefined || sec === null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Precise timecode for the editor: 01:02:03.45 */
export function formatTimecode(sec: number, withHours = true): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s - h * 3600 - m * 60;
  const rs = r.toFixed(2).padStart(5, '0');
  return withHours || h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rs}` : `${String(m).padStart(2, '0')}:${rs}`;
}

/** Parse "1:02:03.5", "62.5", "1:30" → seconds. */
export function parseTimecode(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => Number(p.replace(',', '.')));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatEta(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min left`;
  return `${Math.floor(sec / 3600)} h ${Math.ceil((sec % 3600) / 60)} min left`;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function timeAgo(ts?: number): string {
  if (!ts) return 'never';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const SITE_NAMES: Record<string, string> = {
  youtube: 'YouTube', youtubetab: 'YouTube', soundcloud: 'SoundCloud', tiktok: 'TikTok', vimeo: 'Vimeo', twitter: 'X (Twitter)',
  facebook: 'Facebook', instagram: 'Instagram', dailymotion: 'Dailymotion', bilibili: 'Bilibili', twitch: 'Twitch', reddit: 'Reddit',
  vk: 'VK', bandcamp: 'Bandcamp', mixcloud: 'Mixcloud', rumble: 'Rumble', tumblr: 'Tumblr', flickr: 'Flickr', pinterest: 'Pinterest',
  likee: 'Likee', naver: 'Naver', threads: 'Threads', odnoklassniki: 'OK.ru', niconico: 'Niconico', streamable: 'Streamable',
};

export function siteName(extractor?: string, url?: string): string {
  if (extractor) {
    const e = extractor.split(':')[0];
    if (e && e !== 'generic') return SITE_NAMES[e.toLowerCase()] ?? e.charAt(0).toUpperCase() + e.slice(1);
  }
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isUrl(s: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>]+?(?=https?:\/\/|[\s"'<>]|$)/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[),.;]+$/, '')))];
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', 'zh-Hans': 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)', ar: 'Arabic', hi: 'Hindi',
  bn: 'Bengali', tr: 'Turkish', pl: 'Polish', nl: 'Dutch', sv: 'Swedish', uk: 'Ukrainian', vi: 'Vietnamese', th: 'Thai',
  id: 'Indonesian', cs: 'Czech', el: 'Greek', he: 'Hebrew', hu: 'Hungarian', ro: 'Romanian', fi: 'Finnish', da: 'Danish',
  no: 'Norwegian', ta: 'Tamil', te: 'Telugu', ur: 'Urdu', fa: 'Persian', ms: 'Malay',
};

export function languageName(code?: string): string {
  if (!code) return 'Default';
  return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0]] ?? code;
}
