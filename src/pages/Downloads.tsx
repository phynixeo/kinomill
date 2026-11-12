import { useMemo, useState } from 'react';
import {
  AlertCircle, AudioWaveform, CheckCircle2, Clapperboard, ClipboardPaste, Clock, Copy, Download, ExternalLink, FileDown, FileUp, Film, FolderOpen,
  ListVideo, Lock, MoreHorizontal, Music, Pause, Play, RotateCcw, Search, Trash2, Tv, Wand2, X,
} from 'lucide-react';
import type { DownloadItem } from '../../shared/types';
import { addPathsToConverter, call, go, setState, toast, useStore } from '../lib/store';
import { openDl, pasteLink } from '../lib/actions';
import { formatBytes, formatDuration, formatEta, formatSpeed, siteName } from '../lib/format';
import { Empty, Menu, Progress, Seg, Select, Thumb } from '../components/ui';
import { PrivacyDialog } from '../components/PrivacyDialog';

type Filter = 'all' | 'active' | 'done' | 'failed';
type Sort = 'new' | 'old' | 'title' | 'size';

const ACTIVE = new Set(['queued', 'downloading', 'processing', 'paused']);

export function DownloadsPage() {
  const app = useStore((s) => s.app)!;
  const subsFilter = useStore((s) => s.subsFilter);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('new');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unlockOpen, setUnlockOpen] = useState(false);
  const settings = app.settings;

  const items = useMemo(() => {
    let list = app.downloads;
    if (subsFilter) list = list.filter((d) => d.subscriptionId === subsFilter);
    if (filter === 'active') list = list.filter((d) => ACTIVE.has(d.status));
    if (filter === 'done') list = list.filter((d) => d.status === 'completed');
    if (filter === 'failed') list = list.filter((d) => d.status === 'failed' || d.status === 'canceled');
    if (text.trim()) {
      const t = text.toLowerCase();
      list = list.filter((d) => d.title.toLowerCase().includes(t) || (d.uploader ?? '').toLowerCase().includes(t) || d.url.toLowerCase().includes(t));
    }
    const sorted = [...list];
    if (sort === 'new') sorted.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === 'old') sorted.sort((a, b) => a.createdAt - b.createdAt);
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'size') sorted.sort((a, b) => (b.fileSize ?? b.totalBytes ?? 0) - (a.fileSize ?? a.totalBytes ?? 0));
    return sorted;
  }, [app.downloads, filter, sort, text, subsFilter]);

  const counts = useMemo(
    () => ({
      active: app.downloads.filter((d) => ACTIVE.has(d.status)).length,
      done: app.downloads.filter((d) => d.status === 'completed').length,
      failed: app.downloads.filter((d) => d.status === 'failed').length,
    }),
    [app.downloads],
  );

  const sel = [...selected].filter((id) => items.some((i) => i.id === id));
  const toggleSel = (id: string, additive: boolean) =>
    setSelected((s) => {
      const n = new Set(additive ? s : []);
      if (s.has(id) && (additive || s.size === 1)) n.delete(id);
      else n.add(id);
      return n;
    });

  const removeIds = async (ids: string[], deleteFiles: boolean) => {
    if (deleteFiles && !window.confirm(`Delete ${ids.length === 1 ? 'this file' : `${ids.length} files`} from your disk? This can't be undone.`)) return;
    await call('downloads.remove', { ids, deleteFiles });
    setSelected(new Set());
  };

  const subName = subsFilter ? app.subscriptions.find((s) => s.id === subsFilter)?.title : undefined;
  const hiddenPrivate = app.privacy.hasPassword && !app.privacy.unlocked;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Downloads</h1>
        <button className="btn primary lg" onClick={() => void pasteLink()} title="Copy a link in your browser, then click here (or press Ctrl+V)">
          <ClipboardPaste size={18} /> Paste Link
        </button>
        <button
          className={`btn lg ${settings.smartMode ? '' : 'ghost'}`}
          style={settings.smartMode ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}
          onClick={() => openDl({ kind: 'smart' })}
          title="Download in one click with saved settings"
        >
          <Wand2 size={17} /> Smart Mode{settings.smartMode ? ' · On' : ''}
        </button>
        <button className="btn lg ghost" onClick={() => openDl({ kind: 'search' })}>
          <Search size={17} /> Search YouTube
        </button>
        <div className="spacer" />
        <Menu
          trigger={(open) => (
            <button className="icon-btn" onClick={open} aria-label="More actions">
              <MoreHorizontal size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => { close(); openDl({ kind: 'enter', purpose: 'channel' }); }}>
                <Tv size={16} /> Download a whole channel…
              </button>
              <button onClick={() => { close(); openDl({ kind: 'enter', purpose: 'playlist' }); }}>
                <ListVideo size={16} /> Download a whole playlist…
              </button>
              <hr />
              <button onClick={() => { close(); void call('downloads.resumeAll'); }}>
                <Play size={16} /> Resume all
              </button>
              <button onClick={() => { close(); void call('downloads.pauseAll'); }}>
                <Pause size={16} /> Pause all
              </button>
              <hr />
              <button
                onClick={async () => {
                  close();
                  const f = await call('app.pickFiles', { title: 'Import links or a Kinomill export', filters: [{ name: 'Links / exports', extensions: ['json', 'txt', 'csv'] }] });
                  if (f?.[0]) {
                    const n = await call('downloads.import', { path: f[0] });
                    if (n !== undefined) toast('success', `Imported ${n} item${n === 1 ? '' : 's'}`);
                  }
                }}
              >
                <FileUp size={16} /> Import links / downloads…
              </button>
              <button
                onClick={async () => {
                  close();
                  const p = await call('app.saveFile', { title: 'Export downloads and subscriptions', defaultPath: 'kinomill-downloads.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
                  if (p) {
                    const n = await call('downloads.export', { path: p });
                    if (n !== undefined) toast('success', `Exported ${n} items`);
                  }
                }}
              >
                <FileDown size={16} /> Export downloads & subscriptions…
              </button>
              <hr />
              <button onClick={() => { close(); void call('downloads.clearCompleted'); }}>
                <CheckCircle2 size={16} /> Clear finished from list
              </button>
            </>
          )}
        </Menu>
      </div>

      {app.downloads.length > 0 && (
        <div className="toolbar">
          <Seg
            small
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${app.downloads.length}` },
              { value: 'active', label: `Active ${counts.active}` },
              { value: 'done', label: `Finished ${counts.done}` },
              { value: 'failed', label: `Failed ${counts.failed}` },
            ]}
          />
          {subName && (
            <span className="chip on" onClick={() => setState({ subsFilter: undefined })}>
              {subName} <X size={13} />
            </span>
          )}
          <div className="spacer" />
          <div className="search-box">
            <Search size={15} />
            <input className="input" placeholder="Search downloads" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <Select
            value={sort}
            onChange={setSort}
            options={[
              { value: 'new', label: 'Newest first' },
              { value: 'old', label: 'Oldest first' },
              { value: 'title', label: 'Title A–Z' },
              { value: 'size', label: 'Largest first' },
            ]}
          />
        </div>
      )}

      {sel.length > 0 && (
        <div className="toolbar">
          <div className="notice" style={{ width: '100%', alignItems: 'center', padding: '6px 10px' }}>
            <b>{sel.length} selected</b>
            <div className="spacer" />
            <button className="btn sm" onClick={() => void call('downloads.resume', { ids: sel })}>
              <Play size={14} /> Resume
            </button>
            <button className="btn sm" onClick={() => void call('downloads.pause', { ids: sel })}>
              <Pause size={14} /> Pause
            </button>
            <button className="btn sm" onClick={() => void removeIds(sel, false)}>
              <X size={14} /> Remove from list
            </button>
            <button className="btn sm danger" onClick={() => void removeIds(sel, true)}>
              <Trash2 size={14} /> Delete files
            </button>
            <button className="icon-btn sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      <div className="page-body">
        {hiddenPrivate && (
          <div className="notice" style={{ marginBottom: 10, alignItems: 'center' }}>
            <Lock size={16} />
            <span className="grow">Private downloads are hidden.</span>
            <button className="btn sm" onClick={() => setUnlockOpen(true)}>
              Unlock
            </button>
          </div>
        )}
        {app.downloads.length === 0 ? (
          <Empty icon={<Download size={38} />} title="Download videos and music">
            <p>Copy a link to a video, playlist or channel from YouTube or 1000+ other sites, then click Paste Link.</p>
            <div className="steps">
              <div className="step">
                <span className="num">1</span> Copy a link in your browser
              </div>
              <div className="step">
                <span className="num">2</span> Click <b>Paste Link</b> or press Ctrl+V
              </div>
              <div className="step">
                <span className="num">3</span> Pick quality and format
              </div>
            </div>
            <button className="btn primary lg" style={{ marginTop: 18 }} onClick={() => void pasteLink()}>
              <ClipboardPaste size={18} /> Paste Link
            </button>
          </Empty>
        ) : items.length === 0 ? (
          <div className="empty">Nothing matches this filter.</div>
        ) : (
          <div className="list">
            {items.map((d) => (
              <DownloadRow key={d.id} d={d} selected={selected.has(d.id)} onSelect={(add) => toggleSel(d.id, add)} onRemove={(del) => void removeIds([d.id], del)} />
            ))}
          </div>
        )}
      </div>
      {unlockOpen && <PrivacyDialog mode="unlock" onClose={() => setUnlockOpen(false)} />}
    </div>
  );
}

function DownloadRow(props: { d: DownloadItem; selected: boolean; onSelect: (additive: boolean) => void; onRemove: (deleteFile: boolean) => void }) {
  const d = props.d;
  const active = d.status === 'downloading' || d.status === 'processing';
  const isAudio = d.options.kind === 'audio';
  return (
    <div
      className={`item ${props.selected ? 'selected' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, .menu')) return;
        props.onSelect(e.ctrlKey || e.metaKey || e.shiftKey);
      }}
      onDoubleClick={() => d.filePath && d.status === 'completed' && void call('app.openPath', { path: d.filePath })}
    >
      <Thumb src={d.thumbnail} duration={formatDuration(d.duration)} fallback={isAudio ? <Music size={22} /> : <Film size={22} />} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title" title={d.title}>
          {d.private && <Lock size={12} style={{ marginRight: 5, verticalAlign: -1 }} />}
          {d.title || d.url}
        </div>
        {d.status === 'completed' ? (
          <div className="meta">
            <span>{isAudio ? d.options.container.toUpperCase() : d.qualityLabel ?? d.options.container.toUpperCase()}</span>
            {d.fileSize ? <span className="dot">{formatBytes(d.fileSize)}</span> : null}
            {d.uploader && <span className="dot ellipsis">{d.uploader}</span>}
            {d.playlistTitle && <span className="dot ellipsis">{d.playlistTitle}</span>}
            <span className="dot">{siteName(d.extractor, d.url)}</span>
          </div>
        ) : d.status === 'failed' ? (
          <div className="meta" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>
            <AlertCircle size={13} style={{ flex: 'none' }} />
            <span className="selectable">{d.error ?? 'Download failed'}</span>
          </div>
        ) : (
          <div className="col gap-4" style={{ marginTop: 6 }}>
            <Progress value={d.progress} variant={d.status === 'paused' ? 'paused' : undefined} indeterminate={d.status === 'processing' || (d.status === 'downloading' && !d.progress)} />
            <div className="meta" style={{ marginTop: 0 }}>
              {d.status === 'queued' && (
                <>
                  <Clock size={12} /> Waiting…
                </>
              )}
              {d.status === 'paused' && <>Paused · {Math.round(d.progress * 100)}%</>}
              {d.status === 'canceled' && <>Canceled</>}
              {active && (
                <>
                  <span>{d.stage ?? (d.status === 'processing' ? 'Processing…' : 'Downloading')}</span>
                  {d.status === 'downloading' && d.progress > 0 && <span className="dot">{Math.round(d.progress * 100)}%</span>}
                  {d.totalBytes ? <span className="dot">{formatBytes(d.downloadedBytes)} of {formatBytes(d.totalBytes)}</span> : null}
                  {d.speed ? <span className="dot">{formatSpeed(d.speed)}</span> : null}
                  {d.eta ? <span className="dot">{formatEta(d.eta)}</span> : null}
                </>
              )}
              {d.qualityLabel && <span className="dot">{d.qualityLabel}</span>}
            </div>
          </div>
        )}
      </div>

      <div className={`actions ${props.selected ? 'show' : ''}`}>
        {d.status === 'completed' && d.filePath && (
          <>
            <button className="icon-btn" title="Play" onClick={() => void call('app.openPath', { path: d.filePath! })}>
              <Play size={17} />
            </button>
            <button className="icon-btn" title="Show in folder" onClick={() => void call('app.showInFolder', { path: d.filePath! })}>
              <FolderOpen size={17} />
            </button>
            <button
              className="icon-btn"
              title="Convert, trim or edit"
              onClick={async () => {
                await addPathsToConverter([d.filePath!]);
                go('converter');
              }}
            >
              <Clapperboard size={17} />
            </button>
          </>
        )}
        {(d.status === 'downloading' || d.status === 'queued' || d.status === 'processing') && (
          <button className="icon-btn" title="Pause" onClick={() => void call('downloads.pause', { ids: [d.id] })}>
            <Pause size={17} />
          </button>
        )}
        {(d.status === 'paused' || d.status === 'canceled') && (
          <button className="icon-btn" title="Resume" onClick={() => void call('downloads.resume', { ids: [d.id] })}>
            <Play size={17} />
          </button>
        )}
        {d.status === 'failed' && (
          <button className="btn sm" onClick={() => void call('downloads.retry', { ids: [d.id] })}>
            <RotateCcw size={14} /> Retry
          </button>
        )}
        <Menu
          trigger={(open) => (
            <button className="icon-btn" onClick={open} aria-label="More">
              <MoreHorizontal size={17} />
            </button>
          )}
        >
          {(close) => (
            <>
              {d.status === 'completed' && d.filePath && (
                <>
                  <button
                    onClick={() => {
                      close();
                      setState((s) => ({ audioFiles: [...s.audioFiles, d.filePath!], page: 'audio' }));
                    }}
                  >
                    <AudioWaveform size={16} /> Audio tools (remove vocals, noise…)
                  </button>
                  <hr />
                </>
              )}
              <button
                onClick={() => {
                  close();
                  void navigator.clipboard.writeText(d.url).then(() => toast('success', 'Link copied'));
                }}
              >
                <Copy size={16} /> Copy link
              </button>
              <button onClick={() => { close(); void call('app.openExternal', { url: d.url }); }}>
                <ExternalLink size={16} /> Open web page
              </button>
              {(d.status === 'failed' || d.status === 'completed') && (
                <button onClick={() => { close(); void call('downloads.retry', { ids: [d.id] }); }}>
                  <RotateCcw size={16} /> Download again
                </button>
              )}
              <hr />
              <button onClick={() => { close(); props.onRemove(false); }}>
                <X size={16} /> Remove from list
              </button>
              <button className="danger" onClick={() => { close(); props.onRemove(true); }}>
                <Trash2 size={16} /> Delete file
              </button>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
