// Development/testing server: runs the real Kinomill backend in plain Node and
// serves the built UI (dist/) at http://127.0.0.1:5199 with the API over a
// WebSocket. Lets the whole app be exercised from a normal browser.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { createCore } from './core';
import type { Host } from './core/context';
import { runCapture } from './core/util';

const PORT = Number(process.env.VF_PORT || 5199);
const ROOT = path.resolve(__dirname, '..', 'dist');
const TOKEN = randomBytes(16).toString('hex');
const appDataDir = process.env.APPDATA || path.join(os.homedir(), '.config');
const dataDir = process.env.KINOMILL_DATA || path.join(appDataDir, 'Kinomill');
// Kinomill used to be called VidForge: reuse its data folder once
if (!process.env.KINOMILL_DATA && !fs.existsSync(dataDir) && fs.existsSync(path.join(appDataDir, 'VidForge'))) {
  try {
    fs.renameSync(path.join(appDataDir, 'VidForge'), dataDir);
  } catch {
    /* in use; start fresh */
  }
}

async function psDialog(script: string): Promise<string> {
  const r = await runCapture('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeoutMs: 10 * 60 * 1000 });
  return r.stdout.trim();
}
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

const host: Host = {
  kind: 'server',
  appVersion: '1.0.0-dev',
  dataDir,
  videosDir: path.join(os.homedir(), 'Videos'),
  notify(title, body) {
    console.log(`[notify] ${title}: ${body}`);
  },
  async openPath(p) {
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
  },
  showInFolder(p) {
    spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
  },
  async openExternal(url) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  },
  async readClipboard() {
    return '';
  },
  async pickFolder({ title }) {
    const out = await psDialog(
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${psq(title ?? 'Choose a folder')}; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`,
    );
    return out || null;
  },
  async pickFiles({ title, multi, filters, folders }) {
    if (folders) {
      const f = await host.pickFolder({ title });
      return f ? [f] : [];
    }
    const filter = (filters ?? []).map((f) => `${f.name}|${f.extensions.map((e) => (e === '*' ? '*.*' : '*.' + e)).join(';')}`).join('|') || 'All files|*.*';
    const out = await psDialog(
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = ${psq(title ?? 'Choose files')}; $d.Multiselect = $${multi ? 'true' : 'false'}; $d.Filter = ${psq(filter)}; if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join "\`n" }`,
    );
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  },
  async saveFile({ title, defaultPath }) {
    const out = await psDialog(
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.Title = ${psq(title ?? 'Save')}; $d.FileName = ${psq(defaultPath ?? '')}; if ($d.ShowDialog() -eq 'OK') { $d.FileName }`,
    );
    return out || null;
  },
  preventSleep() {
    /* not in dev server */
  },
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.wav': 'audio/wav',
};

async function main(): Promise<void> {
  const core = await createCore(host);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    let body: Buffer | string = fs.readFileSync(file);
    if (rel === '/index.html') body = body.toString('utf8').replace('<head>', `<head><meta name="vf-token" content="${TOKEN}">`);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const origin = req.headers.origin ?? '';
    const okOrigin = origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN || !okOrigin) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const off = core.onEvent((ev) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: ev }));
    });
    ws.on('close', off);
    ws.on('message', async (raw) => {
      let msg: { id: number; method: string; args: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const result = await core.invoke(msg.method as never, msg.args as never);
        ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Kinomill dev server: http://127.0.0.1:${PORT}  (data: ${dataDir})`);
  });

  const shutdown = async () => {
    await core.dispose().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
