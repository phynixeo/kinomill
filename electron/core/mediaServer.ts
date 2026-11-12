// Small HTTP server on 127.0.0.1 that streams local media files (with Range
// support, so <video> can seek), renders preview frames with ffmpeg, and makes
// live preview streams for formats the built-in player can't decode.
// Every URL carries a random secret token, so other local pages cannot use it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Engines } from './engines';
import { killTree, runBuffer } from './util';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.weba': 'audio/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
};

export class MediaServer {
  private server?: http.Server;
  private token = randomBytes(16).toString('hex');
  private port = 0;
  private frameCache = new Map<string, Buffer>();
  private liveProcs = new Set<ChildProcess>();

  constructor(private engines: Engines) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e?.message ?? e));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  stop(): void {
    for (const p of this.liveProcs) killTree(p);
    this.liveProcs.clear();
    this.server?.close();
  }

  /** Base URL including the secret, e.g. http://127.0.0.1:51234/t/abcd… */
  get base(): string {
    return `http://127.0.0.1:${this.port}/t/${this.token}`;
  }

  mediaUrl(p: string): string {
    return `${this.base}/media?path=${encodeURIComponent(p)}`;
  }

  frameUrl(p: string, t: number, w = 320): string {
    return `${this.base}/frame?path=${encodeURIComponent(p)}&t=${t.toFixed(3)}&w=${w}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = `/t/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(403).end();
      return;
    }
    const route = url.pathname.slice(prefix.length);
    const p = url.searchParams.get('path') ?? '';
    // DVD titles are probed into an ffmpeg "concat:A.VOB|B.VOB" input; allow those for frames and live previews
    if (!p || (!path.isAbsolute(p) && !((route === 'frame' || route === 'live') && p.startsWith('concat:')))) {
      res.writeHead(400).end('bad path');
      return;
    }
    if (route === 'media') return this.serveFile(p, req, res);
    if (route === 'live') return this.live(p, url, req, res);
    if (route === 'frame') {
      const t = Number(url.searchParams.get('t') ?? 0);
      const w = Math.min(1920, Math.max(32, Number(url.searchParams.get('w') ?? 320)));
      const jpg = await this.frame(p, t, w);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600', 'Content-Length': jpg.length });
      res.end(jpg);
      return;
    }
    res.writeHead(404).end();
  }

  /**
   * Converts the file on the fly, from `start` seconds, into a light fragmented MP4
   * (H.264 ≤720p + AAC stereo) that any <video>/<audio> element can play. The ffmpeg
   * process is killed as soon as the player disconnects (pause, seek, close).
   */
  private live(p: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    const ffmpeg = this.engines.require('ffmpeg');
    const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
    const audio = Math.trunc(Number(url.searchParams.get('audio') ?? 0));
    const audioOnly = url.searchParams.get('kind') === 'audio';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', start.toFixed(3), '-i', p, '-map_metadata', '-1', '-sn', '-dn'];
    if (!audioOnly) {
      args.push(
        '-map', '0:v:0',
        '-vf', "scale=-2:'min(720,trunc(ih/2)*2)':flags=fast_bilinear,format=yuv420p",
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-g', '30',
      );
    }
    if (audio >= 0) args.push('-map', `0:a:${audio}?`, '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
    args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', 'pipe:1');

    const child = spawn(ffmpeg, args, { windowsHide: true });
    this.liveProcs.add(child);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    res.writeHead(200, { 'Content-Type': audioOnly ? 'audio/mp4' : 'video/mp4', 'Cache-Control': 'no-store' });
    child.stdout.pipe(res);
    const stop = () => {
      if (this.liveProcs.delete(child)) killTree(child);
    };
    req.on('close', stop);
    res.on('close', stop);
    child.on('error', () => res.end());
    child.on('close', (code) => {
      this.liveProcs.delete(child);
      if (code && stderr) console.error('[live preview]', stderr.trim().split(/\r?\n/).slice(-2).join(' '));
    });
  }

  private serveFile(p: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m?.[1] ? Number(m[1]) : 0;
      let end = m?.[2] ? Number(m[2]) : stat.size - 1;
      if (!m?.[1] && m?.[2]) {
        // suffix range: last N bytes
        start = Math.max(0, stat.size - Number(m[2]));
        end = stat.size - 1;
      }
      if (start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(p).pipe(res);
    }
  }

  /** Render one JPEG frame at time t (seconds), scaled to width w. Cached. */
  async frame(p: string, t: number, w: number): Promise<Buffer> {
    const key = `${p}|${t.toFixed(2)}|${w}`;
    const hit = this.frameCache.get(key);
    if (hit) return hit;
    const ffmpeg = this.engines.require('ffmpeg');
    const isImage = !p.startsWith('concat:') && /\.(jpe?g|png|bmp|webp|gif|tiff?)$/i.test(p);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(isImage ? [] : ['-ss', String(Math.max(0, t))]),
      '-i', p,
      '-frames:v', '1',
      '-vf', `scale=${w}:-2:flags=bilinear`,
      '-q:v', '4',
      '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ];
    let buf: Buffer;
    try {
      buf = await runBuffer(ffmpeg, args, 30000);
    } catch (e) {
      // seeking past the last keyframe near the end can produce nothing; retry slightly earlier
      if (!isImage && t > 1) buf = await runBuffer(ffmpeg, args.map((x, i) => (i === 4 ? String(Math.max(0, t - 1)) : x)), 30000);
      else throw e;
    }
    if (this.frameCache.size > 400) this.frameCache.clear();
    this.frameCache.set(key, buf);
    return buf;
  }
}
