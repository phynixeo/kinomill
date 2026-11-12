import { useEffect, useMemo, useState } from 'react';
import {
  AudioWaveform, Clapperboard, Download, Play, Images, ListChecks, Lock, Moon, Rss, Settings as SettingsIcon, Sun, Unlock, Wand2,
} from 'lucide-react';
import { go, setClipboardHandler, startStore, toast, useStore, call, type Page } from './lib/store';
import { setTitleBar } from './lib/api';
import { pasteLink, startUrls } from './lib/actions';
import { Toasts, Progress } from './components/ui';
import { DownloadDialogs } from './components/DownloadDialogs';
import { DownloadsPage } from './pages/Downloads';
import { SubscriptionsPage } from './pages/Subscriptions';
import { ConverterPage } from './pages/Converter';
import { SlideshowPage } from './pages/Slideshow';
import { AudioToolsPage } from './pages/AudioTools';
import { TasksPage } from './pages/Tasks';
import { SettingsPage } from './pages/Settings';
import { PrivacyDialog } from './components/PrivacyDialog';

export function App() {
  useEffect(() => startStore(), []);
  const app = useStore((s) => s.app);
  const loadError = useStore((s) => s.loadError);
  useTheme(app?.settings.theme ?? 'system');

  useEffect(() => {
    setClipboardHandler((url) => {
      toast('info', `Link copied:\n${url.length > 80 ? url.slice(0, 77) + '…' : url}`, {
        action: { label: 'Download it', run: () => void startUrls([url]) },
        ms: 9000,
      });
    });
  }, []);

  if (!app) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        {loadError ? (
          <>
            <h2>Kinomill could not start</h2>
            <p className="selectable">{loadError}</p>
          </>
        ) : (
          <div className="spinner lg" />
        )}
      </div>
    );
  }
  return <Shell />;
}

function useTheme(theme: 'system' | 'light' | 'dark') {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    setTitleBar(dark ? '#121418' : '#f4f5f7', dark ? '#e7e9ee' : '#1c2026');
  }, [dark]);
  return dark;
}

