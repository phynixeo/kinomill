import { useState, type ReactNode } from 'react';
import { CheckCircle2, Cpu, Download, Globe, KeyRound, Lock, LogIn, LogOut, Package, RefreshCw, Settings2, Shield, Wand2, XCircle } from 'lucide-react';
import type { Settings } from '../../shared/types';
import { call, toast, useStore } from '../lib/store';
import { openDl } from '../lib/actions';
import { isDesktop } from '../lib/api';
import { Field, FolderField, NumberInput, Progress, Select, Toggle } from '../components/ui';
import { PrivacyDialog } from '../components/PrivacyDialog';

const YT_SIGN_IN = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F';

type Tab = 'general' | 'downloads' | 'accounts' | 'conversion' | 'privacy' | 'components';
const TABS: { id: Tab; label: string; icon: typeof Download }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'accounts', label: 'Accounts & network', icon: Globe },
  { id: 'conversion', label: 'Conversion', icon: Cpu },
  { id: 'privacy', label: 'Private mode', icon: Shield },
  { id: 'components', label: 'Components', icon: Package },
];

function Row(props: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="text">
        <div className="title">{props.title}</div>
        {props.desc && <div className="desc">{props.desc}</div>}
      </div>
      {props.children}
    </div>
  );
}

export function SettingsPage() {
  const app = useStore((s) => s.app)!;
  const s = app.settings;
  const [tab, setTab] = useState<Tab>('general');
  const [pwOpen, setPwOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const up = (patch: Partial<Settings>) => void call('settings.update', patch);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherUrl, setOtherUrl] = useState('');
  const signIn = async (url: string) => {
    const r = await call('auth.signIn', { url });
    if (!r) return;
    if (url === YT_SIGN_IN) {
      if (r.youtube) toast('success', 'Signed in to YouTube. Private and age-restricted videos can now be downloaded.');
      else toast('warning', 'No YouTube login was found. Sign in to your Google account in the window that opens, then click Done.');
    } else if (r.signedIn) toast('success', 'Login saved.');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>
      <div className="page-body" style={{ paddingTop: 10, maxWidth: 920 }}>
        {tab === 'general' && (
          <>
            <Row title="Theme">
              <Select
                value={s.theme}
                options={[
                  { value: 'system', label: 'Same as Windows' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(theme) => up({ theme })}
              />
            </Row>
            <Row title="Download folder" desc="Where downloaded videos and music are saved">
              <div style={{ width: 420 }}>
                <FolderField value={s.downloadDir} onChange={(downloadDir) => up({ downloadDir })} />
              </div>
            </Row>
            <Row title="Converted files folder" desc="Default folder for conversions, slideshows, discs and audio tools">
              <div style={{ width: 420 }}>
                <FolderField value={s.convertDir} onChange={(convertDir) => up({ convertDir })} />
              </div>
            </Row>
            <Row title="Notifications" desc="Show a Windows notification when a download or conversion finishes">
              <Toggle checked={s.notifyOnComplete} onChange={(notifyOnComplete) => up({ notifyOnComplete })} />
            </Row>
            <Row title="Sound when finished">
              <Toggle checked={s.playSoundOnComplete} onChange={(playSoundOnComplete) => up({ playSoundOnComplete })} />
            </Row>
            <Row title="Watch the clipboard" desc="When you copy a video link anywhere, offer to download it">
              <Toggle checked={s.monitorClipboard} onChange={(monitorClipboard) => up({ monitorClipboard })} disabled={!isDesktop} />
            </Row>
            <Row title="Keep the PC awake" desc="Prevent sleep while downloading or converting">
              <Toggle checked={s.preventSleep} onChange={(preventSleep) => up({ preventSleep })} />
            </Row>
            <Row title="When everything is done" desc="Runs after all downloads and conversions have finished (with a 60 second warning)">
              <Select
                value={s.afterQueue}
                options={[
                  { value: 'nothing', label: 'Do nothing' },
                  { value: 'sleep', label: 'Put the PC to sleep' },
                  { value: 'shutdown', label: 'Shut down the PC' },
                ]}
                onChange={(afterQueue) => up({ afterQueue })}
              />
            </Row>
          </>
        )}

        {tab === 'downloads' && (
          <>
            <Row title={<span className="row gap-4"><Wand2 size={15} /> Smart Mode</span>} desc={s.smartMode ? 'On — pasted links download at once with your saved settings' : 'Off — you choose quality and format for each link'}>
              <button className="btn" onClick={() => openDl({ kind: 'smart' })}>
                Configure…
              </button>
            </Row>
            <Row title="Simultaneous downloads">
              <Select value={s.maxConcurrentDownloads} options={[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: n, label: String(n) }))} onChange={(maxConcurrentDownloads) => up({ maxConcurrentDownloads })} />
            </Row>
            <Row title="Download speed limit" desc="0 = unlimited">
              <NumberInput value={s.speedLimitKBps} min={0} max={10_000_000} suffix="KB/s" onChange={(n) => up({ speedLimitKBps: n ?? 0 })} style={{ width: 170 }} />
            </Row>
            <Row title="File name" desc={<>Template using yt-dlp fields, e.g. <code>%(title)s</code>, <code>%(uploader)s - %(title)s</code>, <code>%(upload_date)s %(title)s</code></>}>
              <input className="input mono" style={{ width: 300 }} value={s.filenameTemplate} onChange={(e) => up({ filenameTemplate: e.target.value || '%(title)s' })} />
            </Row>
            <Row title="Create a subfolder for each playlist / channel">
              <Toggle checked={s.playlistSubfolder} onChange={(playlistSubfolder) => up({ playlistSubfolder })} />
            </Row>
            <Row title="Number playlist files" desc='Adds "01 - ", "02 - " … in playlist order'>
              <Toggle checked={s.numberPlaylistItems} onChange={(numberPlaylistItems) => up({ numberPlaylistItems })} />
            </Row>
            <Row title="Skip videos already downloaded" desc="Remembers every video ever downloaded and never downloads it twice">
              <Toggle checked={s.skipDuplicates} onChange={(skipDuplicates) => up({ skipDuplicates })} />
            </Row>
            <Row title="Embed thumbnail as cover art">
              <Toggle checked={s.embedThumbnail} onChange={(embedThumbnail) => up({ embedThumbnail })} />
            </Row>
            <Row title="Embed title, artist and description">
              <Toggle checked={s.embedMetadata} onChange={(embedMetadata) => up({ embedMetadata })} />
            </Row>
            <Row title="Embed chapters">
              <Toggle checked={s.embedChapters} onChange={(embedChapters) => up({ embedChapters })} />
            </Row>
            <Row title="Skip sponsor segments" desc="Cuts out sponsor reads in YouTube videos using the community SponsorBlock database">
              <Toggle checked={s.sponsorBlockRemove} onChange={(sponsorBlockRemove) => up({ sponsorBlockRemove })} />
            </Row>
            <Row title="Retries on network errors">
              <Select value={s.retries} options={[0, 1, 3, 5, 10, 20].map((n) => ({ value: n, label: String(n) }))} onChange={(retries) => up({ retries })} />
            </Row>
          </>
        )}

        {tab === 'accounts' && (
          <>
            <div className="card flat col" style={{ marginBottom: 14 }}>
              <h3>Sign in for private, age-restricted and members-only videos</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Sign in to YouTube (or another site) in your own browser — Kinomill opens Chrome, Edge or Brave with a separate, private profile, so your everyday browser is not touched. Kinomill keeps the login cookies on this PC only and uses them when downloading. You can also borrow the login from a browser instead.
              </p>
              {app.auth.pending ? (
                <div className="sign-in-wait">
                  <RefreshCw size={17} className="spin" />
                  <div className="grow small">
                    <b>Finish signing in, in {app.auth.pending}.</b>
                    <br />
                    <span className="muted">When the site shows you are signed in, click Done (or just close that browser window).</span>
                  </div>
                  <button className="btn primary" onClick={() => void call('auth.finishSignIn', { save: true })}>
                    <CheckCircle2 size={15} /> Done
                  </button>
                  <button className="btn" onClick={() => void call('auth.finishSignIn', { save: false })}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="row wrap">
                  {app.auth.signedIn ? (
                    <>
                      <CheckCircle2 size={17} style={{ color: 'var(--success)' }} />
                      <span className="grow small">
                        {app.auth.youtube ? 'Signed in to YouTube' : 'Signed in'} ({app.auth.sites.slice(0, 4).join(', ')}
                        {app.auth.sites.length > 4 ? '…' : ''})
                      </span>
                      {!app.auth.youtube && (
                        <button className="btn" onClick={() => void signIn(YT_SIGN_IN)} disabled={!isDesktop}>
                          <LogIn size={15} /> Sign in to YouTube
                        </button>
                      )}
                      <button className="btn" onClick={() => setOtherOpen((v) => !v)} disabled={!isDesktop}>
                        <LogIn size={15} /> Sign in to another site
                      </button>
                      <button className="btn danger" onClick={() => void call('auth.signOut')}>
                        <LogOut size={15} /> Sign out
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn primary" disabled={!isDesktop} onClick={() => void signIn(YT_SIGN_IN)}>
                        <LogIn size={15} /> Sign in to YouTube
                      </button>
                      <button className="btn" disabled={!isDesktop} onClick={() => setOtherOpen((v) => !v)}>
                        Other site…
                      </button>
                    </>
                  )}
                </div>
              )}
              {otherOpen && !app.auth.pending && (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const url = /^https?:\/\//i.test(otherUrl.trim()) ? otherUrl.trim() : `https://${otherUrl.trim()}`;
                    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(url)) return toast('warning', 'Type the address of the site, for example vimeo.com');
                    setOtherOpen(false);
                    void signIn(url);
                  }}
                >
                  <input className="input grow" autoFocus placeholder="Site address, e.g. vimeo.com" value={otherUrl} onChange={(e) => setOtherUrl(e.target.value)} />
                  <button className="btn primary" type="submit">
                    Open
                  </button>
                </form>
              )}
            </div>
            <Row title="Login source for downloads">
              <Select
                value={s.cookiesMode}
                options={[
                  { value: 'none', label: 'Not signed in' },
                  { value: 'app', label: 'Kinomill sign-in (above)' },
                  { value: 'browser', label: 'Use my browser\'s login' },
                  { value: 'file', label: 'cookies.txt file' },
                ]}
                onChange={(cookiesMode) => up({ cookiesMode })}
              />
            </Row>
            {s.cookiesMode === 'browser' && (
              <Row title="Browser" desc="Firefox works best. Chrome and Edge must be closed while downloading.">
                <Select
                  value={s.cookiesBrowser}
                  options={['firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'].map((b) => ({ value: b as Settings['cookiesBrowser'], label: b[0].toUpperCase() + b.slice(1) }))}
                  onChange={(cookiesBrowser) => up({ cookiesBrowser })}
                />
              </Row>
            )}
            {s.cookiesMode === 'file' && (
              <Row title="cookies.txt file" desc="Netscape-format cookie file exported from a browser extension">
                <div className="row" style={{ width: 420 }}>
                  <input className="input grow" value={s.cookiesFile} onChange={(e) => up({ cookiesFile: e.target.value })} />
                  <button className="btn" onClick={async () => {
                    const f = await call('app.pickFiles', { title: 'Choose cookies.txt', filters: [{ name: 'Cookies', extensions: ['txt'] }] });
                    if (f?.[0]) up({ cookiesFile: f[0] });
                  }}>
                    Browse…
                  </button>
                </div>
              </Row>
            )}
            <Row title="Use a proxy" desc="For downloading through a proxy server or VPN gateway">
              <Toggle checked={s.proxyEnabled} onChange={(proxyEnabled) => up({ proxyEnabled })} />
            </Row>
            {s.proxyEnabled && (
              <Row title="Proxy address" desc="http://host:port, socks5://host:port, or with login: http://user:password@host:port">
                <input className="input mono" style={{ width: 340 }} value={s.proxyUrl} placeholder="socks5://127.0.0.1:1080" onChange={(e) => up({ proxyUrl: e.target.value })} />
              </Row>
            )}
          </>
        )}

        {tab === 'conversion' && (
          <>
            <Row title="Hardware acceleration" desc={app.capabilities.hwEncoders.length ? `Available on this PC: ${app.capabilities.hwEncoders.join(', ')}` : 'No supported GPU encoder was found'}>
              <Select
                value={s.hwAccel}
                options={[
                  { value: 'auto', label: 'Automatic (recommended)' },
                  { value: 'nvenc', label: 'NVIDIA NVENC', disabled: !app.capabilities.hwEncoders.some((e) => e.includes('nvenc')) },
                  { value: 'qsv', label: 'Intel Quick Sync', disabled: !app.capabilities.hwEncoders.some((e) => e.includes('qsv')) },
                  { value: 'amf', label: 'AMD AMF', disabled: !app.capabilities.hwEncoders.some((e) => e.includes('amf')) },
                  { value: 'none', label: 'Off (CPU only)' },
                ]}
                onChange={(hwAccel) => up({ hwAccel })}
              />
            </Row>
            <Row title="Simultaneous conversions" desc="More than one only helps on CPUs with many cores">
              <Select value={s.maxConcurrentConversions} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} onChange={(maxConcurrentConversions) => up({ maxConcurrentConversions })} />
            </Row>
          </>
        )}

        {tab === 'privacy' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Private mode hides chosen downloads from the list behind a password — handy on a shared PC. The files themselves stay in your download folder.
            </p>
            <Row title="Private mode" desc="New downloads are marked private while this is on">
              <Toggle checked={s.privateMode} onChange={(privateMode) => {
                if (privateMode && !app.privacy.hasPassword) setPwOpen(true);
                up({ privateMode });
              }} />
            </Row>
            <Row title="Password" desc={app.privacy.hasPassword ? 'A password is set' : 'No password yet — private downloads are visible to everyone'}>
              <div className="row">
                <button className="btn" onClick={() => setPwOpen(true)}>
                  <KeyRound size={15} /> {app.privacy.hasPassword ? 'Change password' : 'Set password'}
                </button>
                {app.privacy.hasPassword && app.privacy.unlocked && (
                  <button className="btn" onClick={() => void call('privacy.lock')}>
                    <Lock size={15} /> Lock now
                  </button>
                )}
              </div>
            </Row>
          </>
        )}

        {tab === 'components' && (
          <>
            <div className="row" style={{ marginBottom: 6 }}>
              <p className="muted grow" style={{ margin: 0 }}>
                Kinomill uses these open-source engines. They are downloaded from their official websites and can be updated here — keep yt-dlp up to date if a site stops working.
              </p>
              <button className="btn" disabled={checking} onClick={async () => {
                setChecking(true);
                const r = await call('engines.checkUpdates');
                setChecking(false);
                if (r && !r.some((e) => e.updateAvailable)) toast('success', 'Everything is up to date.');
              }}>
                <RefreshCw size={15} /> Check for updates
              </button>
            </div>
            {app.engines.map((e) => (
              <div key={e.name} className="setting-row">
                {e.installed ? <CheckCircle2 size={18} style={{ color: 'var(--success)' }} /> : <XCircle size={18} style={{ color: e.required ? 'var(--danger)' : 'var(--text-3)' }} />}
                <div className="text">
                  <div className="title">
                    {e.label} {e.version && <span className="muted small">{e.version}</span>} {e.updateAvailable && <span className="badge accent">Update {e.updateAvailable}</span>}
                  </div>
                  <div className="desc">{e.description}{e.source === 'system' ? ' · using the copy installed on this PC' : ''}</div>
                  {e.error && <div className="desc" style={{ color: 'var(--danger)' }}>{e.error}</div>}
                  {e.busy && <Progress value={e.progress ?? 0} style={{ marginTop: 6, maxWidth: 300 }} />}
                </div>
                <button className="btn" disabled={e.busy} onClick={() => void call('engines.install', { name: e.name })}>
                  {e.busy ? 'Installing…' : e.installed ? (e.updateAvailable ? 'Update' : 'Reinstall') : 'Install'}
                </button>
              </div>
            ))}
            <div className="setting-row">
              <Package size={18} style={{ color: app.capabilities.aiAudioAvailable ? 'var(--success)' : 'var(--text-3)' }} />
              <div className="text">
                <div className="title">AI audio separation pack</div>
                <div className="desc">Demucs + PyTorch, for vocal isolation and karaoke tracks (about 2–3 GB)</div>
              </div>
              <button className="btn" disabled={app.capabilities.aiAudioAvailable || app.capabilities.aiAudioInstalling} onClick={() => void call('audio.installAi')}>
                {app.capabilities.aiAudioAvailable ? 'Installed' : app.capabilities.aiAudioInstalling ? 'Installing…' : 'Install'}
              </button>
            </div>
            <p className="faint small" style={{ marginTop: 20 }}>
              Kinomill by phynixeo · version {app.capabilities.appVersion}. Download only content you have the right to download.
            </p>
          </>
        )}
      </div>
      {pwOpen && <PrivacyDialog mode="set" hasPassword={app.privacy.hasPassword} onClose={() => setPwOpen(false)} />}
    </div>
  );
}
