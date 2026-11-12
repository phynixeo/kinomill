// Downloader module: analysis, search, the download queue, Smart Mode,
// subscriptions and import/export.
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItem, DownloadOptions, Subscription } from '../../../shared/types';
import { defaultDownloadOptions } from '../../../shared/defaults';
import type { CoreModule, Ctx } from '../context';
import { errMessage } from '../util';
import { extractUrls, looksLikeCollection, looksLikeSingleVideo, normalizeUrl } from './args';
import { DownloadManager, type NewEntry } from './manager';
import { Subscriptions } from './subscriptions';
import { YtDlp } from './ytdlp';

interface ExportFile {
  app: 'Kinomill';
  version: 1;
  exportedAt: string;
  downloads: (NewEntry & { options: DownloadOptions; status?: string; filePath?: string })[];
  subscriptions: (Pick<Subscription, 'url' | 'title' | 'thumbnail' | 'uploader' | 'options' | 'autoDownload' | 'enabled'> & { knownIds?: string[] })[];
}

export function createDownloadModule(ctx: Ctx): CoreModule {
  const ytdlp = new YtDlp(ctx);
  const downloads = new DownloadManager(ctx, ytdlp);
  const subs = new Subscriptions(ctx, ytdlp, downloads);

  /** Smart Mode: download links right away with the saved Smart Mode settings. */
  async function smart(urls: string[], options?: DownloadOptions): Promise<DownloadItem[]> {
    const opts = options ?? ctx.settings().smartOptions;
    const out: DownloadItem[] = [];
    const errors: string[] = [];
    for (const raw of urls) {
      const url = normalizeUrl(raw);
      if (!url) continue;
      if (looksLikeSingleVideo(url)) {
        out.push(...downloads.add([{ url }], opts));
        continue;
      }
      try {
        const r = await ytdlp.analyze(url, looksLikeCollection(url));
        if (r.type === 'playlist') {
          const entries = (r.entries ?? []).filter((e) => !e.live);
          if (!entries.length) throw new Error(`"${r.title}" has no downloadable videos.`);
          out.push(
            ...downloads.add(
              entries.map((e) => ({ url: e.url, title: e.title, thumbnail: e.thumbnail, duration: e.duration, uploader: e.uploader, playlistTitle: r.title, playlistIndex: e.index })),
              opts,
            ),
          );
        } else {
          out.push(...downloads.add([{ url: r.webpageUrl || url, title: r.title, thumbnail: r.thumbnail, duration: r.duration, uploader: r.uploader }], opts));
        }
      } catch (e) {
        errors.push(errMessage(e));
      }
    }
    if (errors.length && !out.length) throw new Error(errors[0]);
    if (errors.length) ctx.toast('warning', `${errors.length} link${errors.length > 1 ? 's' : ''} could not be added: ${errors[0]}`);
    return out;
  }

  function exportTo(file: string): number {
    const visible = downloads.all().filter((d) => !ctx.privacy.isHidden(d));
    const ext = path.extname(file).toLowerCase();
    if (ext === '.txt') {
      fs.writeFileSync(file, visible.map((d) => d.url).join('\r\n') + '\r\n', 'utf8');
      return visible.length;
    }
    if (ext === '.csv') {
      const q = (s: string | undefined) => `"${(s ?? '').replace(/"/g, '""')}"`;
      const lines = ['url,title,status,file', ...visible.map((d) => [q(d.url), q(d.title), q(d.status), q(d.filePath)].join(','))];
      fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
      return visible.length;
    }
    const data: ExportFile = {
      app: 'Kinomill',
      version: 1,
      exportedAt: new Date().toISOString(),
      downloads: visible.map((d) => ({
        url: d.url,
        title: d.title,
        thumbnail: d.thumbnail,
        duration: d.duration,
        uploader: d.uploader,
        playlistTitle: d.playlistTitle,
        playlistIndex: d.playlistIndex,
        qualityLabel: d.qualityLabel,
        options: d.options,
        status: d.status,
        filePath: d.filePath,
      })),
      subscriptions: subs.all().map((s) => ({
        url: s.url,
        title: s.title,
        thumbnail: s.thumbnail,
        uploader: s.uploader,
        options: s.options,
        autoDownload: s.autoDownload,
        enabled: s.enabled,
        knownIds: s.knownIds,
      })),
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
    return data.downloads.length + data.subscriptions.length;
  }

  async function importFrom(file: string): Promise<number> {
    const st = fs.statSync(file);
    if (st.size > 50 * 1024 * 1024) throw new Error('The file is too large to import.');
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && (Array.isArray((parsed as ExportFile).downloads) || Array.isArray((parsed as ExportFile).subscriptions))) {
      const data = parsed as Partial<ExportFile>;
      const existing = new Set(downloads.all().map((d) => d.url));
      let count = 0;
      for (const d of data.downloads ?? []) {
        if (!d || typeof d.url !== 'string' || existing.has(d.url)) continue;
        existing.add(d.url);
        const options = { ...defaultDownloadOptions(), ...ctx.settings().smartOptions, ...(d.options ?? {}) } as DownloadOptions;
        count += downloads.add([{ url: d.url, title: d.title, thumbnail: d.thumbnail, duration: d.duration, uploader: d.uploader, playlistTitle: d.playlistTitle, playlistIndex: d.playlistIndex, qualityLabel: d.qualityLabel }], options).length;
      }
      for (const s of data.subscriptions ?? []) {
        if (!s || typeof s.url !== 'string') continue;
        const options = { ...defaultDownloadOptions(), ...ctx.settings().smartOptions, ...(s.options ?? {}) } as DownloadOptions;
        if (subs.addImported({ ...s, options })) count++;
      }
      return count;
    }
    const urls = extractUrls(text);
    if (!urls.length) throw new Error('No links were found in this file.');
    const added = await smart(urls);
    return added.length;
  }

  return {
    handlers: {
      'media.analyze': ({ url, flat, channelTab }) => ytdlp.analyze(url, flat, channelTab),
      'media.search': ({ query, limit }) => ytdlp.search(query, limit ?? 20),
      'downloads.add': ({ items, options }) => downloads.add(items, options),
      'downloads.smart': ({ urls }) => smart(urls),
      'downloads.pause': ({ ids }) => downloads.pause(ids),
      'downloads.resume': ({ ids }) => downloads.resume(ids),
      'downloads.retry': ({ ids }) => downloads.retry(ids),
      'downloads.remove': ({ ids, deleteFiles }) => downloads.remove(ids, deleteFiles),
      'downloads.pauseAll': () => downloads.pauseAll(),
      'downloads.resumeAll': () => downloads.resumeAll(),
      'downloads.clearCompleted': () => downloads.clearCompleted(),
      'downloads.export': ({ path: p }) => exportTo(p),
      'downloads.import': ({ path: p }) => importFrom(p),
      'subs.add': (a) => subs.add(a),
      'subs.update': ({ id, patch }) => subs.update(id, patch),
      'subs.remove': ({ id }) => subs.remove(id),
      'subs.check': async ({ id }) => {
        await subs.check(id);
      },
    },
    state: () => ({ downloads: downloads.list(), subscriptions: subs.list() }),
    isBusy: () => downloads.isBusy(),
    async dispose() {
      subs.dispose();
      await downloads.dispose();
    },
  };
}
