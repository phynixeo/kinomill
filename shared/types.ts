// Shared types used by both the Electron backend (electron/) and the UI (src/).
// Keep this file free of Node or browser specific imports.

/* ───────────────────────── Engines ───────────────────────── */

export type EngineName = 'ytdlp' | 'ffmpeg' | 'deno' | 'tsmuxer';

export interface EngineStatus {
  name: EngineName;
  label: string;
  description: string;
  required: boolean;
  installed: boolean;
  version?: string;
  path?: string;
  source?: 'managed' | 'system';
  busy?: boolean;
  progress?: number; // 0..1 while installing
  error?: string;
  updateAvailable?: string;
}

/* ───────────────────────── Settings ───────────────────────── */

export type Theme = 'system' | 'light' | 'dark';
export type CookieBrowser = 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi' | 'chromium';
export type HwAccel = 'auto' | 'none' | 'nvenc' | 'qsv' | 'amf';
export type AfterQueue = 'nothing' | 'sleep' | 'shutdown';

export interface Settings {
  theme: Theme;
  downloadDir: string;
  convertDir: string;
  maxConcurrentDownloads: number;
  maxConcurrentConversions: number;
  speedLimitKBps: number; // 0 = unlimited
  proxyEnabled: boolean;
  proxyUrl: string; // http://user:pass@host:port or socks5://host:port
  filenameTemplate: string; // yt-dlp template without extension, e.g. "%(title)s"
  playlistSubfolder: boolean;
  numberPlaylistItems: boolean;
  skipDuplicates: boolean;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  sponsorBlockRemove: boolean;
  cookiesMode: 'none' | 'app' | 'browser' | 'file';
  cookiesBrowser: CookieBrowser;
  cookiesFile: string;
  notifyOnComplete: boolean;
  playSoundOnComplete: boolean;
  monitorClipboard: boolean;
  smartMode: boolean;
  smartOptions: DownloadOptions;
  subscriptionCheckMinutes: number; // 0 = never automatically
  hwAccel: HwAccel;
  preventSleep: boolean;
  afterQueue: AfterQueue;
  retries: number;
  privateMode: boolean; // new downloads are private (hidden when locked)
}

/* ───────────────────────── Downloader ───────────────────────── */

export type VideoContainer = 'mp4' | 'mkv' | 'webm' | 'mov';
export type AudioContainer = 'mp3' | 'm4a' | 'opus' | 'ogg' | 'wav' | 'flac';
export type DownloadContainer = VideoContainer | AudioContainer;

export interface SubtitleOptions {
  enabled: boolean;
  langs: string[]; // e.g. ['en', 'fr']; '*' = all
  includeAuto: boolean; // auto-generated / auto-translated
  embed: boolean; // embed into the video file (else write separate file)
  format: 'srt' | 'vtt' | 'ass';
}

export interface DownloadOptions {
  kind: 'video' | 'audio';
  container: DownloadContainer;
  /** Generic quality: 'best' | '4320' | '2160' | '1440' | '1080' | '720' | '480' | '360' | '240' | '144'.
   *  For audio: 'best' | '320' | '256' | '192' | '128' | '96' (kbps). */
  quality: string;
  /** Exact yt-dlp format ids picked from an analysis (take priority over `quality`). */
  videoFormatId?: string;
  audioFormatId?: string;
  codecPreference: 'any' | 'h264' | 'vp9' | 'av1' | 'hevc';
  audioLanguage?: string; // e.g. 'en'; undefined = default/original
  subtitles: SubtitleOptions;
  outputDir: string; // '' = settings.downloadDir
  splitChapters?: boolean;
  section?: { start: number; end: number } | null; // only download this time range (seconds)
}

export interface QualityOption {
  key: string; // unique within the analysis
  label: string; // "1080p60 HDR"
  height: number;
  width?: number;
  fps?: number;
  hdr?: boolean;
  vcodec: string; // short: h264, vp9, av1, hevc
  ext: string;
  formatId: string;
  filesize?: number; // estimated bytes incl. best audio
  tbr?: number;
}

