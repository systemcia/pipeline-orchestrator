import type { FastifyInstance, FastifyReply } from 'fastify';
import { openPipelineDb } from '../db.js';
import {
  loadSessionContext,
  relatedSessions,
  searchSessions,
  timelineChunks,
} from '../sessionSearchService.js';

function sendErr(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ dat: null, error: msg });
}

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search/sessions', async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? '');
    if (!q) return sendErr(reply, 400, "query parameter 'q' is required");
    const project = String((req.query as { project?: string }).project ?? '');
    let limit = Number((req.query as { limit?: string }).limit ?? 20);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 100) limit = 20;
    const db = openPipelineDb();
    if (!db) return sendErr(reply, 500, 'pipeline db not available');
    try {
      return { dat: searchSessions(db, q, project, limit) };
    } finally {
      db.close();
    }
  });
  app.get<{ Params: { sessionId: string } }>('/search/context/:sessionId', async (req, reply) => {
    const db = openPipelineDb();
    try {
      return { dat: await loadSessionContext(db, req.params.sessionId) };
    } catch (e) {
      return sendErr(reply, 500, e instanceof Error ? e.message : String(e));
    } finally {
      db?.close();
    }
  });
  app.get<{ Params: { sessionId: string } }>('/search/timeline/:sessionId', async (req, reply) => {
    const db = openPipelineDb();
    if (!db) return sendErr(reply, 500, 'pipeline db not available');
    try {
      return { dat: timelineChunks(db, req.params.sessionId) };
    } catch (e) {
      return sendErr(reply, 500, e instanceof Error ? e.message : String(e));
    } finally {
      db.close();
    }
  });
  app.get<{ Params: { sessionId: string } }>('/search/related/:sessionId', async (req, reply) => {
    let limit = Number((req.query as { limit?: string }).limit ?? 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    const db = openPipelineDb();
    if (!db) return sendErr(reply, 500, 'pipeline db not available');
    try {
      const rows = relatedSessions(db, req.params.sessionId, limit);
      return {
        dat: rows.map((r) => ({
          session_id: r.session_id,
          name: r.name,
          project_name: r.project_name ?? '',
          token_count: Number(r.token_count),
          lines_added: Number(r.lines_added),
          lines_removed: Number(r.lines_removed),
          created_at: Number(r.created_at),
          match_field: 'related',
          match_text: '',
        })),
      };
    } catch (e) {
      return sendErr(reply, 500, e instanceof Error ? e.message : String(e));
    } finally {
      db.close();
    }
  });
}
