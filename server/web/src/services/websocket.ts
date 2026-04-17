import { useEffect, useRef } from 'react';

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/sessions`;
})();
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 25_000;

export type PipelineWsEvent = {
  sessionId: string;
  eventType: string;
  taskId?: string;
  timestamp: number;
  data?: unknown;
};

function parseEvent(raw: string): PipelineWsEvent | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const sessionId = (o.session_id ?? o.sessionId) as string | undefined;
    const eventType = (o.event_type ?? o.eventType) as string | undefined;
    if (!sessionId || !eventType) return null;
    return {
      sessionId,
      eventType,
      taskId: o.task_id != null ? String(o.task_id) : undefined,
      timestamp: typeof o.timestamp === 'number' ? o.timestamp : 0,
      data: o.data,
    };
  } catch {
    return null;
  }
}

class PipelineWsManager {
  private ws: WebSocket | null = null;
  private refCount = 0;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectT: ReturnType<typeof setTimeout> | null = null;
  private heartbeatT: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(e: PipelineWsEvent) => void>();
  subscribe(fn: (e: PipelineWsEvent) => void): () => void {
    this.listeners.add(fn);
    this.refCount++;
    if (this.refCount === 1) this.open();
    return () => {
      this.listeners.delete(fn);
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) this.shutdown();
    };
  }
  private emit(e: PipelineWsEvent) {
    this.listeners.forEach((f) => f(e));
  }
  private clearReconnect() {
    if (this.reconnectT) {
      clearTimeout(this.reconnectT);
      this.reconnectT = null;
    }
  }
  private clearHeartbeat() {
    if (this.heartbeatT) {
      clearInterval(this.heartbeatT);
      this.heartbeatT = null;
    }
  }
  private scheduleReconnect() {
    if (this.reconnectT || this.refCount === 0) return;
    this.reconnectT = setTimeout(() => {
      this.reconnectT = null;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
  private detachSocket(s: WebSocket) {
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
  }
  private open() {
    this.clearReconnect();
    if (this.ws) {
      const old = this.ws;
      this.detachSocket(old);
      this.ws = null;
      this.clearHeartbeat();
      try {
        old.close();
      } catch {
        /* noop */
      }
    }
    const socket = new WebSocket(WS_URL);
    this.ws = socket;
    socket.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.clearHeartbeat();
      this.heartbeatT = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            /* noop */
          }
        }
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const e = parseEvent(ev.data);
      if (e) this.emit(e);
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    };
    socket.onclose = () => {
      if (this.ws === socket) {
        this.detachSocket(socket);
        this.ws = null;
      }
      this.clearHeartbeat();
      this.scheduleReconnect();
    };
  }
  private shutdown() {
    this.clearReconnect();
    this.clearHeartbeat();
    if (this.ws) {
      const s = this.ws;
      this.detachSocket(s);
      this.ws = null;
      try {
        s.close();
      } catch {
        /* noop */
      }
    }
  }
}

const manager = new PipelineWsManager();

export function usePipelineEvents(handler: (e: PipelineWsEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => manager.subscribe((e) => ref.current(e)), []);
}
