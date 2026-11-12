import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Captions, Film, Link2, Music, Rss, Scissors, Search, Video, Wand2 } from 'lucide-react';
import type { AnalyzeResult, AudioContainer, ChannelTab, DownloadOptions, QualityOption, SearchResult, VideoContainer } from '../../shared/types';
import { defaultDownloadOptions } from '../../shared/defaults';
import { call, go, toast, useStore, getState } from '../lib/store';
import { openDl, startUrls, trackForTarget, type DlTarget } from '../lib/actions';
import { extractUrls, formatBytes, formatDuration, formatTimecode, languageName, parseTimecode, siteName } from '../lib/format';
import { Check, Field, FolderField, Modal, Seg, Select, Thumb, Toggle } from './ui';
import { AUDIO_CONTAINERS, AUDIO_QUALITIES, DownloadOptionsForm, VIDEO_CONTAINERS } from './DownloadOptionsForm';

export function DownloadDialogs() {
  const d = useStore((s) => s.dlDialog);
  if (!d) return null;
  const close = () => openDl(undefined);
  switch (d.kind) {
    case 'enter':
      return <EnterLinkDialog target={d.target} purpose={d.purpose} onClose={close} />;
    case 'analyze':
      return <AnalyzeDialog key={d.url + (d.flat ? '#flat' : '')} url={d.url} flat={d.flat} target={d.target} onClose={close} />;
    case 'batch':
      return <BatchDialog urls={d.urls} target={d.target} onClose={close} />;
    case 'smart':
      return <SmartModeDialog onClose={close} />;
    case 'search':
      return <SearchDialog onClose={close} />;
    case 'subscribe':
      return <SubscribeDialog initialUrl={d.url} onClose={close} />;
  }
}

/* ───────── Enter link(s) manually ───────── */
function EnterLinkDialog(props: { target?: DlTarget; purpose?: 'channel' | 'playlist'; onClose: () => void }) {
  const [text, setText] = useState('');
  const urls = extractUrls(text);
  const p = props.purpose;
  return (
    <Modal
      title={p === 'channel' ? 'Download a whole channel' : p === 'playlist' ? 'Download a whole playlist' : 'Paste a link'}
      onClose={props.onClose}
      footer={
        <>
          <span className="muted small">
            {urls.length ? `${urls.length} link${urls.length > 1 ? 's' : ''} found` : p === 'channel' ? 'Copy the channel link from your browser' : p === 'playlist' ? 'Copy the playlist link from your browser' : 'Copy a video, playlist or channel link from your browser'}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!urls.length}
            onClick={() => {
              props.onClose();
              // whole channel / playlist: always show the list so the user can pick or take everything
              if (p && urls.length === 1) openDl({ kind: 'analyze', url: urls[0], target: props.target, flat: p === 'playlist' });
              else void startUrls(urls, props.target);
            }}
          >
            Continue
          </button>
        </>
      }
    >
      <textarea
        className="input"
        rows={p ? 2 : 5}
        style={{ width: '100%' }}
        autoFocus
        placeholder={
          p === 'channel'
            ? 'https://www.youtube.com/@channelname'
            : p === 'playlist'
              ? 'https://www.youtube.com/playlist?list=…'
              : 'https://www.youtube.com/watch?v=…\nYou can paste several links, one per line.'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="muted small" style={{ marginBottom: 0 }}>
        Works with YouTube, Vimeo, TikTok, Instagram, Facebook, X (Twitter), Twitch, SoundCloud, Dailymotion, Bilibili, Reddit and 1000+ other sites.
      </p>
    </Modal>
  );
}

