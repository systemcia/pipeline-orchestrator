import type { FastifyInstance } from 'fastify';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { broadcastToWsClients } from './ws.js';
import { defaultSessionsRoot } from './session-detail.js';

export type PipelineEventBody = {
  session_id: string;
  event_type: string;
  task_id?: string;
  timestamp: number;
  data?: unknown;
};

const SESSIONS_ROOT = defaultSessionsRoot();

async function writeGlobalAudit(body: PipelineEventBody): Promise<void> {
  const rec = {
    ts: new Date().toISOString(),
    session_id: body.session_id,
    event: body.event_type,
    data: body.data ?? null,
  };
  const line = JSON.stringify(rec) + '\n';
  try {
    await appendFile(join(SESSIONS_ROOT, 'audit.jsonl'), line, 'utf-8');
  } catch (e) {
    console.error('audit write failed:', e);
  }
}

export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PipelineEventBody }>('/events', async (request, reply) => {
    const b = request.body;
    if (!b?.session_id || !b?.event_type || typeof b.timestamp !== 'number') {
      return reply.code(400).send({ dat: null, error: 'invalid_body' });
    }
    await writeGlobalAudit(b);
    broadcastToWsClients(b);
    return reply.send({ dat: { received: true } });
  });
}
