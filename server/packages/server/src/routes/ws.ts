import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

const clients = new Set<WebSocket>();
const HEARTBEAT_MS = 30_000;

/** 供 events 路由广播，与 WebSocket 注册解耦。 */
export function broadcastToWsClients(payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) {
      clients.delete(ws);
      continue;
    }
    try {
      ws.send(text);
    } catch {
      clients.delete(ws);
    }
  }
}

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket);
  app.get(
    '/ws/sessions',
    { websocket: true },
    (socket: WebSocket, _req) => {
      clients.add(socket);
      const pingTimer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) {
          clearInterval(pingTimer);
          return;
        }
        try {
          socket.ping();
        } catch {
          clearInterval(pingTimer);
          clients.delete(socket);
        }
      }, HEARTBEAT_MS);
      const cleanup = () => {
        clearInterval(pingTimer);
        clients.delete(socket);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    },
  );
}
