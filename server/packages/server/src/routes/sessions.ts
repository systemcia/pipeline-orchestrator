import type { ValidationResult } from '@pipeline/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionReviewService } from '../services/sessionReviewService.js';
import { defaultSessionsRoot, SessionFsService } from './session-detail.js';
import { SessionOpenSpecService } from './session-openspec.js';

function sendError(reply: FastifyReply, code: number, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return reply.code(code).send({ dat: null, error: msg });
}

function sendOk(reply: FastifyReply, data: unknown) {
  return reply.send({ dat: data });
}

async function ensureProjectFilter(
  svc: SessionFsService,
  reply: FastifyReply,
  sessionId: string,
  project: string | undefined,
): Promise<boolean> {
  if (!project) return true;
  try {
    const got = await svc.getSessionProjectId(sessionId);
    if (got !== project) {
      sendError(reply, 404, new Error(`session not in project "${project}"`));
      return false;
    }
    return true;
  } catch (e) {
    sendError(reply, 404, e);
    return false;
  }
}

/** Session 文件系统 API，与 Go `handler.SessionHandler` + `service.SessionService` 行为对齐。 */
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const sessRoot = defaultSessionsRoot();
  const svc = new SessionFsService(sessRoot);
  const osSvc = new SessionOpenSpecService(svc, sessRoot);
  const reviewSvc = new SessionReviewService(sessRoot);

  app.get('/sessions', async (req, reply) => {
    try {
      const project = (req.query as { project?: string }).project ?? '';
      const sessions = await svc.listSessions(project);
      return sendOk(reply, sessions);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const dat = await svc.getSessionRecord(id);
      return sendOk(reply, dat);
    } catch (e) {
      return sendError(reply, 404, e);
    }
  });

  app.delete('/sessions/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const rel = await svc.findSessionRelPath(id);
      const sessDir = join(sessRoot, rel);
      await rm(sessDir, { recursive: true, force: true });
      return sendOk(reply, { deleted: id });
    } catch (e) {
      return sendError(reply, 404, e);
    }
  });

  app.get('/sessions/:id/logs', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const logs = await svc.listLogs(id);
      return sendOk(reply, logs);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/logs/:name', async (req, reply) => {
    try {
      const { id, name } = req.params as { id: string; name: string };
      const safeName = name.replace(/[/\\]/g, '');
      if (!safeName.endsWith('.md') || safeName.includes('..')) {
        return sendError(reply, 400, new Error(`invalid log file name: ${safeName}`));
      }
      const content = await svc.readSessionFile(id, `logs/${safeName}`);
      return sendOk(reply, content);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/snapshots', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const snapshots = await svc.listSnapshots(id);
      return sendOk(reply, snapshots);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/session-md', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const content = await svc.readSessionFile(id, 'session.md');
      return sendOk(reply, content);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/pending', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const content = await svc.readSessionFile(id, 'pending.md');
      return sendOk(reply, content);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/analysis-trace', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const content = await osSvc.readAnalysisTrace(id);
      return sendOk(reply, content);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/design-brief', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const content = await osSvc.readDesignBrief(id);
      return sendOk(reply, content);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.get('/sessions/:id/openspec-info', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const info = await osSvc.getInfo(id);
      return sendOk(reply, info);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.post('/sessions/:id/repair-docs', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const result = await osSvc.repairDocs(id);
      return sendOk(reply, result);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.post('/sessions/:id/complete', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const result = await svc.completeSession(id);
      if (!result.ok) return sendError(reply, 400, new Error(result.message));
      setImmediate(() => {
        reviewSvc.generate(id).catch((e) => {
          console.error(`[auto-review] ${id} failed:`, e instanceof Error ? e.message : e);
        });
      });
      return sendOk(reply, result);
    } catch (e) {
      return sendError(reply, 500, e);
    }
  });

  app.post('/sessions/:id/generate-review', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (reviewSvc.isGenerating(id)) {
      return reply.code(409).send({ dat: null, error: 'review already generating' });
    }
    const apiBase = process.env['OPENAI_API_BASE_URL'] || process.env['OPENAI_BASE_URL'];
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiBase || !apiKey) {
      return reply.code(503).send({ dat: null, error: 'LLM 未配置：需设置 OPENAI_API_BASE_URL 和 OPENAI_API_KEY 环境变量' });
    }
    try {
      await svc.findSessionRelPath(id);
    } catch {
      return sendError(reply, 404, new Error(`session not found: ${id}`));
    }
    setImmediate(() => {
      reviewSvc.generate(id).catch((e) => {
        console.error(`[generate-review] ${id} failed:`, e instanceof Error ? e.message : e);
      });
    });
    return reply.code(202).send({ dat: { status: 'generating' } });
  });

  app.get('/sessions/:id/review-status', async (req, reply) => {
    const { id } = req.params as { id: string };
    return sendOk(reply, { generating: reviewSvc.isGenerating(id) });
  });

  const validateHandler = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = req.params as { id: string };
      const result: ValidationResult = await svc.validateSession(id);
      return sendOk(reply, result);
    } catch (e) {
      return sendError(reply, 404, e);
    }
  };

  app.get('/sessions/:id/validate', validateHandler);
  app.get('/sessions/:id/validation', validateHandler);

  app.get('/sessions/:id/lessons', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = (req.query as { project?: string }).project;
    if (!(await ensureProjectFilter(svc, reply, id, project))) return;
    try {
      const content = await svc.readSessionFile(id, 'lessons.md');
      return sendOk(reply, content);
    } catch {
      try {
        const fallback = await svc.readSessionFile(id, 'session-analysis.md');
        return sendOk(reply, fallback);
      } catch (e2) {
        return sendOk(reply, '');
      }
    }
  });

  app.get('/sessions/:id/improvements', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = (req.query as { project?: string }).project;
    if (!(await ensureProjectFilter(svc, reply, id, project))) return;
    try {
      const content = await svc.readSessionFile(id, 'improvements.md');
      return sendOk(reply, content);
    } catch {
      try {
        const fallback = await svc.readSessionFile(id, 'session-analysis.md');
        return sendOk(reply, fallback);
      } catch (e2) {
        return sendOk(reply, '');
      }
    }
  });

  app.get('/sessions/:id/config', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const raw = await svc.getSessionRecord(id);
      return sendOk(reply, svc.getSessionConfigPayload(raw));
    } catch (e) {
      return sendError(reply, 404, e);
    }
  });

  app.get('/config', async (_req, reply) => {
    const configPath = resolve(join(sessRoot, '..', 'config.yaml'));
    try {
      const raw = await readFile(configPath, 'utf-8');
      return sendOk(reply, {
        raw,
        config_path: configPath,
        config_exists: true,
        sessions_root: sessRoot,
      });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return sendOk(reply, {
          max_parallel: 3,
          timeout_minutes: 10,
          sessions_root: sessRoot,
          config_path: configPath,
          config_exists: false,
        });
      }
      return sendError(reply, 500, e);
    }
  });
}