/* ───────── Analyze a single link ───────── */
function AnalyzeDialog(props: { url: string; flat?: boolean; target?: DlTarget; onClose: () => void }) {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    call('media.analyze', { url: props.url, flat: props.flat }).then((r) => {
      if (!alive) return;
      if (r) setResult(r);
      else setError('This link could not be read. Check the link, your internet connection, or sign in (Settings → Accounts) for private videos.');
    });
    return () => {
      alive = false;
    };
  }, [props.url, props.flat]);

  if (error) {
    return (
      <Modal title="Could not parse the link" onClose={props.onClose} footer={<><div className="spacer" /><button className="btn" onClick={props.onClose}>Close</button></>}>
        <div className="notice danger">
          <AlertTriangle size={18} />
          <div className="selectable">{error}</div>
        </div>
        <p className="muted small selectable" style={{ wordBreak: 'break-all' }}>{props.url}</p>
      </Modal>
    );
  }
  if (!result) {
    return (
      <Modal title="Parsing link…" onClose={props.onClose} size="narrow">
        <div className="col" style={{ alignItems: 'center', padding: '24px 0', gap: 14 }}>
          <div className="spinner lg" />
          <div className="muted small ellipsis" style={{ maxWidth: '100%' }}>{props.url}</div>
        </div>
      </Modal>
    );
  }
  return result.type === 'playlist' ? (
    <PlaylistDialog result={result} target={props.target} onClose={props.onClose} />
  ) : (
    <VideoDialog result={result} sourceUrl={props.url} target={props.target} onClose={props.onClose} />
  );
}

function qualitySort(a: QualityOption, b: QualityOption): number {
  return b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || Number(!!b.hdr) - Number(!!a.hdr);
}