export interface AudioOption {
  key: string;
  label: string; // "128 kbps opus (English)"
  formatId: string;
  abr?: number;
  acodec: string;
  ext: string;
  language?: string;
  languageName?: string;
  isDefault?: boolean;
  filesize?: number;
}

export interface SubtitleTrack {
  lang: string;
  name: string;
  auto: boolean;
}

export interface Chapter {
  title: string;
  start: number;
  end: number;
}

export interface PlaylistEntry {
  id: string;
  url: string;
  title: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  index: number;
  /** Channel downloads: which tab the entry came from. */
  section?: 'video' | 'short' | 'live';
  /** A stream that is live right now (would never finish) or not started yet. */
  live?: 'now' | 'upcoming';
}

/** Which part of a YouTube channel to list. */
export type ChannelTab = 'videos' | 'shorts' | 'streams' | 'all';

export interface AnalyzeResult {
  type: 'video' | 'playlist';
  url: string;
  id: string;
  title: string;
  uploader?: string;
  thumbnail?: string;
  duration?: number;
  extractor: string;
  webpageUrl: string;
  isLive?: boolean;
  is360?: boolean;
  is3D?: boolean;
  // single video
  videoQualities?: QualityOption[];
  audioQualities?: AudioOption[];
  subtitles?: SubtitleTrack[];
  chapters?: Chapter[];
  // playlist / channel
  entries?: PlaylistEntry[];
  isChannel?: boolean;
  channelTab?: ChannelTab;
  entryCount?: number;
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DownloadItem {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  extractor?: string;
  options: DownloadOptions;
  qualityLabel?: string;
  status: DownloadStatus;
  stage?: string; // human readable: "Downloading video", "Merging", "Embedding subtitles"
  progress: number; // 0..1
  speed?: number; // bytes/sec
  eta?: number; // seconds
  downloadedBytes?: number;
  totalBytes?: number;
  filePath?: string;
  fileSize?: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
  playlistTitle?: string;
  playlistIndex?: number;
  subscriptionId?: string;
  private?: boolean;
}

export interface Subscription {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  uploader?: string;
  options: DownloadOptions;
  autoDownload: boolean;
  enabled: boolean;
  createdAt: number;
  lastChecked?: number;
  knownIds: string[];
  newCount: number;
  error?: string;
}

export interface SearchResult {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  viewCount?: number;
}

/* ───────────────────────── Converter ───────────────────────── */

export interface VideoStreamInfo {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  rotation?: number;
  pixFmt?: string;
  sar?: string;
  dar?: string;
}

export interface AudioStreamInfo {
  index: number; // absolute stream index
  order: number; // 0-based order among audio streams
  codec: string;
  channels: number;
  sampleRate: number;
  bitrate?: number;
  language?: string;
  title?: string;
}

export interface SubtitleStreamInfo {
  index: number;
  order: number;
  codec: string;
  language?: string;
  title?: string;
}

export interface MediaInfo {
  path: string;
  name: string;
  size: number;
  duration: number; // seconds (0 for images)
  formatName: string;
  bitrate?: number;
  video?: VideoStreamInfo;
  audioTracks: AudioStreamInfo[];
  subtitleTracks: SubtitleStreamInfo[];
  isImage: boolean;
  isAudioOnly: boolean;
  /** Can Chromium play this file directly in a <video>/<audio> element? */
  browserPlayable: boolean;
  mediaUrl?: string; // URL served by the local media server (when allowed)
}

export interface Interval {
  start: number;
  end: number;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SubtitleBurn {
  /** External subtitle file (srt/ass/ssa/vtt) OR an embedded subtitle stream order. */
  path?: string;
  streamOrder?: number;
  fontName: string;
  fontSize: number; // in ASS points relative to 288p (libass default PlayResY)
  primaryColor: string; // #RRGGBB
  outlineColor: string; // #RRGGBB
  outline: number;
  bold: boolean;
  position: 'bottom' | 'top' | 'middle';
  marginV: number;
}

export interface Watermark {
  type: 'text' | 'image';
  text?: string;
  imagePath?: string;
  position: 'tl' | 'tr' | 'bl' | 'br' | 'center';
  opacity: number; // 0..1
  /** Text: font size relative to video height (0.01..0.2). Image: width relative to video width (0.02..0.5). */
  scale: number;
  color?: string; // text color #RRGGBB
  margin: number; // px at output size
}

export interface EditSpec {
  /** Intervals (in source seconds) to REMOVE ("cut out" parts). */
  cuts: Interval[];
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: Crop | null;
  autoRemoveBlackBars: boolean;
  audioTrack: number; // order among audio tracks; -1 = mute
  volume: number; // 1 = unchanged
  normalizeAudio: boolean;
  speed: number; // 1 = normal (0.25..4)
  fadeIn: number; // seconds, 0 = none
  fadeOut: number;
  subtitles: SubtitleBurn | null;
  deinterlace: boolean;
  /** Color adjustments, 0 = unchanged. brightness -1..1, contrast/saturation -1..1 (mapped to eq). */
  brightness: number;
  contrast: number;
  saturation: number;
}

export type FitMode = 'pad' | 'crop' | 'stretch'; // pad = add black bars

export interface VideoOutput {
  codec: string; // ffmpeg-ish logical codec id: h264, hevc, av1, vp9, vp8, mpeg4, xvid, wmv2, mpeg2, mpeg1, flv1, h263, prores, theora, gif
  width?: number; // undefined = same as source
  height?: number;
  fps?: number; // undefined = same as source
  bitrateKbps?: number; // undefined = use quality (crf)
  quality?: number; // 0..100 visual quality slider when no bitrate (mapped to crf/qscale)
  twoPass?: boolean;
  fit: FitMode;
}

export interface AudioOutput {
  codec: string; // aac, mp3, opus, vorbis, flac, pcm, wma, ac3, mp2, alac, amr
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
}

export interface OutputSpec {
  targetId: string; // id from OUTPUT_TARGETS (shared/presets.ts)
  presetId: string; // id of a QualityPreset within that target, or 'custom'
  container: string; // file extension without dot
  video: VideoOutput | null; // null = drop video (audio only)
  audio: AudioOutput | null; // null = no audio
  targetSizeMB?: number; // limit output size (forces bitrate + two-pass)
  hwAccel: boolean;
  watermark: Watermark | null;
  /** Remux without re-encoding when nothing requires re-encoding (fast trim/join). */
  allowStreamCopy: boolean;
}

export interface ConvertInput {
  path: string;
  edit: EditSpec;
  info: MediaInfo;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type JobKind = 'convert' | 'slideshow' | 'disc' | 'audio';

export interface ConvertJob {
  id: string;
  kind: JobKind;
  title: string;
  inputs: ConvertInput[];
  join: boolean;
  output: OutputSpec;
  outputDir: string;
  outputName?: string; // without extension; default = input name (or first input name for joins)
  status: JobStatus;
  progress: number; // 0..1
  stage?: string;
  speed?: string; // e.g. "3.2x"
  eta?: number;
  error?: string;
  outputPaths?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  slideshow?: SlideshowSpec;
  disc?: DiscSpec;
  audioTool?: AudioToolSpec;
}

/* Photo slideshow (the Converter's "Photo" input) */
export interface SlideshowSpec {
  images: string[];
  secondsPerImage: number;
  transition: 'none' | 'fade' | 'slide' | 'wipe' | 'dissolve';
  transitionSeconds: number;
  panZoom: boolean; // "panorama" / Ken Burns effect
  music: string[]; // audio files, concatenated & looped/trimmed to fit
  width: number;
  height: number;
  fps: number;
  shuffle: boolean;
}

/* DVD / Blu-ray ("to DVD" / "to Blu-ray") */
export interface DiscSpec {
  type: 'dvd' | 'bluray';
  standard: 'pal' | 'ntsc';
  aspect: '16:9' | '4:3';
  title: string;
  menu: 'none' | 'simple' | 'thumbnails';
  output: 'folder' | 'iso' | 'burn';
  discSize: 'dvd5' | 'dvd9' | 'bd25' | 'bd50';
  resolution?: '1080' | '720'; // Blu-ray only
  drive?: string; // burner drive id for output=burn
}

/* AI / audio tools (vocal separation & clean-up) */
export type AudioToolOp =
  | 'vocals' // isolate vocals
  | 'instrumental' // remove vocals (backing track / karaoke)
  | 'stems' // vocals, drums, bass, other
  | 'denoise' // reduce background noise
  | 'voice' // clean up speech (denoise + de-ess + dialogue enhance)
  | 'dereverb' // reduce echo / reverb
  | 'normalize'; // loudness normalization (EBU R128)

export interface AudioToolSpec {
  op: AudioToolOp;
  strength: number; // 0..1
  outputFormat: 'wav' | 'mp3' | 'flac' | 'm4a';
  keepVideo: boolean; // when input is a video: write processed audio back into the video
}

export interface DiscDrive {
  id: string;
  name: string;
  letter?: string;
  canWriteDvd: boolean;
  canWriteBd: boolean;
  mediaPresent?: boolean;
}

/* ───────────────────────── App state & events ───────────────────────── */

export interface PrivacyState {
  hasPassword: boolean;
  unlocked: boolean;
}

export interface AuthState {
  signedIn: boolean;
  cookieCount: number;
  sites: string[];
  /** The saved cookies include a YouTube / Google account login. */
  youtube: boolean;
  /** Name of the browser a sign-in is currently waiting in, or null. */
  pending: string | null;
}

export interface Capabilities {
  electron: boolean; // false when running the UI in a normal browser (dev/testing)
  platform: string;
  hwEncoders: string[]; // e.g. ['h264_nvenc','hevc_nvenc']
  aiAudioAvailable: boolean; // Demucs AI separation pack installed
  aiAudioInstalling?: boolean;
  appVersion: string;
}

export interface AppState {
  settings: Settings;
  downloads: DownloadItem[];
  subscriptions: Subscription[];
  jobs: ConvertJob[];
  engines: EngineStatus[];
  privacy: PrivacyState;
  auth: AuthState;
  capabilities: Capabilities;
  mediaBase: string; // e.g. http://127.0.0.1:PORT
}

export type AppEvent =
  | { type: 'download'; item: DownloadItem }
  | { type: 'download-removed'; id: string }
  | { type: 'downloads-reset'; items: DownloadItem[] }
  | { type: 'subscription'; item: Subscription }
  | { type: 'subscription-removed'; id: string }
  | { type: 'job'; job: ConvertJob }
  | { type: 'job-removed'; id: string }
  | { type: 'engines'; engines: EngineStatus[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'privacy'; privacy: PrivacyState }
  | { type: 'auth'; auth: AuthState }
  | { type: 'capabilities'; capabilities: Capabilities }
  | { type: 'clipboard-link'; url: string }
  | { type: 'toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string };

/* ───────────────────────── RPC surface ─────────────────────────
 * Every backend method the UI can call. `invoke(method, args)` → result.
 */
export interface ApiMethods {
  'app.state': { args: void; result: AppState };
  'app.openExternal': { args: { url: string }; result: void };
  'app.openPath': { args: { path: string }; result: void };
  'app.showInFolder': { args: { path: string }; result: void };
  'app.readClipboard': { args: void; result: string };
  'app.pickFolder': { args: { title?: string; defaultPath?: string }; result: string | null };
  'app.pickFiles': {
    args: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean; folders?: boolean };
    result: string[];
  };
  'app.saveFile': {
    args: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] };
    result: string | null;
  };
  'app.writeTextFile': { args: { path: string; content: string }; result: void };
  'app.readTextFile': { args: { path: string }; result: string };