const NAV: { section: string; items: { id: Page; label: string; icon: typeof Download }[] }[] = [
  {
    section: 'Download',
    items: [
      { id: 'downloads', label: 'Downloads', icon: Download },
      { id: 'subscriptions', label: 'Subscriptions', icon: Rss },
    ],
  },
  {
    section: 'Convert & edit',
    items: [
      { id: 'converter', label: 'Converter', icon: Clapperboard },
      { id: 'slideshow', label: 'Photo slideshow', icon: Images },
      { id: 'audio', label: 'Audio tools', icon: AudioWaveform },
    ],
  },
  {
    section: 'App',
    items: [
      { id: 'tasks', label: 'Tasks', icon: ListChecks },
      { id: 'settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

function Shell() {
  const page = useStore((s) => s.page);
  const app = useStore((s) => s.app)!;
  const convCount = useStore((s) => s.conv.length);
  const audioCount = useStore((s) => s.audioFiles.length);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const dark = document.documentElement.dataset.theme === 'dark';

  const activeDownloads = useMemo(() => app.downloads.filter((d) => d.status === 'downloading' || d.status === 'processing' || d.status === 'queued').length, [app.downloads]);
  const runningJobs = useMemo(() => app.jobs.filter((j) => j.status === 'running' || j.status === 'queued'), [app.jobs]);
  const newSubs = useMemo(() => app.subscriptions.reduce((n, s) => n + s.newCount, 0), [app.subscriptions]);

  const counts: Partial<Record<Page, { n: number; hot?: boolean }>> = {
    downloads: activeDownloads ? { n: activeDownloads, hot: true } : undefined,
    subscriptions: newSubs ? { n: newSubs, hot: true } : undefined,
    converter: convCount ? { n: convCount } : undefined,
    audio: audioCount ? { n: audioCount } : undefined,
    tasks: runningJobs.length ? { n: runningJobs.length, hot: true } : undefined,
  };

  // Ctrl+V anywhere on the Downloads page (outside text fields) = Paste Link
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && (page === 'downloads' || page === 'subscriptions')) {
        e.preventDefault();
        void pasteLink();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page]);

  const missing = app.engines.filter((e) => e.required && !e.installed);
  const installing = app.engines.filter((e) => e.busy);

  const downloading = app.downloads.filter((d) => d.status === 'downloading');
  const totalSpeed = downloading.reduce((n, d) => n + (d.speed ?? 0), 0);
  const jobProgress = runningJobs.length ? runningJobs.reduce((n, j) => n + j.progress, 0) / runningJobs.length : 0;

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <span className="logo">
            <Play size={11} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
          </span>
          Kinomill
          <span className="byline">by phynixeo</span>
        </div>
        <div className="spacer" />
        {app.privacy.hasPassword && (
          <button className="icon-btn no-drag" title={app.privacy.unlocked ? 'Private downloads are visible — click to lock' : 'Private downloads are hidden — click to unlock'} onClick={() => (app.privacy.unlocked ? void call('privacy.lock') : setPrivacyOpen(true))}>
            {app.privacy.unlocked ? <Unlock size={17} /> : <Lock size={17} />}
          </button>
        )}
        <button className="icon-btn no-drag" title={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => void call('settings.update', { theme: dark ? 'light' : 'dark' })}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </header>

      <nav className="sidebar" aria-label="Main">
        {NAV.map((sec) => (
          <div key={sec.section} className="col" style={{ gap: 2 }}>
            <div className="nav-section">{sec.section}</div>
            {sec.items.map((it) => {
              const Icon = it.icon;
              const c = counts[it.id];
              return (
                <button key={it.id} className={`nav-item ${page === it.id ? 'active' : ''}`} onClick={() => go(it.id)} aria-current={page === it.id ? 'page' : undefined}>
                  <Icon size={18} />
                  {it.label}
                  {c && <span className={`count ${c.hot ? 'hot' : ''}`}>{c.n}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <div className="spacer" />
        {app.settings.smartMode && (
          <button className="nav-item" onClick={() => go('downloads')} title="Smart Mode is on: links download immediately with your saved settings">
            <Wand2 size={18} style={{ color: 'var(--accent)' }} /> Smart Mode on
          </button>
        )}
      </nav>

      <main className="main">
        {(missing.length > 0 || installing.length > 0) && (
          <div className="notice" style={{ margin: '12px 22px 0', borderRadius: 10 }}>
            <div className="spinner" />
            <div className="grow">
              <b>Setting up components</b> — {installing.length ? installing.map((e) => `${e.label} ${Math.round((e.progress ?? 0) * 100)}%`).join(', ') : `waiting for ${missing.map((e) => e.label).join(', ')}`}
              {missing.some((m) => m.error) && <div className="small" style={{ color: 'var(--danger)' }}>{missing.find((m) => m.error)?.error}</div>}
            </div>
            <button className="btn sm" onClick={() => go('settings')}>
              Details
            </button>
          </div>
        )}
        {page === 'downloads' && <DownloadsPage />}
        {page === 'subscriptions' && <SubscriptionsPage />}
        {page === 'converter' && <ConverterPage />}
        {page === 'slideshow' && <SlideshowPage />}
        {page === 'audio' && <AudioToolsPage />}
        {page === 'tasks' && <TasksPage />}
        {page === 'settings' && <SettingsPage />}
      </main>

      <footer className="statusbar">
        <button onClick={() => go('downloads')}>
          <Download size={13} />
          {downloading.length ? `${downloading.length} downloading · ${formatRate(totalSpeed)}` : activeDownloads ? `${activeDownloads} queued` : 'No active downloads'}
        </button>
        <button onClick={() => go('tasks')} style={{ minWidth: 0 }}>
          <ListChecks size={13} />
          {runningJobs.length ? (
            <>
              {runningJobs.length} task{runningJobs.length > 1 ? 's' : ''} · {Math.round(jobProgress * 100)}%
              <Progress value={jobProgress} style={{ width: 80 }} />
            </>
          ) : (
            'No running tasks'
          )}
        </button>
        <div className="spacer" />
        {app.settings.speedLimitKBps > 0 && <span>Speed limit {app.settings.speedLimitKBps >= 1024 ? `${(app.settings.speedLimitKBps / 1024).toFixed(1)} MB/s` : `${app.settings.speedLimitKBps} KB/s`}</span>}
        {app.settings.proxyEnabled && <span>Proxy on</span>}
        {app.settings.afterQueue !== 'nothing' && <span style={{ color: 'var(--warning)' }}>{app.settings.afterQueue === 'shutdown' ? 'Shut down' : 'Sleep'} when done</span>}
        {app.capabilities.hwEncoders.length > 0 && <span title={app.capabilities.hwEncoders.join(', ')}>GPU acceleration ready</span>}
      </footer>

      <DownloadDialogs />
      {privacyOpen && <PrivacyDialog mode="unlock" onClose={() => setPrivacyOpen(false)} />}
      <Toasts />
    </div>
  );
}

function formatRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
