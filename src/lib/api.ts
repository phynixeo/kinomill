// Talks to the backend: Electron IPC bridge when running as the desktop app,
// or a WebSocket to the dev server when the UI runs in a normal browser.
import type { ApiArgs, ApiMethod, ApiResult, AppEvent } from '../../shared/types';

interface Bridge {
  invoke(method: string, args: unknown): Promise<unknown>;
  onEvent(cb: (ev: AppEvent) => void): () => void;
  pathForFile(file: File): string;
  setTitleBar(opts: { color: string; symbolColor: string }): void;
}

declare global {
  interface Window {
    vf?: Bridge;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class SocketTransport {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: string[] = [];
  private listeners = new Set<(ev: AppEvent) => void>();
  private reconnectListeners = new Set<() => void>();
  private everConnected = false;

  constructor() {
    this.connect();
  }

  private connect(): void {
    const token = document.querySelector('meta[name="vf-token"]')?.getAttribute('content') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.everConnected) for (const l of this.reconnectListeners) l();
      this.everConnected = true;
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.event) {
        for (const l of this.listeners) l(msg.event as AppEvent);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('Connection to Kinomill lost'));
      this.pending.clear();
      setTimeout(() => this.connect(), 1000);
    };
  }

  invoke(method: string, args: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      else this.queue.push(msg);
    });
  }

  onEvent(cb: (ev: AppEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }
}

const bridge = window.vf;
const socket = bridge ? undefined : new SocketTransport();

export const isDesktop = !!bridge;

export function invoke<M extends ApiMethod>(method: M, ...args: ApiArgs<M> extends void ? [] : [ApiArgs<M>]): Promise<ApiResult<M>> {
  const a = args[0];
  return (bridge ? bridge.invoke(method, a) : socket!.invoke(method, a)) as Promise<ApiResult<M>>;
}

export function onEvent(cb: (ev: AppEvent) => void): () => void {
  return bridge ? bridge.onEvent(cb) : socket!.onEvent(cb);
}

/** Called after the dev-server connection comes back (state must be reloaded). */
export function onReconnect(cb: () => void): () => void {
  return socket ? socket.onReconnect(cb) : () => undefined;
}

export function pathForFile(file: File): string {
  return bridge?.pathForFile(file) ?? '';
}

export function setTitleBar(color: string, symbolColor: string): void {
  bridge?.setTitleBar({ color, symbolColor });
}