  'settings.update': { args: Partial<Settings>; result: Settings };

  'engines.install': { args: { name: EngineName }; result: void };
  'engines.checkUpdates': { args: void; result: EngineStatus[] };

  'media.analyze': { args: { url: string; flat?: boolean; channelTab?: ChannelTab }; result: AnalyzeResult };
  'media.search': { args: { query: string; limit?: number }; result: SearchResult[] };

  'downloads.add': {
    args: { items: { url: string; title?: string; thumbnail?: string; duration?: number; uploader?: string; playlistTitle?: string; playlistIndex?: number; qualityLabel?: string }[]; options: DownloadOptions };
    result: DownloadItem[];
  };
  'downloads.smart': { args: { urls: string[] }; result: DownloadItem[] };
  'downloads.pause': { args: { ids: string[] }; result: void };
  'downloads.resume': { args: { ids: string[] }; result: void };
  'downloads.retry': { args: { ids: string[] }; result: void };
  'downloads.remove': { args: { ids: string[]; deleteFiles: boolean }; result: void };
  'downloads.pauseAll': { args: void; result: void };
  'downloads.resumeAll': { args: void; result: void };
  'downloads.clearCompleted': { args: void; result: void };
  'downloads.export': { args: { path: string }; result: number };
  'downloads.import': { args: { path: string }; result: number };

