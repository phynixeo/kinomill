import { useMemo } from 'react';
import { AlertCircle, AudioWaveform, CheckCircle2, Clapperboard, Clock, Disc3, FolderOpen, Images, ListChecks, Play, RotateCcw, Trash2, X } from 'lucide-react';
import type { ConvertJob } from '../../shared/types';
import { call, useStore } from '../lib/store';
import { basename, formatEta, timeAgo } from '../lib/format';
import { Empty, Progress } from '../components/ui';

const KIND_ICON = { convert: Clapperboard, slideshow: Images, disc: Disc3, audio: AudioWaveform } as const;

export function TasksPage() {
  const jobs = useStore((s) => s.app!.jobs);
  const sorted = useMemo(() => {
    const order = { running: 0, queued: 1, failed: 2, canceled: 3, completed: 4 } as const;
    return [...jobs].sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
  }, [jobs]);
  const finished = jobs.filter((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'canceled').length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Tasks</h1>
        <span className="muted small">Conversions, slideshows, discs and audio processing</span>
        <div className="spacer" />
        {finished > 0 && (
          <button className="btn ghost" onClick={() => void call('convert.clearCompleted')}>
            <CheckCircle2 size={16} /> Clear finished
          </button>
        )}
      </div>
      <div className="page-body">
        {jobs.length === 0 ? (
          <Empty icon={<ListChecks size={38} />} title="No tasks yet">
            <p>When you convert a video, create a slideshow or disc, or process audio, the progress shows up here.</p>
          </Empty>
        ) : (
          <div className="list">
            {sorted.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job: j }: { job: ConvertJob }) {
  const Icon = KIND_ICON[j.kind] ?? Clapperboard;
  const out = j.outputPaths?.[0];
  return (
    <div className="item">
      <div className="thumb sm" style={{ width: 52, height: 52, borderRadius: 12 }}>
        <Icon size={22} />
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title">{j.title}</div>
        {j.status === 'running' || j.status === 'queued' ? (
          <div className="col gap-4" style={{ marginTop: 6 }}>
            <Progress value={j.progress} indeterminate={j.status === 'running' && j.progress === 0} />
            <div className="meta" style={{ marginTop: 0 }}>
              {j.status === 'queued' ? (
                <>
                  <Clock size={12} /> Waiting…
                </>
              ) : (
                <>
                  <span>{j.stage ?? 'Converting'}</span>
                  <span className="dot">{Math.round(j.progress * 100)}%</span>
                  {j.speed && <span className="dot">{j.speed}</span>}
                  {j.eta ? <span className="dot">{formatEta(j.eta)}</span> : null}
                </>
              )}
            </div>
          </div>
        ) : j.status === 'failed' ? (
          <div className="meta" style={{ color: 'var(--danger)', whiteSpace: 'normal', alignItems: 'flex-start' }}>
            <AlertCircle size={13} style={{ flex: 'none', marginTop: 2 }} />
            <span className="selectable" style={{ whiteSpace: 'pre-wrap' }}>{j.error ?? 'Failed'}</span>
          </div>
        ) : j.status === 'canceled' ? (
          <div className="meta">Canceled</div>
        ) : (
          <div className="meta">
            <CheckCircle2 size={13} style={{ color: 'var(--success)' }} />
            <span className="ellipsis">{j.outputPaths?.map(basename).join(', ')}</span>
            <span className="dot">{timeAgo(j.completedAt)}</span>
          </div>
        )}
      </div>
      <div className="actions show">
        {j.status === 'completed' && out && (
          <>
            {j.kind !== 'disc' && (
              <button className="icon-btn" title="Open" onClick={() => void call('app.openPath', { path: out })}>
                <Play size={17} />
              </button>
            )}
            <button className="icon-btn" title="Show in folder" onClick={() => void call('app.showInFolder', { path: out })}>
              <FolderOpen size={17} />
            </button>
          </>
        )}
        {(j.status === 'running' || j.status === 'queued') && (
          <button className="btn sm" onClick={() => void call('convert.cancel', { ids: [j.id] })}>
            <X size={14} /> Cancel
          </button>
        )}
        {(j.status === 'failed' || j.status === 'canceled') && (
          <button className="btn sm" onClick={() => void call('convert.retry', { ids: [j.id] })}>
            <RotateCcw size={14} /> Retry
          </button>
        )}
        {j.status !== 'running' && (
          <button className="icon-btn danger" title="Remove from list" onClick={() => void call('convert.remove', { ids: [j.id] })}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
