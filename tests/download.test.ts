import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAnalyzeResult, buildSearchResults, codecFamily, isYoutubeChannelUrl, normalizeChannelUrl } from '../electron/core/download/analyze';
import {
  buildDownloadArgs,
  extractUrls,
  formatSelection,
  friendlyError,
  isWatchWithList,
  looksLikeCollection,
  looksLikeSingleVideo,
  normalizeUrl,
  parseLine,
  stageForPostprocessor,
} from '../electron/core/download/args';
import { defaultQualityLabel } from '../electron/core/download/manager';
import { defaultDownloadOptions, defaultSettings } from '../shared/defaults';
import type { DownloadItem, DownloadOptions } from '../shared/types';

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name), 'utf8'));

const settings = () => defaultSettings('C:\\Users\\me\\Videos');
const opts = (o: Partial<DownloadOptions> = {}): DownloadOptions => ({ ...defaultDownloadOptions(), ...o });
const item = (o: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'd1',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  title: 'Me at the zoo',
  options: opts(),
  status: 'queued',
  progress: 0,
  createdAt: 0,
  ...o,
});
const env = (patch: Partial<ReturnType<typeof settings>> = {}) => ({
  settings: { ...settings(), ...patch },
  ffmpegDir: 'C:\\ff',
  denoPath: 'C:\\bin\\deno.exe',
  archivePath: 'C:\\data\\archive.txt',
  tempDir: 'C:\\data\\partial\\d1',
  limitDivisor: 1,
});
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/* ───────── analysis ───────── */