  'subs.add': { args: { url: string; options: DownloadOptions; autoDownload: boolean; downloadExisting: boolean }; result: Subscription };
  'subs.update': { args: { id: string; patch: Partial<Pick<Subscription, 'options' | 'autoDownload' | 'enabled' | 'newCount'>> }; result: Subscription };
  'subs.remove': { args: { id: string }; result: void };
  'subs.check': { args: { id?: string }; result: void };

  'convert.probe': { args: { paths: string[] }; result: MediaInfo[] };
  'convert.frame': { args: { path: string; time: number; width?: number }; result: string }; // data: URL (jpeg)
  'convert.thumbs': { args: { path: string; count: number; width?: number }; result: string[] };
  'convert.detectCrop': { args: { path: string }; result: Crop | null };
  'convert.add': { args: { inputs: ConvertInput[]; join: boolean; output: OutputSpec; outputDir: string; outputName?: string }; result: ConvertJob[] };
  'convert.slideshow': { args: { spec: SlideshowSpec; output: OutputSpec; outputDir: string; outputName?: string }; result: ConvertJob };
  'convert.estimateSize': { args: { inputs: ConvertInput[]; join: boolean; output: OutputSpec }; result: number };
  'convert.cancel': { args: { ids: string[] }; result: void };
  'convert.remove': { args: { ids: string[] }; result: void };
  'convert.retry': { args: { ids: string[] }; result: void };
  'convert.clearCompleted': { args: void; result: void };

  'disc.drives': { args: void; result: DiscDrive[] };
  'disc.create': { args: { inputs: ConvertInput[]; spec: DiscSpec; outputDir: string }; result: ConvertJob };

  'audio.process': { args: { inputs: string[]; spec: AudioToolSpec; outputDir: string }; result: ConvertJob[] };
  'audio.installAi': { args: void; result: void };

  'privacy.setPassword': { args: { password: string; current?: string }; result: PrivacyState };
  'privacy.unlock': { args: { password: string }; result: PrivacyState };
  'privacy.lock': { args: void; result: PrivacyState };

  'auth.signIn': { args: { url?: string }; result: AuthState };
  'auth.finishSignIn': { args: { save: boolean }; result: void };
  'auth.signOut': { args: void; result: AuthState };
}

export type ApiMethod = keyof ApiMethods;
export type ApiArgs<M extends ApiMethod> = ApiMethods[M]['args'];
export type ApiResult<M extends ApiMethod> = ApiMethods[M]['result'];
