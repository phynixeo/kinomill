import type { DownloadOptions, EditSpec, OutputSpec, Settings } from './types';
import { getPreset, getTarget } from './presets';

export function defaultDownloadOptions(): DownloadOptions {
  return {
    kind: 'video',
    container: 'mp4',
    quality: '1080',
    codecPreference: 'any',
    subtitles: { enabled: false, langs: ['en'], includeAuto: false, embed: true, format: 'srt' },
    outputDir: '',
  };
}

export function defaultEdit(): EditSpec {
  return {
    cuts: [],
    rotate: 0,
    flipH: false,
    flipV: false,
    crop: null,
    autoRemoveBlackBars: false,
    audioTrack: 0,
    volume: 1,
    normalizeAudio: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    subtitles: null,
    deinterlace: false,
    brightness: 0,
    contrast: 0,
    saturation: 0,
  };
}

export function isEditDefault(e: EditSpec): boolean {
  const d = defaultEdit();
  return (
    e.cuts.length === 0 &&
    e.rotate === 0 &&
    !e.flipH &&
    !e.flipV &&
    !e.crop &&
    !e.autoRemoveBlackBars &&
    e.audioTrack === d.audioTrack &&
    e.volume === 1 &&
    !e.normalizeAudio &&
    e.speed === 1 &&
    !e.fadeIn &&
    !e.fadeOut &&
    !e.subtitles &&
    !e.deinterlace &&
    !e.brightness &&
    !e.contrast &&
    !e.saturation
  );
}

/** Build an OutputSpec from a target + preset (as the UI's format buttons do). */
export function outputFromPreset(targetId: string, presetId?: string): OutputSpec {
  const target = getTarget(targetId);
  if (!target) throw new Error('Unknown output target ' + targetId);
  const preset = getPreset(targetId, presetId ?? target.defaultPreset) ?? target.presets[0];
  return {
    targetId,
    presetId: preset.id,
    container: target.container,
    video: preset.video ? { ...preset.video } : null,
    audio: preset.audio ? { ...preset.audio } : null,
    hwAccel: true,
    watermark: null,
    allowStreamCopy: true,
  };
}

export function defaultSettings(videosDir: string, sep = '\\'): Settings {
  const root = videosDir.replace(/[\\/]+$/, '') + sep + 'Kinomill';
  return {
    theme: 'system',
    downloadDir: root,
    convertDir: root + sep + 'Converted',
    maxConcurrentDownloads: 3,
    maxConcurrentConversions: 1,
    speedLimitKBps: 0,
    proxyEnabled: false,
    proxyUrl: '',
    filenameTemplate: '%(title)s',
    playlistSubfolder: true,
    numberPlaylistItems: false,
    skipDuplicates: false,
    embedThumbnail: true,
    embedMetadata: true,
    embedChapters: true,
    sponsorBlockRemove: false,
    cookiesMode: 'none',
    cookiesBrowser: 'firefox',
    cookiesFile: '',
    notifyOnComplete: true,
    playSoundOnComplete: true,
    monitorClipboard: false,
    smartMode: false,
    smartOptions: defaultDownloadOptions(),
    subscriptionCheckMinutes: 60,
    hwAccel: 'auto',
    preventSleep: true,
    afterQueue: 'nothing',
    retries: 3,
    privateMode: false,
  };
}
