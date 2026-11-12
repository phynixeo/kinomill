// Channel / playlist subscriptions: periodically look for new videos and
// (optionally) download them automatically with the subscription's settings.
import path from 'node:path';
import type { DownloadOptions, PlaylistEntry, Subscription } from '../../../shared/types';
import { JsonStore, type Ctx } from '../context';
import { errMessage, uid } from '../util';
import { isYoutubeChannelUrl } from './analyze';
import { normalizeUrl } from './args';
import type { DownloadManager } from './manager';
import type { YtDlp } from './ytdlp';

type StoredSub = Subscription & { initPending?: boolean };

const MAX_KNOWN = 5000;
const CHANNEL_CHECK_DEPTH = 30;

function publicSub(s: StoredSub): Subscription {
  const { initPending: _p, ...rest } = s;
  return rest;
}

export class Subscriptions {
  private store: JsonStore<StoredSub[]>;
  private timer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;
  private armedMinutes = -1;
  private checking = new Set<string>();
  private offBus: () => void;

  constructor(
    private ctx: Ctx,
    private ytdlp: YtDlp,
    private downloads: DownloadManager,
  ) {
    this.store = new JsonStore<StoredSub[]>(path.join(ctx.paths.data, 'subscriptions.json'), []);
    if (!Array.isArray(this.store.get())) this.store.set([]);
    this.offBus = ctx.bus.on((ev) => {
      if (ev.type === 'settings') this.rearm();
    });
    this.rearm();
    // first check shortly after start-up (engines are usually ready by then)
    this.firstTimer = setTimeout(() => void this.check(), 90_000);
  }

  private get subs(): StoredSub[] {
    return this.store.get();
  }

  list(): Subscription[] {
    return this.subs.map(publicSub);
  }

  all(): StoredSub[] {
    return this.subs;
  }

  private emit(s: StoredSub): void {
    this.store.touch();
    this.ctx.bus.emit({ type: 'subscription', item: publicSub(s) });
  }

  private rearm(): void {
    const minutes = Math.max(0, Math.floor(this.ctx.settings().subscriptionCheckMinutes || 0));
    if (minutes === this.armedMinutes) return;
    this.armedMinutes = minutes;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (minutes > 0) this.timer = setInterval(() => void this.check(), Math.max(5, minutes) * 60_000);
  }

  private findByUrl(url: string): StoredSub | undefined {
    const norm = (u: string) => u.toLowerCase().replace(/\/+$/, '').replace(/\/videos$/, '').replace(/^https?:\/\/(www\.|m\.)?/, '');
    return this.subs.find((s) => norm(s.url) === norm(url));
  }

  async add(args: { url: string; options: DownloadOptions; autoDownload: boolean; downloadExisting: boolean }): Promise<Subscription> {
    const url = normalizeUrl(args.url);
    if (this.findByUrl(url)) throw new Error('You are already subscribed to this channel or playlist.');
    const res = await this.ytdlp.listEntries(url, args.downloadExisting ? undefined : isYoutubeChannelUrl(url) ? 60 : undefined);
    if (res.type !== 'playlist') throw new Error('This link is a single video. Paste a channel or playlist link to subscribe.');
    const entries = (res.entries ?? []).filter((e) => !e.live);
    const sub: StoredSub = {
      id: uid('s'),
      url: res.webpageUrl || url,
      title: res.title,
      thumbnail: res.thumbnail,
      uploader: res.uploader,
      options: JSON.parse(JSON.stringify(args.options)) as DownloadOptions,
      autoDownload: args.autoDownload,
      enabled: true,
      createdAt: Date.now(),
      lastChecked: Date.now(),
      knownIds: entries.map((e) => e.id).slice(0, MAX_KNOWN),
      newCount: 0,
    };
    this.subs.push(sub);
    this.emit(sub);
    if (args.downloadExisting && entries.length) this.enqueue(sub, [...entries].reverse());
    return publicSub(sub);
  }