function VideoDialog(props: { result: AnalyzeResult; sourceUrl: string; target?: DlTarget; onClose: () => void }) {
  const r = props.result;
  const settings = useStore((s) => s.app!.settings);
  const qualities = useMemo(() => [...(r.videoQualities ?? [])].sort(qualitySort), [r.videoQualities]);
  const audios = r.audioQualities ?? [];
  const languages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of audios) if (a.language && !seen.has(a.language)) seen.set(a.language, a.languageName ?? languageName(a.language));
    return [...seen.entries()];
  }, [audios]);
  const defaultLang = audios.find((a) => a.isDefault)?.language ?? languages[0]?.[0];

  const smart = settings.smartOptions;
  const [kind, setKind] = useState<'video' | 'audio'>(props.target === 'audio' ? 'audio' : 'video');
  const [vContainer, setVContainer] = useState<VideoContainer>(props.target === 'converter' ? 'mkv' : smart.kind === 'video' ? (smart.container as VideoContainer) : 'mp4');
  const [aContainer, setAContainer] = useState<AudioContainer>(smart.kind === 'audio' ? (smart.container as AudioContainer) : 'mp3');
  const [aBitrate, setABitrate] = useState('320');
  const preferred = useMemo(() => {
    const want = Number(smart.quality) || 1080;
    return qualities.find((q) => q.height <= want) ?? qualities[0];
  }, [qualities, smart.quality]);
  const [qKey, setQKey] = useState(preferred?.key);
  const [lang, setLang] = useState<string | undefined>(defaultLang);
  const [subsOn, setSubsOn] = useState(false);
  const [subLangs, setSubLangs] = useState<string[]>([]);
  const [showAuto, setShowAuto] = useState(false);
  const [embed, setEmbed] = useState(true);
  const [partOn, setPartOn] = useState(false);
  const [start, setStart] = useState('0:00');
  const [end, setEnd] = useState(formatTimecode(r.duration ?? 0, false));
  const [splitCh, setSplitCh] = useState(false);
  const [dir, setDir] = useState(settings.downloadDir);
  const [busy, setBusy] = useState(false);

  const q = qualities.find((x) => x.key === qKey) ?? qualities[0];
  const manualSubs = (r.subtitles ?? []).filter((s) => !s.auto);
  const autoSubs = (r.subtitles ?? []).filter((s) => s.auto);
  const audioForLang = (l?: string) => {
    const pool = l ? audios.filter((a) => a.language === l) : audios;
    return [...(pool.length ? pool : audios)].sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
  };
  const bestAudio = audioForLang(lang);
  const vp9InMp4 = kind === 'video' && vContainer === 'mp4' && q && q.vcodec !== 'h264' && q.vcodec !== 'hevc' && q.vcodec !== 'av1';

  const download = async () => {
    const opts: DownloadOptions = {
      ...defaultDownloadOptions(),
      kind,
      container: kind === 'video' ? vContainer : aContainer,
      quality: kind === 'video' ? String(q?.height ?? 'best') : aBitrate,
      videoFormatId: kind === 'video' ? q?.formatId : undefined,
      audioFormatId: bestAudio?.formatId,
      audioLanguage: lang,
      codecPreference: 'any',
      subtitles: { enabled: subsOn && subLangs.length > 0, langs: subLangs, includeAuto: subLangs.some((l) => autoSubs.some((a) => a.lang === l) && !manualSubs.some((m) => m.lang === l)), embed: kind === 'video' && embed, format: 'srt' },
      outputDir: dir === settings.downloadDir ? '' : dir,
      splitChapters: splitCh,
      section: partOn ? { start: parseTimecode(start) ?? 0, end: parseTimecode(end) ?? r.duration ?? 0 } : null,
    };
    setBusy(true);
    const items = await call('downloads.add', {
      items: [{ url: r.webpageUrl || r.url, title: r.title, thumbnail: r.thumbnail, duration: r.duration, uploader: r.uploader, qualityLabel: kind === 'video' ? q?.label : `${aContainer.toUpperCase()} ${aBitrate === 'best' ? '' : aBitrate + ' kbps'}`.trim() }],
      options: opts,
    });
    setBusy(false);
    if (items) {
      trackForTarget(items.map((i) => i.id), props.target);
      props.onClose();
      if (!props.target) go('downloads');
      toast('success', `Downloading "${r.title}"${props.target === 'converter' ? ' — it will appear in the Converter when finished' : props.target === 'audio' ? ' — it will appear in Audio Tools when finished' : ''}`);
    }
  };

  const est = kind === 'video' ? q?.filesize : bestAudio?.filesize;

  return (
    <Modal
      title="Download"
      size="wide"
      onClose={props.onClose}
      footer={
        <>
          {est ? <span className="muted small">Estimated size: {formatBytes(est)}</span> : null}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (kind === 'video' && !q)} onClick={download}>
            {kind === 'video' ? <Video size={16} /> : <Music size={16} />} Download
          </button>
        </>
      }
    >
      <div className="media-head">
        <Thumb src={r.thumbnail} duration={formatDuration(r.duration)} fallback={<Film size={26} />} />
        <div className="grow col gap-4">
          <h3 className="selectable" style={{ fontSize: 15 }}>
            {r.title}
          </h3>
          <div className="muted small">
            {[r.uploader, siteName(r.extractor, r.url)].filter(Boolean).join(' · ')}
          </div>
          <div className="row wrap gap-4" style={{ marginTop: 4 }}>
            {r.isLive && <span className="badge danger">LIVE</span>}
            {r.is360 && <span className="badge info">360°</span>}
            {r.is3D && <span className="badge info">3D</span>}
            {(r.chapters?.length ?? 0) > 0 && <span className="badge">{r.chapters!.length} chapters</span>}
            {(r.subtitles?.length ?? 0) > 0 && <span className="badge"><Captions size={12} /> subtitles</span>}
            {languages.length > 1 && <span className="badge">{languages.length} audio languages</span>}
          </div>
        </div>
      </div>

      {/[?&]list=/.test(props.sourceUrl) && (
        <div className="notice" style={{ marginBottom: 14, alignItems: 'center' }}>
          <Film size={16} />
          <span className="grow">This video is part of a playlist.</span>
          <button className="btn sm" onClick={() => openDl({ kind: 'analyze', url: props.sourceUrl, target: props.target, flat: true })}>
            Download the whole playlist
          </button>
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <Seg
          value={kind}
          onChange={setKind}
          options={[
            { value: 'video', label: (<><Video size={15} /> Download video</>) },
            { value: 'audio', label: (<><Music size={15} /> Extract audio</>) },
          ]}
        />
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="grow col">
          <div className="field-label">Quality</div>
          {kind === 'video' ? (
            qualities.length ? (
              <div className="choice-list">
                {qualities.map((x) => (
                  <div key={x.key} className={`choice ${x.key === q?.key ? 'on' : ''}`} onClick={() => setQKey(x.key)} role="radio" aria-checked={x.key === q?.key} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setQKey(x.key)}>
                    <span className="radio" />
                    <span className="label">{x.label}</span>
                    <span className="row gap-4">
                      {x.height >= 2160 && <span className="badge accent">{x.height >= 4320 ? '8K' : '4K'}</span>}
                      {x.hdr && <span className="badge warning">HDR</span>}
                      <span className="badge">{x.vcodec.toUpperCase()}</span>
                    </span>
                    <span className="spacer" />
                    <span className="muted small">{formatBytes(x.filesize)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="notice warning">No separate video qualities were found — the best available version will be downloaded.</div>
            )
          ) : (
            <div className="choice-list">
              {AUDIO_QUALITIES.map((x) => (
                <div key={x.value} className={`choice ${x.value === aBitrate ? 'on' : ''}`} onClick={() => setABitrate(x.value)} role="radio" aria-checked={x.value === aBitrate} tabIndex={0}>
                  <span className="radio" />
                  <span className="label">{x.label}</span>
                  {x.value === 'best' && bestAudio && <span className="muted small">original {bestAudio.acodec} {bestAudio.abr ? Math.round(bestAudio.abr) + ' kbps' : ''}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="col" style={{ width: 300, gap: 14 }}>
          <Field label="Format">
            {kind === 'video' ? (
              <Select value={vContainer} options={VIDEO_CONTAINERS} onChange={setVContainer} />
            ) : (
              <Select value={aContainer} options={AUDIO_CONTAINERS} onChange={setAContainer} />
            )}
          </Field>
          {vp9InMp4 && <div className="tiny muted">This quality uses {q!.vcodec.toUpperCase()} video. It will be stored in MP4; choose MKV if an old player can't open it.</div>}
          {languages.length > 1 && (
            <Field label="Audio language">
              <Select value={lang ?? ''} options={languages.map(([v, l]) => ({ value: v, label: l + (v === defaultLang ? ' (original)' : '') }))} onChange={(v) => setLang(v)} />
            </Field>
          )}
          <Field label="Save to">
            <FolderField value={dir} onChange={setDir} />
          </Field>
        </div>
      </div>

      {(r.subtitles?.length ?? 0) > 0 && (
        <div className="card flat col" style={{ marginTop: 16 }}>
          <div className="row">
            <Check checked={subsOn} onChange={setSubsOn} label={<b>Subtitles</b>} />
            <div className="spacer" />
            {subsOn && kind === 'video' && <Check checked={embed} onChange={setEmbed} label="Embed into the video" />}
          </div>
          {subsOn && (
            <>
              <div className="row wrap gap-4">
                {manualSubs.map((s) => (
                  <button key={'m' + s.lang} className={`chip ${subLangs.includes(s.lang) ? 'on' : ''}`} onClick={() => setSubLangs((l) => (l.includes(s.lang) ? l.filter((x) => x !== s.lang) : [...l, s.lang]))}>
                    {s.name || languageName(s.lang)}
                  </button>
                ))}
                {manualSubs.length === 0 && <span className="muted small">Only automatic captions are available for this video.</span>}
              </div>
              {autoSubs.length > 0 && (
                <>
                  <Toggle checked={showAuto} onChange={setShowAuto} label={<span className="small">Show auto-generated and auto-translated ({autoSubs.length})</span>} />
                  {showAuto && (
                    <div className="row wrap gap-4" style={{ maxHeight: 130, overflowY: 'auto' }}>
                      {autoSubs.map((s) => (
                        <button key={'a' + s.lang} className={`chip ${subLangs.includes(s.lang) ? 'on' : ''}`} onClick={() => setSubLangs((l) => (l.includes(s.lang) ? l.filter((x) => x !== s.lang) : [...l, s.lang]))}>
                          {s.name || languageName(s.lang)}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="card flat col" style={{ marginTop: 12 }}>
        <div className="row">
          <Check checked={partOn} onChange={setPartOn} label={<><Scissors size={14} style={{ verticalAlign: -2 }} /> <b>Download only a part</b></>} />
          {(r.chapters?.length ?? 0) > 1 && (
            <>
              <div className="spacer" />
              <Check checked={splitCh} onChange={setSplitCh} label="Split into one file per chapter" />
            </>
          )}
        </div>
        {partOn && (
          <div className="row">
            <Field label="From">
              <input className="input mono" style={{ width: 120 }} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="To">
              <input className="input mono" style={{ width: 120 }} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            <span className="muted small" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
              Format: minutes:seconds or h:mm:ss
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────── Playlist / channel ───────── */
function PlaylistDialog(props: { result: AnalyzeResult; target?: DlTarget; onClose: () => void }) {
  const [r, setR] = useState(props.result);
  const [loadingTab, setLoadingTab] = useState<ChannelTab | null>(null);
  const settings = useStore((s) => s.app!.settings);
  const entries = r.entries ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(entries.filter((e) => !e.live).map((e) => e.id)));
  const liveCount = entries.filter((e) => e.live).length;
  const switchTab = async (tab: ChannelTab) => {
    setLoadingTab(tab);
    const next = await call('media.analyze', { url: r.webpageUrl || r.url, channelTab: tab });
    setLoadingTab(null);
    if (next && next.type === 'playlist') {
      setR(next);
      setSelected(new Set((next.entries ?? []).filter((e) => !e.live).map((e) => e.id)));
    }
  };
  const [opts, setOpts] = useState<DownloadOptions>(() => ({ ...settings.smartOptions, videoFormatId: undefined, audioFormatId: undefined, outputDir: '' }));
  const [filter, setFilter] = useState('');
  const [subscribe, setSubscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const visible = entries.filter((e) => !filter || e.title.toLowerCase().includes(filter.toLowerCase()));
  const selectable = visible.filter((e) => !e.live);
  const allOn = selectable.length > 0 && selectable.every((e) => selected.has(e.id));

  const go2 = async () => {
    setBusy(true);
    const chosen = entries.filter((e) => selected.has(e.id));
    const items = await call('downloads.add', {
      items: chosen.map((e) => ({ url: e.url, title: e.title, thumbnail: e.thumbnail, duration: e.duration, uploader: e.uploader, playlistTitle: r.title, playlistIndex: e.index })),
      options: opts,
    });
    if (items && subscribe) {
      const sub = await call('subs.add', { url: r.webpageUrl || r.url, options: opts, autoDownload: true, downloadExisting: false });
      if (sub) toast('success', `Subscribed to ${sub.title}. New videos will download automatically.`);
    }
    setBusy(false);
    if (items) {
      trackForTarget(items.map((i) => i.id), props.target);
      toast('success', `Added ${items.length} downloads from "${r.title}"`);
      props.onClose();
      go('downloads');
    }
  };

  return (
    <Modal
      title={r.isChannel ? 'Download channel' : 'Download playlist'}
      size="wide"
      onClose={props.onClose}
      footer={
        <>
          {r.isChannel && <Toggle checked={subscribe} onChange={setSubscribe} label={<span className="row gap-4"><Rss size={14} /> Subscribe — download new videos automatically</span>} />}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!loadingTab || selected.size === 0} onClick={go2}>
            Download {selected.size === entries.length && entries.length > 1 ? 'all ' : ''}
            {selected.size} video{selected.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="media-head">
        <Thumb src={r.thumbnail ?? entries[0]?.thumbnail} fallback={<Film size={26} />} />
        <div className="grow">
          <h3 style={{ fontSize: 15 }}>{r.title}</h3>
          <div className="muted small">
            {[r.uploader, `${r.entryCount ?? entries.length} video${(r.entryCount ?? entries.length) === 1 ? '' : 's'}`, siteName(r.extractor, r.url)].filter(Boolean).join(' · ')}
          </div>
          {r.isChannel && (
            <div className="row wrap" style={{ marginTop: 10 }}>
              <Seg
                small
                value={loadingTab ?? r.channelTab ?? 'videos'}
                onChange={(t) => void switchTab(t)}
                options={[
                  { value: 'videos' as ChannelTab, label: 'Videos' },
                  { value: 'shorts' as ChannelTab, label: 'Shorts' },
                  { value: 'streams' as ChannelTab, label: 'Live streams' },
                  { value: 'all' as ChannelTab, label: 'Everything' },
                ]}
              />
              {loadingTab && (
                <span className="row muted small">
                  <span className="spinner" /> Listing {loadingTab === 'all' ? 'every video on the channel' : loadingTab === 'streams' ? 'live streams' : loadingTab}… big channels take a minute
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="grow col">
          <div className="row">
            <Check checked={allOn} indeterminate={!allOn && visible.some((e) => selected.has(e.id))} onChange={(v) => setSelected((s) => {
              const n = new Set(s);
              for (const e of selectable) v ? n.add(e.id) : n.delete(e.id);
              return n;
            })} label={<b>Select all</b>} />
            <div className="spacer" />
            <div className="search-box">
              <Search size={15} />
              <input className="input" style={{ width: 200 }} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
          {liveCount > 0 && (
            <div className="tiny muted">
              {liveCount} live or upcoming stream{liveCount > 1 ? 's are' : ' is'} not selected — {liveCount > 1 ? 'they' : 'it'} can be downloaded once {liveCount > 1 ? 'they have' : 'it has'} ended.
            </div>
          )}
          <div className="entries">
            {visible.map((e) => (
              <label key={e.id} className="entry" style={{ cursor: 'pointer' }}>
                <Check checked={selected.has(e.id)} onChange={(v) => setSelected((s) => {
                  const n = new Set(s);
                  v ? n.add(e.id) : n.delete(e.id);
                  return n;
                })} />
                <span className="faint tiny" style={{ width: 26, textAlign: 'right' }}>{e.index}</span>
                <Thumb className="sm" src={e.thumbnail} />
                <span className="grow ellipsis">{e.title}</span>
                {e.live === 'now' && <span className="badge danger">LIVE NOW</span>}
                {e.live === 'upcoming' && <span className="badge warning">Upcoming</span>}
                {e.section === 'short' && <span className="badge">Short</span>}
                {e.section === 'live' && !e.live && <span className="badge info">Past stream</span>}
                <span className="muted small">{formatDuration(e.duration)}</span>
              </label>
            ))}
          </div>
        </div>
        <div style={{ width: 320 }}>
          <DownloadOptionsForm value={opts} onChange={setOpts} defaultDir={settings.downloadDir} />
        </div>
      </div>
    </Modal>
  );
}

/* ───────── Several links at once ───────── */
function BatchDialog(props: { urls: string[]; target?: DlTarget; onClose: () => void }) {
  const settings = useStore((s) => s.app!.settings);
  const [opts, setOpts] = useState<DownloadOptions>(() => ({ ...settings.smartOptions, outputDir: '' }));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Download ${props.urls.length} links`}
      onClose={props.onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const items = await call('downloads.add', { items: props.urls.map((url) => ({ url })), options: opts });
              setBusy(false);
              if (items) {
                trackForTarget(items.map((i) => i.id), props.target);
                toast('success', `Added ${items.length} downloads`);
                props.onClose();
                go('downloads');
              }
            }}
          >
            Download all
          </button>
        </>
      }
    >
      <div className="entries" style={{ maxHeight: 130, marginBottom: 16 }}>
        {props.urls.map((u) => (
          <div key={u} className="entry small ellipsis">
            <Link2 size={14} className="faint" /> {u}
          </div>
        ))}
      </div>
      <DownloadOptionsForm value={opts} onChange={setOpts} defaultDir={settings.downloadDir} />
    </Modal>
  );
}

/* ───────── Smart Mode settings ───────── */
function SmartModeDialog(props: { onClose: () => void }) {
  const settings = useStore((s) => s.app!.settings);
  const [on, setOn] = useState(settings.smartMode);
  const [opts, setOpts] = useState<DownloadOptions>(settings.smartOptions);
  return (
    <Modal
      title={<span className="row"><Wand2 size={18} style={{ color: 'var(--accent)' }} /> Smart Mode</span>}
      onClose={props.onClose}
      footer={
        <>
          <Toggle checked={on} onChange={setOn} label={<b>{on ? 'Smart Mode is on' : 'Smart Mode is off'}</b>} />
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const r = await call('settings.update', { smartMode: on, smartOptions: { ...opts, videoFormatId: undefined, audioFormatId: undefined } });
              if (r) {
                toast('success', on ? 'Smart Mode is on — pasted links now download in one click.' : 'Smart Mode settings saved.');
                props.onClose();
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        With Smart Mode on, pasting a link starts the download right away using these settings — no questions asked. Playlists and channels download all their videos. If a chosen quality isn't available, the closest lower one is used.
      </p>
      <DownloadOptionsForm value={opts} onChange={setOpts} defaultDir={settings.downloadDir} />
    </Modal>
  );
}

/* ───────── In-app YouTube search ───────── */
function SearchDialog(props: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    if (extractUrls(q).length) {
      props.onClose();
      void startUrls(extractUrls(q));
      return;
    }
    setBusy(true);
    const r = await call('media.search', { query: q.trim(), limit: 25 });
    setBusy(false);
    setResults(r ?? []);
  };
  return (
    <Modal title="Search YouTube" size="wide" onClose={props.onClose}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="search-box grow">
          <Search size={15} />
          <input className="input" style={{ width: '100%' }} autoFocus placeholder="Search for videos, music, channels…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn primary" type="submit" disabled={busy}>
          Search
        </button>
      </form>
      <div style={{ marginTop: 14, minHeight: 200 }}>
        {busy && (
          <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
            <div className="spinner lg" />
          </div>
        )}
        {!busy && results && results.length === 0 && <div className="empty">No results.</div>}
        {!busy && results && (
          <div className="list">
            {results.map((r) => (
              <div key={r.id} className="item">
                <Thumb src={r.thumbnail} duration={formatDuration(r.duration)} fallback={<Film size={22} />} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="title">{r.title}</div>
                  <div className="meta">
                    {r.uploader}
                    {r.viewCount ? <span className="dot">{Intl.NumberFormat(undefined, { notation: 'compact' }).format(r.viewCount)} views</span> : null}
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={() => {
                    openDl({ kind: 'analyze', url: r.url });
                  }}
                >
                  Options…
                </button>
                <button
                  className="btn sm primary"
                  onClick={async () => {
                    const items = await call('downloads.smart', { urls: [r.url] });
                    if (items) toast('success', `Downloading "${r.title}"`);
                  }}
                >
                  Download
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────── Subscribe to a channel / playlist ───────── */
function SubscribeDialog(props: { initialUrl?: string; onClose: () => void }) {
  const settings = useStore((s) => s.app!.settings);
  const [url, setUrl] = useState(props.initialUrl ?? '');
  const [opts, setOpts] = useState<DownloadOptions>(() => ({ ...settings.smartOptions, outputDir: '' }));
  const [auto, setAuto] = useState(true);
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const urls = extractUrls(url);
  return (
    <Modal
      title={<span className="row"><Rss size={18} /> New subscription</span>}
      onClose={props.onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !urls.length}
            onClick={async () => {
              setBusy(true);
              const sub = await call('subs.add', { url: urls[0], options: opts, autoDownload: auto, downloadExisting: existing });
              setBusy(false);
              if (sub) {
                toast('success', `Subscribed to ${sub.title}`);
                props.onClose();
                go('subscriptions');
              }
            }}
          >
            {busy ? 'Checking channel…' : 'Subscribe'}
          </button>
        </>
      }
    >
      <div className="col gap-16">
        <Field label="Channel or playlist link" hint="e.g. https://www.youtube.com/@channelname">
          <input className="input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/@…" />
        </Field>
        <div className="col">
          <Toggle checked={auto} onChange={setAuto} label="Download new videos automatically" />
          <Toggle checked={existing} onChange={setExisting} label="Also download the videos that are already there" />
        </div>
        <DownloadOptionsForm value={opts} onChange={setOpts} defaultDir={settings.downloadDir} />
      </div>
    </Modal>
  );
}

export function useDefaultDir(): string {
  return getState().app?.settings.downloadDir ?? '';
}
