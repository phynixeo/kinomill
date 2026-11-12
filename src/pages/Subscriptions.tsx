import { useState } from 'react';
import { AlertCircle, ExternalLink, ListVideo, Plus, RefreshCw, Rss, Settings2, Trash2 } from 'lucide-react';
import type { DownloadOptions, Subscription } from '../../shared/types';
import { call, setState, toast, useStore } from '../lib/store';
import { openDl } from '../lib/actions';
import { timeAgo } from '../lib/format';
import { Empty, Modal, Thumb, Toggle } from '../components/ui';
import { DownloadOptionsForm } from '../components/DownloadOptionsForm';

export function SubscriptionsPage() {
  const app = useStore((s) => s.app)!;
  const subs = app.subscriptions;
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [checking, setChecking] = useState(false);
  const every = app.settings.subscriptionCheckMinutes;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Subscriptions</h1>
        <button className="btn primary" onClick={() => openDl({ kind: 'subscribe' })}>
          <Plus size={17} /> Subscribe to a channel
        </button>
        {subs.length > 0 && (
          <button
            className="btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await call('subs.check', {});
              setChecking(false);
            }}
          >
            <RefreshCw size={16} className={checking ? 'spin' : ''} /> Check all now
          </button>
        )}
        <div className="spacer" />
        <span className="muted small">{every > 0 ? `Checked automatically every ${every >= 60 ? `${every / 60} h` : `${every} min`}` : 'Automatic checks are off'}</span>
      </div>
      <div className="page-body">
        {subs.length === 0 ? (
          <Empty icon={<Rss size={38} />} title="Never miss a video">
            <p>Subscribe to YouTube channels or playlists, and Kinomill downloads new videos automatically as soon as they are published — with your preferred quality and format.</p>
            <button className="btn primary lg" style={{ marginTop: 14 }} onClick={() => openDl({ kind: 'subscribe' })}>
              <Plus size={18} /> Subscribe to a channel
            </button>
          </Empty>
        ) : (
          subs.map((s) => {
            const count = app.downloads.filter((d) => d.subscriptionId === s.id).length;
            return (
              <div key={s.id} className="sub-card">
                <Thumb className="square" src={s.thumbnail} fallback={<Rss size={22} />} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row">
                    <b className="ellipsis">{s.title}</b>
                    {s.newCount > 0 && <span className="badge accent">{s.newCount} new</span>}
                    {!s.enabled && <span className="badge">Paused</span>}
                  </div>
                  <div className="muted small">
                    {s.options.kind === 'audio' ? 'Audio' : 'Video'} · {s.options.container.toUpperCase()} · {s.options.quality === 'best' ? 'best quality' : s.options.kind === 'audio' ? `${s.options.quality} kbps` : `${s.options.quality}p`} · last checked {timeAgo(s.lastChecked)}
                  </div>
                  {s.error && (
                    <div className="small row gap-4" style={{ color: 'var(--danger)' }}>
                      <AlertCircle size={13} /> {s.error}
                    </div>
                  )}
                </div>
                <Toggle checked={s.autoDownload} onChange={(autoDownload) => void call('subs.update', { id: s.id, patch: { autoDownload } })} label={<span className="small">Auto-download</span>} />
                <Toggle checked={s.enabled} onChange={(enabled) => void call('subs.update', { id: s.id, patch: { enabled } })} label={<span className="small">Active</span>} />
                <button
                  className="icon-btn"
                  title={`Show downloads (${count})`}
                  onClick={() => {
                    setState({ subsFilter: s.id, page: 'downloads' });
                    if (s.newCount) void call('subs.update', { id: s.id, patch: { newCount: 0 } });
                  }}
                >
                  <ListVideo size={17} />
                </button>
                <button className="icon-btn" title="Check now" onClick={() => void call('subs.check', { id: s.id }).then(() => toast('info', `Checked ${s.title}`))}>
                  <RefreshCw size={17} />
                </button>
                <button className="icon-btn" title="Download settings" onClick={() => setEditing(s)}>
                  <Settings2 size={17} />
                </button>
                <button className="icon-btn" title="Open channel page" onClick={() => void call('app.openExternal', { url: s.url })}>
                  <ExternalLink size={17} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Unsubscribe"
                  onClick={() => {
                    if (window.confirm(`Unsubscribe from ${s.title}? Videos you already downloaded stay on your disk.`)) void call('subs.remove', { id: s.id });
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })
        )}
      </div>
      {editing && <EditSubDialog sub={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditSubDialog(props: { sub: Subscription; onClose: () => void }) {
  const dir = useStore((s) => s.app!.settings.downloadDir);
  const [opts, setOpts] = useState<DownloadOptions>(props.sub.options);
  return (
    <Modal
      title={`Settings for ${props.sub.title}`}
      onClose={props.onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const r = await call('subs.update', { id: props.sub.id, patch: { options: opts } });
              if (r) props.onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <DownloadOptionsForm value={opts} onChange={setOpts} defaultDir={dir} />
    </Modal>
  );
}