  /** Add a subscription from an import file without contacting the site. */
  addImported(s: Partial<Subscription> & { url: string; options: DownloadOptions }): boolean {
    if (this.findByUrl(s.url)) return false;
    const known = Array.isArray(s.knownIds) ? s.knownIds.filter((x) => typeof x === 'string') : [];
    const sub: StoredSub = {
      id: uid('s'),
      url: s.url,
      title: s.title || s.url,
      thumbnail: s.thumbnail,
      uploader: s.uploader,
      options: s.options,
      autoDownload: s.autoDownload ?? true,
      enabled: s.enabled ?? true,
      createdAt: Date.now(),
      knownIds: known.slice(0, MAX_KNOWN),
      newCount: 0,
      // without a known-video list the first check only records what exists
      initPending: known.length === 0,
    };
    this.subs.push(sub);
    this.emit(sub);
    return true;
  }

  update(id: string, patch: Partial<Pick<Subscription, 'options' | 'autoDownload' | 'enabled' | 'newCount'>>): Subscription {
    const s = this.subs.find((x) => x.id === id);
    if (!s) throw new Error('Subscription not found');
    if (patch.options) s.options = JSON.parse(JSON.stringify(patch.options)) as DownloadOptions;
    if (typeof patch.autoDownload === 'boolean') s.autoDownload = patch.autoDownload;
    if (typeof patch.enabled === 'boolean') s.enabled = patch.enabled;
    if (typeof patch.newCount === 'number') s.newCount = Math.max(0, patch.newCount);
    this.emit(s);
    return publicSub(s);
  }

  remove(id: string): void {
    const before = this.subs.length;
    this.store.set(this.subs.filter((s) => s.id !== id));
    if (this.subs.length !== before) this.ctx.bus.emit({ type: 'subscription-removed', id });
  }

  /** Check one subscription (by id) or all enabled ones. */
  async check(id?: string): Promise<void> {
    if (!this.ctx.engines.path('ytdlp')) return;
    const targets = id ? this.subs.filter((s) => s.id === id) : this.subs.filter((s) => s.enabled);
    for (const s of targets) await this.checkOne(s);
  }

  private async checkOne(s: StoredSub): Promise<void> {
    if (this.checking.has(s.id)) return;
    this.checking.add(s.id);
    try {
      const res = await this.ytdlp.listEntries(s.url, isYoutubeChannelUrl(s.url) ? CHANNEL_CHECK_DEPTH : undefined);
      if (!this.subs.includes(s)) return; // removed meanwhile
      const known = new Set(s.knownIds);
      const entries = (res.entries ?? []).filter((e) => !e.live);
      const fresh = entries.filter((e) => !known.has(e.id));
      s.lastChecked = Date.now();
      s.error = undefined;
      if (!s.thumbnail && res.thumbnail) s.thumbnail = res.thumbnail;
      if ((!s.title || s.title === s.url) && res.title) s.title = res.title;
      if (s.initPending) {
        s.initPending = undefined;
        s.knownIds = [...entries.map((e) => e.id), ...s.knownIds].slice(0, MAX_KNOWN);
      } else if (fresh.length) {
        s.knownIds = [...fresh.map((e) => e.id), ...s.knownIds].slice(0, MAX_KNOWN);
        s.newCount += fresh.length;
        if (s.autoDownload) this.enqueue(s, [...fresh].reverse());
        this.ctx.notifyDone(
          `New from ${s.title}`,
          `${fresh.length} new video${fresh.length > 1 ? 's' : ''}${s.autoDownload ? ' — downloading now' : ''}`,
        );
      }
    } catch (e) {
      s.lastChecked = Date.now();
      s.error = errMessage(e);
    } finally {
      this.checking.delete(s.id);
      if (this.subs.includes(s)) this.emit(s);
    }
  }

  private enqueue(s: StoredSub, entries: PlaylistEntry[]): void {
    this.downloads.add(
      entries.map((e) => ({ url: e.url, title: e.title, thumbnail: e.thumbnail, duration: e.duration, uploader: e.uploader ?? s.uploader, playlistTitle: s.title })),
      s.options,
      { subscriptionId: s.id },
    );
  }

  dispose(): void {
    this.offBus();
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.store.flush();
  }
}
