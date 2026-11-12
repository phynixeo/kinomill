// Exposes a tiny, typed bridge to the renderer. The renderer never gets Node access.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('vf', {
  async invoke(method: string, args: unknown) {
    const r = (await ipcRenderer.invoke('vf:invoke', method, args)) as { ok: boolean; result?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error ?? 'Unknown error');
    return r.result;
  },
  onEvent(cb: (ev: unknown) => void) {
    const h = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on('vf:event', h);
    return () => {
      ipcRenderer.off('vf:event', h);
    };
  },
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  setTitleBar(opts: { color: string; symbolColor: string }) {
    ipcRenderer.send('vf:titlebar', opts);
  },
});