test('single video: qualities, audio, subtitles, chapters', () => {
  const r = buildAnalyzeResult(fx('download-zoo.json'), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(r.type, 'video');
  assert.equal(r.title, 'Me at the zoo');
  assert.equal(r.duration, 19);
  assert.equal(r.chapters?.length, 3);
  const q = r.videoQualities!;
  assert.deepEqual(
    q.map((x) => x.height),
    [240, 144],
  );
  // video-only H.264 DASH stream preferred over the combined format 18 and over HLS
  assert.equal(q[0].vcodec, 'h264');
  assert.equal(q[0].formatId, '133');
  assert.ok(q[0].filesize! > 433081, 'size includes the audio track');
  const a = r.audioQualities!;
  assert.ok(a.length >= 2);
  assert.ok(a.every((x) => !x.formatId.endsWith('-drc')), 'DRC duplicates are dropped');
  assert.ok(a.some((x) => x.acodec === 'aac') && a.some((x) => x.acodec === 'opus'));
  const subs = r.subtitles!;
  assert.ok(subs.some((s) => s.lang === 'en' && !s.auto));
  assert.ok(subs.some((s) => s.lang === 'en' && s.auto));
});

test('multi-language video: dubbed audio tracks and translated captions', () => {
  const r = buildAnalyzeResult(fx('download-multilang.json'), 'https://www.youtube.com/watch?v=0e3GPea1Tyg');
  const a = r.audioQualities!;
  assert.equal(a[0].isDefault, true);
  assert.equal(a[0].language, 'en-US');
  assert.match(a[0].label, /English \(US\)/);
  const langs = new Set(a.map((x) => x.language));
  for (const l of ['en-US', 'fr', 'de', 'es']) assert.ok(langs.has(l), l);
  const fr = a.find((x) => x.language === 'fr')!;
  assert.equal(fr.isDefault, false);
  assert.equal(fr.languageName, 'French');
  const top = r.videoQualities![0];
  assert.equal(top.height, 1080);
  assert.equal(top.formatId, '137');
  const subs = r.subtitles!;
  const orig = subs.find((s) => s.lang === 'en-orig');
  assert.ok(orig && orig.auto && /auto-generated/.test(orig.name));
  assert.ok(!subs.some((s) => s.lang === 'en' && s.auto), 'auto "en" duplicates en-orig');
  assert.ok(subs.some((s) => s.auto && /auto-translated/.test(s.name)));
  assert.ok(subs.some((s) => s.lang === 'fr' && !s.auto));
});

test('playlist and search results', () => {
  const p = buildAnalyzeResult(fx('download-pl.json'), 'https://www.youtube.com/playlist?list=PLzMcBGfZo4-lwGZWXz5Qgta_YNX3_vLS2');
  assert.equal(p.type, 'playlist');
  assert.equal(p.isChannel, false);
  assert.equal(p.entries!.length, 7);
  assert.equal(p.entries![0].index, 1);
  assert.match(p.entries![0].url, /watch\?v=/);
  assert.ok(p.entries![0].thumbnail);
  const s = buildSearchResults(fx('download-search.json'));
  assert.equal(s.length, 5);
  assert.ok(s[0].viewCount && s[0].viewCount > 0);
});

test('channel URL helpers', () => {
  assert.ok(isYoutubeChannelUrl('https://www.youtube.com/@jawed'));
  assert.ok(isYoutubeChannelUrl('https://youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A/videos'));
  assert.ok(!isYoutubeChannelUrl('https://www.youtube.com/watch?v=x'));
  assert.equal(normalizeChannelUrl('https://www.youtube.com/@jawed'), 'https://www.youtube.com/@jawed/videos');
  assert.equal(normalizeChannelUrl('https://www.youtube.com/@jawed/featured'), 'https://www.youtube.com/@jawed/videos');
  assert.equal(normalizeChannelUrl('https://www.youtube.com/@jawed/shorts'), 'https://www.youtube.com/@jawed/shorts');
  assert.equal(codecFamily('avc1.640028'), 'h264');
  assert.equal(codecFamily('vp09.00.10.08'), 'vp9');
  assert.equal(codecFamily('av01.0.08M.08'), 'av1');
  assert.equal(codecFamily('mp4a.40.2'), 'aac');
});

/* ───────── format selection & args ───────── */

test('format selection for video, exact ids, webm and audio', () => {
  const v = formatSelection(opts({ quality: '1080' }));
  assert.ok(v.format.startsWith('bv[height<=1080]+ba/'));
  assert.ok(v.format.endsWith('/b'));
  assert.equal(v.sort, 'res:1080,fps,+vcodec:avc,+acodec:m4a');

  const ids = formatSelection(opts({ videoFormatId: '137', audioFormatId: '251', audioLanguage: 'fr' }));
  assert.ok(ids.format.startsWith('137+251/137+ba[language^=fr]/137+ba/137/'));

  const mkvAv1 = formatSelection(opts({ container: 'mkv', quality: 'best', codecPreference: 'av1' }));
  assert.equal(mkvAv1.sort, 'res,fps,vcodec:av01');

  const webm = formatSelection(opts({ container: 'webm', quality: '720' }));
  assert.ok(webm.format.startsWith('bv[ext=webm][height<=720]+ba[ext=webm]/'));

  const audio = formatSelection(opts({ kind: 'audio', container: 'm4a', quality: '256', audioLanguage: 'de' }));
  assert.equal(audio.format, 'ba[language^=de]/ba/b');
  assert.equal(audio.sort, '+acodec:m4a');
});

test('download args reflect settings and options', () => {
  const { args, outputDir } = buildDownloadArgs(
    item({
      playlistTitle: 'My: Playlist?',
      playlistIndex: 3,
      options: opts({ subtitles: { enabled: true, langs: ['en', 'fr'], includeAuto: true, embed: true, format: 'ass' }, section: { start: 10, end: 20.5 }, splitChapters: true }),
    }),
    env({
      proxyEnabled: true,
      proxyUrl: 'socks5://127.0.0.1:9050',
      cookiesMode: 'browser',
      cookiesBrowser: 'firefox',
      speedLimitKBps: 2000,
      skipDuplicates: true,
      numberPlaylistItems: true,
      sponsorBlockRemove: true,
    }),
  );
  assert.equal(outputDir, path.join('C:\\Users\\me\\Videos\\Kinomill', 'My Playlist'));
  assert.equal(after(args, '--proxy'), 'socks5://127.0.0.1:9050');
  assert.equal(after(args, '--cookies-from-browser'), 'firefox');
  assert.equal(after(args, '--limit-rate'), '2000K');
  assert.equal(after(args, '--download-archive'), 'C:\\data\\archive.txt');
  assert.equal(after(args, '--js-runtimes'), 'deno:C:\\bin\\deno.exe');
  assert.equal(after(args, '--ffmpeg-location'), 'C:\\ff');
  assert.equal(after(args, '-o'), '03 - %(title)s.%(ext)s');
  assert.ok(args.includes('temp:C:\\data\\partial\\d1'));
  assert.equal(after(args, '--merge-output-format'), 'mp4');
  assert.equal(after(args, '--remux-video'), 'mp4');
  // mp4 can only hold SRT-style (mov_text) subtitles
  assert.ok(args.includes('--embed-subs') && !args.includes('--write-subs'));
  assert.equal(after(args, '--convert-subs'), 'srt');
  assert.equal(after(args, '--sub-langs'), 'en,fr');
  assert.ok(args.includes('--write-auto-subs'));
  assert.equal(after(args, '--download-sections'), '*10-20.5');
  assert.ok(args.includes('--split-chapters'));
  assert.equal(after(args, '--sponsorblock-remove'), 'sponsor');
  assert.ok(args.includes('--no-playlist'));
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
});

test('audio download args', () => {
  const { args } = buildDownloadArgs(item({ options: opts({ kind: 'audio', container: 'mp3', quality: '192' }) }), env({ cookiesMode: 'app' }));
  assert.equal(after(args, '--audio-format'), 'mp3');
  assert.equal(after(args, '--audio-quality'), '192K');
  assert.ok(args.includes('--embed-thumbnail'));
  assert.ok(!args.includes('--cookies'), 'no cookie file was resolved');
  const wav = buildDownloadArgs(item({ options: opts({ kind: 'audio', container: 'wav', quality: 'best' }) }), env()).args;
  assert.ok(!wav.includes('--audio-quality') && !wav.includes('--embed-thumbnail'));
  const ogg = buildDownloadArgs(item({ options: opts({ kind: 'audio', container: 'ogg', quality: 'best' }) }), { ...env(), cookiesFile: 'C:\\c.txt', settings: { ...settings(), cookiesMode: 'file' } }).args;
  assert.equal(after(ogg, '--audio-format'), 'vorbis');
  assert.equal(after(ogg, '--audio-quality'), '0');
  assert.equal(after(ogg, '--cookies'), 'C:\\c.txt');
  // separate subtitle files for audio downloads
  const subs = buildDownloadArgs(item({ options: opts({ kind: 'audio', container: 'mp3', subtitles: { enabled: true, langs: ['*'], includeAuto: false, embed: true, format: 'vtt' } }) }), env()).args;
  assert.ok(subs.includes('--write-subs') && !subs.includes('--embed-subs'));
  assert.equal(after(subs, '--sub-langs'), 'all,-live_chat');
});

test('speed limit is shared between simultaneous downloads', () => {
  const { args } = buildDownloadArgs(item(), { ...env({ speedLimitKBps: 3000 }), limitDivisor: 3 });
  assert.equal(after(args, '--limit-rate'), '1000K');
});

/* ───────── output parsing ───────── */

test('parses progress, post-processing, metadata and done lines', () => {
  const p = parseLine(
    'VFPROG {"status": "downloading", "downloaded_bytes": 1024, "total_bytes": 4096, "speed": 512.5, "eta": 6, "filename": "C:\\\\x\\\\a.f137.mp4"} VFSEP {"format_id": "137", "vcodec": "avc1.640028", "acodec": "none"}',
  );
  assert.equal(p.kind, 'progress');
  if (p.kind === 'progress') {
    assert.equal(p.downloaded, 1024);
    assert.equal(p.total, 4096);
    assert.equal(p.formatId, '137');
    assert.equal(p.acodec, 'none');
    assert.equal(p.filename, 'C:\\x\\a.f137.mp4');
  }
  const sub = parseLine('VFPROG {"status": "finished", "downloaded_bytes": 440} VFSEP {}');
  assert.ok(sub.kind === 'progress' && sub.formatId === undefined);
  const est = parseLine('VFPROG {"status": "downloading", "downloaded_bytes": 10, "total_bytes_estimate": 100.5} VFSEP {"format_id": "hls-1"}');
  assert.ok(est.kind === 'progress' && est.total === 100.5);
  const pp = parseLine('VFPP {"status": "started", "postprocessor": "Merger"}');
  assert.deepEqual(pp, { kind: 'pp', status: 'started', postprocessor: 'Merger' });
  const meta = parseLine('VFMETA {"id": "x", "title": "Ünïcødé 名前", "format_id": "137+140"}');
  assert.ok(meta.kind === 'meta' && meta.data.title === 'Ünïcødé 名前');
  const req = parseLine('VFREQ [{"format_id": "137", "filesize": 10}, {"format_id": "140", "filesize_approx": 5}]');
  assert.ok(req.kind === 'req' && req.formats.length === 2);
  const done = parseLine('VFDONE "C:\\\\Videos\\\\Me at the zoo.mp4"');
  assert.deepEqual(done, { kind: 'done', path: 'C:\\Videos\\Me at the zoo.mp4' });
  assert.equal(parseLine('ERROR: [youtube] x: Video unavailable').kind, 'error');
  assert.equal(parseLine('[youtube] Extracting URL').kind, 'other');
  assert.equal(stageForPostprocessor('Merger'), 'Merging video and audio');
  assert.equal(stageForPostprocessor('FFmpegExtractAudio'), 'Converting audio');
  assert.equal(stageForPostprocessor('SomethingNew'), 'Processing');
});

test('friendly error messages', () => {
  assert.match(friendlyError("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"), /not a bot.*Sign in/);
  assert.match(friendlyError('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access'), /private/i);
  assert.match(friendlyError('ERROR: [youtube] abc: Sign in to confirm your age.'), /age-restricted/);
  assert.match(friendlyError('ERROR: [youtube] abc: The uploader has not made this video available in your country'), /country/);
  assert.match(friendlyError('ERROR: Unsupported URL: https://example.com/'), /not supported/);
  assert.match(friendlyError('ERROR: unable to download video data: HTTP Error 403: Forbidden'), /403/);
  assert.match(friendlyError('ERROR: [Errno 11001] getaddrinfo failed'), /internet connection/);
  assert.match(
    friendlyError("ERROR: [vimeo] 1: Unable to download webpage: Failed to perform, curl: (60) SSL: no alternative certificate subject name matches target hostname 'vimeo.com'."),
    /could not be verified/,
  );
  assert.match(friendlyError('ERROR: [youtube] abc: Join this channel to get access to members-only content'), /members/);
  assert.equal(friendlyError('ERROR: [generic] something odd happened'), 'something odd happened');
});

test('URL helpers', () => {
  assert.equal(normalizeUrl(' youtube.com/watch?v=abc '), 'https://youtube.com/watch?v=abc');
  assert.ok(looksLikeSingleVideo('https://www.youtube.com/watch?v=jNQXAC9IVRw'));
  assert.ok(looksLikeSingleVideo('https://youtu.be/jNQXAC9IVRw'));
  assert.ok(looksLikeSingleVideo('https://www.youtube.com/shorts/abcdefghijk'));
  assert.ok(looksLikeSingleVideo('https://vimeo.com/76979871'));
  assert.ok(!looksLikeSingleVideo('https://www.youtube.com/playlist?list=PLx'));
  assert.ok(!looksLikeSingleVideo('https://soundcloud.com/artist/sets/album'));
  assert.ok(looksLikeCollection('https://www.youtube.com/playlist?list=PLx'));
  assert.ok(looksLikeCollection('https://www.youtube.com/@jawed'));
  assert.ok(!looksLikeCollection('https://www.youtube.com/watch?v=x&list=PLx'));
  assert.ok(isWatchWithList('https://www.youtube.com/watch?v=x&list=PLx'));
  assert.deepEqual(extractUrls('url,title\n"https://a.com/x?y=1","A"\nhttps://b.com/v).\nhttps://a.com/x?y=1'), ['https://a.com/x?y=1', 'https://b.com/v']);
  assert.equal(defaultQualityLabel(opts({ quality: '1080' })), '1080p MP4');
  assert.equal(defaultQualityLabel(opts({ kind: 'audio', container: 'mp3', quality: '320' })), 'MP3 320 kbps');
});
