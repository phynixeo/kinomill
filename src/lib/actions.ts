import { invoke } from './api';
import { extractUrls } from './format';
import { call, getState, setState, toast } from './store';

export type DlTarget = 'converter' | 'audio' | undefined;

export type DlDialog =
  | { kind: 'enter'; target?: DlTarget; purpose?: 'channel' | 'playlist' }
  | { kind: 'analyze'; url: string; target?: DlTarget; flat?: boolean }
  | { kind: 'batch'; urls: string[]; target?: DlTarget }
  | { kind: 'smart' }
  | { kind: 'search' }
  | { kind: 'subscribe'; url?: string };

export function openDl(d: DlDialog | undefined): void {
  setState({ dlDialog: d });
}

/** "Paste Link": read the clipboard and start the right flow. */
export async function pasteLink(target?: DlTarget): Promise<void> {
  let text = '';
  try {
    text = await invoke('app.readClipboard');
  } catch {
    /* ignore */
  }
  const urls = extractUrls(text);
  if (!urls.length) {
    openDl({ kind: 'enter', target });
    return;
  }
  await startUrls(urls, target);
}

export async function startUrls(urls: string[], target?: DlTarget): Promise<void> {
  const app = getState().app;
  if (!app) return;
  if (app.settings.smartMode && !target) {
    const items = await call('downloads.smart', { urls });
    if (items) toast('success', items.length === 1 ? `Downloading "${items[0].title}"` : `Added ${items.length} downloads (Smart Mode)`);
    setState({ page: 'downloads' });
    return;
  }
  if (urls.length === 1) openDl({ kind: 'analyze', url: urls[0], target });
  else openDl({ kind: 'batch', urls, target });
}

export function trackForTarget(ids: string[], target: DlTarget): void {
  if (target === 'converter') setState((s) => ({ toConverter: [...s.toConverter, ...ids] }));
  if (target === 'audio') setState((s) => ({ toAudio: [...s.toAudio, ...ids] }));
}
