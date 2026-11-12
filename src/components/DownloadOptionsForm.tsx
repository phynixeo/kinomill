import type { AudioContainer, DownloadOptions, VideoContainer } from '../../shared/types';
import { Check, Field, FolderField, Seg, Select } from './ui';
import { LANGUAGE_NAMES } from '../lib/format';
import { Music, Video } from 'lucide-react';

export const VIDEO_CONTAINERS: { value: VideoContainer; label: string }[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'webm', label: 'WebM' },
  { value: 'mov', label: 'MOV' },
];
export const AUDIO_CONTAINERS: { value: AudioContainer; label: string }[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A (AAC)' },
  { value: 'opus', label: 'Opus' },
  { value: 'ogg', label: 'OGG (Vorbis)' },
  { value: 'flac', label: 'FLAC (lossless)' },
  { value: 'wav', label: 'WAV (lossless)' },
];
export const VIDEO_QUALITIES = [
  { value: 'best', label: 'Best available' },
  { value: '4320', label: '8K (4320p)' },
  { value: '2160', label: '4K (2160p)' },
  { value: '1440', label: '2K (1440p)' },
  { value: '1080', label: 'Full HD (1080p)' },
  { value: '720', label: 'HD (720p)' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
  { value: '240', label: '240p' },
  { value: '144', label: '144p' },
];
export const AUDIO_QUALITIES = [
  { value: 'best', label: 'Best available' },
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' },
  { value: '96', label: '96 kbps' },
];
const CODECS = [
  { value: 'any', label: 'Automatic (best quality)' },
  { value: 'h264', label: 'H.264 — plays everywhere' },
  { value: 'vp9', label: 'VP9' },
  { value: 'av1', label: 'AV1 — smallest files' },
  { value: 'hevc', label: 'H.265 / HEVC' },
] as const;

export const LANG_OPTIONS = [{ value: '', label: 'Original / default' }, ...Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label }))];

/** Generic download options (Smart Mode, playlists, batch links, subscriptions). */
export function DownloadOptionsForm(props: { value: DownloadOptions; onChange: (v: DownloadOptions) => void; defaultDir: string; hideFolder?: boolean }) {
  const o = props.value;
  const set = (patch: Partial<DownloadOptions>) => props.onChange({ ...o, ...patch });
  const setKind = (kind: 'video' | 'audio') =>
    set(kind === 'video' ? { kind, container: 'mp4', quality: '1080' } : { kind, container: 'mp3', quality: '320', subtitles: { ...o.subtitles, embed: false } });

  return (
    <div className="col gap-16">
      <Seg
        value={o.kind}
        onChange={setKind}
        options={[
          { value: 'video', label: (<><Video size={15} /> Video</>) },
          { value: 'audio', label: (<><Music size={15} /> Audio only</>) },
        ]}
      />
      <div className="form-grid">
        <Field label="Quality">
          <Select value={o.quality} options={o.kind === 'video' ? VIDEO_QUALITIES : AUDIO_QUALITIES} onChange={(quality) => set({ quality, videoFormatId: undefined, audioFormatId: undefined })} />
        </Field>
        <Field label="Format">
          <Select value={o.container} options={o.kind === 'video' ? VIDEO_CONTAINERS : AUDIO_CONTAINERS} onChange={(container) => set({ container })} />
        </Field>
        {o.kind === 'video' && (
          <Field label="Preferred video codec">
            <Select value={o.codecPreference} options={[...CODECS]} onChange={(codecPreference) => set({ codecPreference })} />
          </Field>
        )}
        <Field label="Audio language" hint="Used when a video has several dubbed audio tracks">
          <Select value={o.audioLanguage ?? ''} options={LANG_OPTIONS} onChange={(v) => set({ audioLanguage: v || undefined })} />
        </Field>
      </div>
      <SubtitleOptionsInline value={o} onChange={props.onChange} />
      {!props.hideFolder && (
        <Field label="Save to">
          <FolderField value={o.outputDir || props.defaultDir} onChange={(outputDir) => set({ outputDir })} />
        </Field>
      )}
    </div>
  );
}

function SubtitleOptionsInline(props: { value: DownloadOptions; onChange: (v: DownloadOptions) => void }) {
  const o = props.value;
  const s = o.subtitles;
  const setSub = (patch: Partial<DownloadOptions['subtitles']>) => props.onChange({ ...o, subtitles: { ...s, ...patch } });
  return (
    <div className="card flat col">
      <Check checked={s.enabled} onChange={(enabled) => setSub({ enabled })} label={<b>Download subtitles</b>} />
      {s.enabled && (
        <div className="form-grid" style={{ marginTop: 6 }}>
          <Field label="Languages" hint="Language codes separated by commas, e.g. en, es, fr — or * for all">
            <input className="input" value={s.langs.join(', ')} onChange={(e) => setSub({ langs: e.target.value.split(/[,\s]+/).filter(Boolean) })} spellCheck={false} />
          </Field>
          <Field label="Subtitle format">
            <Select
              value={s.format}
              options={[
                { value: 'srt', label: 'SRT' },
                { value: 'vtt', label: 'WebVTT' },
                { value: 'ass', label: 'ASS' },
              ]}
              onChange={(format) => setSub({ format })}
            />
          </Field>
          <div className="col" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Check checked={s.includeAuto} onChange={(includeAuto) => setSub({ includeAuto })} label="Include auto-generated / auto-translated" />
            {o.kind === 'video' && <Check checked={s.embed} onChange={(embed) => setSub({ embed })} label="Embed into the video file" />}
          </div>
        </div>
      )}
    </div>
  );
}
