import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { KnowledgeChunk, RagSearchResult } from '@pipeline/shared';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { escapeLike, openPipelineDb } from '../db.js';
import { defaultSessionsRoot } from './session-detail.js';

const sessionsRoot = defaultSessionsRoot();

function dateToUnixMs(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function chunkRelevance(lowerQ: string, r: RagSearchResult): number {
  let score = 0;
  if (r.topic.toLowerCase().includes(lowerQ)) score += 2;
  if (r.query.toLowerCase().includes(lowerQ)) score += 1.5;
  if (r.answerCore.toLowerCase().includes(lowerQ)) score += 1;
  if (r.tags.toLowerCase().includes(lowerQ)) score += 0.5;
  return score === 0 ? 0.5 : score;
}

function collectSessionRelPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('pipe-')) {
      paths.push(e.name);
      continue;
    }
    try {
      for (const se of readdirSync(join(root, e.name), { withFileTypes: true })) {
        if (se.isDirectory() && se.name.startsWith('pipe-')) paths.push(join(e.name, se.name));
      }
    } catch {}
  }
  return paths;
}

function readSessionMeta(root: string, rel: string): { sid: string; pid: string } {
  try {
    const m = JSON.parse(readFileSync(join(root, rel, 'state.json'), 'utf8')) as { id?: string; project_id?: string };
    const sid = m.id || basename(rel);
    const pid = m.project_id || '_default';
    return { sid: sid || basename(rel), pid: pid || '_default' };
  } catch {
    return { sid: basename(rel), pid: '_default' };
  }
}

function searchImprovementsOnDisk(q: string, remaining: number, project: string): KnowledgeChunk[] {
  if (remaining <= 0) return [];
  const lowerQ = q.toLowerCase();
  const out: KnowledgeChunk[] = [];
  for (const rel of collectSessionRelPaths(sessionsRoot)) {
    if (out.length >= remaining) break;
    const impPath = join(sessionsRoot, rel, 'improvements.md');
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(impPath);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    let data: string;
    try {
      data = readFileSync(impPath, 'utf8');
    } catch {
      continue;
    }
    if (!data || !data.toLowerCase().includes(lowerQ)) continue;
    const { sid, pid } = readSessionMeta(sessionsRoot, rel);
    if (project && pid !== project) continue;
    const core = data.length > 800 ? `${data.slice(0, 800)}…` : data;
    out.push({
      id: `improvements-${sid}`,
      sessionId: sid,
      chunkIndex: 0,
      projectName: pid,
      userQuery: 'improvements.md',
      aiResponseCore: core,
      mainTopic: 'improvements',
      tags: '',
      toolsUsed: '',
      codeLanguages: '',
      hasCode: false,
      enrichmentStatus: 'session_file',
      timestamp: st.mtimeMs,
    });
  }
  return out;
}

function rowToChunk(row: Record<string, unknown>): KnowledgeChunk | null {
  if (typeof row['id'] !== 'string' || typeof row['session_id'] !== 'string') return null;
  return {
    id: row['id'],
    sessionId: row['session_id'],
    chunkIndex: Number(row['chunk_index']) || 0,
    projectName: String(row['project_name'] ?? ''),
    userQuery: String(row['user_query'] ?? ''),
    aiResponseCore: String(row['ai_response_core'] ?? ''),
    mainTopic: String(row['main_topic'] ?? ''),
    tags: String(row['tags'] ?? ''),
    toolsUsed: String(row['tools_used'] ?? ''),
    codeLanguages: String(row['code_languages'] ?? ''),
    hasCode: Boolean(row['has_code']),
    enrichmentStatus: String(row['enrichment_status'] ?? ''),
    timestamp: Number(row['timestamp']) || 0,
  };
}

const cw = (c: KnowledgeChunk) => ({
  id: c.id,
  session_id: c.sessionId,
  chunk_index: c.chunkIndex,
  project_name: c.projectName,
  user_query: c.userQuery,
  ai_response_core: c.aiResponseCore,
  main_topic: c.mainTopic,
  tags: c.tags,
  tools_used: c.toolsUsed,
  code_languages: c.codeLanguages,
  has_code: c.hasCode,
  enrichment_status: c.enrichmentStatus,
  timestamp: c.timestamp,
});

const rw = (r: RagSearchResult) => ({
  query: r.query,
  answer_core: r.answerCore,
  topic: r.topic,
  tags: r.tags,
  score: r.score,
  source: r.source,
});

const err = (reply: FastifyReply, code: number, message: string) =>
  reply.code(code).send({ dat: null, error: message });
const ok = (reply: FastifyReply, dat: unknown) => reply.send({ dat });

function withDb<T>(reply: FastifyReply, fn: (db: DatabaseSync) => T): T | ReturnType<typeof err> {
  const db = openPipelineDb();
  if (!db) return err(reply, 500, 'pipeline db not available');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const CHUNK_SEL =
  'SELECT id, session_id, chunk_index, project_name, user_query, ai_response_core, COALESCE(main_topic,\'\') AS main_topic, COALESCE(tags,\'\') AS tags, COALESCE(tools_used,\'\') AS tools_used, COALESCE(code_languages,\'\') AS code_languages, has_code, enrichment_status, timestamp FROM rag_knowledge_chunks';

export const knowledgePlugin: FastifyPluginAsync = async (app) => {
  app.get('/knowledge/stats', (_req, reply) => {
    return withDb(reply, (db) => {
      const stats = {
        total_chunks: Number((db.prepare('SELECT count(*) AS c FROM rag_knowledge_chunks').get() as { c: number }).c ?? 0),
        total_gems: Number((db.prepare('SELECT count(*) AS c FROM prompt_gems').get() as { c: number }).c ?? 0),
        project_distribution: [] as { project: string; chunks: number; sessions: number }[],
        category_distribution: [] as { category: string; count: number; avg_score: number }[],
      };
      try {
        stats.project_distribution = (
          db
            .prepare(
              `SELECT project_name, count(*) as chunks, count(DISTINCT session_id) as sessions FROM rag_knowledge_chunks GROUP BY project_name ORDER BY chunks DESC`,
            )
            .all() as { project_name: string; chunks: number; sessions: number }[]
        ).map((r) => ({ project: r.project_name, chunks: r.chunks, sessions: r.sessions }));
      } catch {}
      try {
        stats.category_distribution = (
          db
            .prepare(
              `SELECT category, count(*) as cnt, round(avg(quality_score),1) as av FROM prompt_gems GROUP BY category ORDER BY count(*) DESC`,
            )
            .all() as { category: string; cnt: number; av: number }[]
        ).map((r) => ({ category: r.category, count: r.cnt, avg_score: r.av }));
      } catch {}
      return ok(reply, stats);
    });
  });

  app.get('/knowledge/chunks', (req, reply) => {
    return withDb(reply, (db) => {
      const q = req.query as { project?: string; limit?: string };
      let limit = parseInt(q.limit ?? '20', 10);
      if (limit <= 0 || limit > 100) limit = 20;
      const project = q.project ?? '';
      const rows = (
        project
          ? db.prepare(`${CHUNK_SEL} WHERE project_name = ? ORDER BY timestamp DESC LIMIT ?`).all(project, limit)
          : db.prepare(`${CHUNK_SEL} ORDER BY timestamp DESC LIMIT ?`).all(limit)
      ) as Record<string, unknown>[];
      const chunks = rows.map(rowToChunk).filter(Boolean) as KnowledgeChunk[];
      return ok(reply, chunks.map(cw));
    });
  });

  app.get('/knowledge/search', (req, reply) => {
    const qp = req.query as { q?: string; limit?: string; project?: string };
    if (!qp.q) return err(reply, 400, "query parameter 'q' is required");
    let limit = parseInt(qp.limit ?? '10', 10);
    if (limit <= 0 || limit > 50) limit = 10;
    const project = qp.project ?? '';
    const db = openPipelineDb();
    const pat = `%${escapeLike(qp.q)}%`;
    let chunks: KnowledgeChunk[] = [];
    let sqlErr: Error | null = null;
    try {
      if (db) {
        try {
          const wh = `${CHUNK_SEL} WHERE (user_query LIKE ? ESCAPE '\\' OR ai_response_core LIKE ? ESCAPE '\\')`;
          const rows = (
            project
              ? db.prepare(`${wh} AND project_name = ? ORDER BY timestamp DESC LIMIT ?`).all(pat, pat, project, limit)
              : db.prepare(`${wh} ORDER BY timestamp DESC LIMIT ?`).all(pat, pat, limit)
          ) as Record<string, unknown>[];
          chunks = rows.map(rowToChunk).filter(Boolean) as KnowledgeChunk[];
        } catch (e) {
          sqlErr = e instanceof Error ? e : new Error(String(e));
        }
      } else {
        sqlErr = new Error('pipeline db not available');
      }
    } finally {
      db?.close();
    }
    const need = limit - chunks.length;
    if (need > 0) chunks = chunks.concat(searchImprovementsOnDisk(qp.q, need, project));
    if (chunks.length === 0 && sqlErr) return err(reply, 500, `search chunks: ${sqlErr.message}`);
    return ok(reply, chunks.map(cw));
  });

  app.get('/knowledge/gems', (req, reply) => {
    return withDb(reply, (db) => {
      const q = req.query as { category?: string; min_score?: string; limit?: string };
      let limit = parseInt(q.limit ?? '20', 10);
      if (limit <= 0 || limit > 100) limit = 20;
      let sql = `SELECT id, session_id, COALESCE(project_name,'') AS project_name, source, user_prompt, COALESCE(ai_response_summary,'') AS ai_summary, quality_score, COALESCE(quality_tags,'') AS quality_tags, category, timestamp FROM prompt_gems WHERE quality_score >= ?`;
      const args: (string | number)[] = [parseFloat(q.min_score ?? '0')];
      if (q.category) {
        sql += ' AND category = ?';
        args.push(q.category);
      }
      args.push(limit);
      try {
        const gems = (db.prepare(`${sql} ORDER BY quality_score DESC LIMIT ?`).all(...args) as Record<string, unknown>[]).map(
          (r) => ({
            id: String(r['id']),
            session_id: String(r['session_id']),
            project_name: String(r['project_name'] ?? ''),
            source: String(r['source'] ?? ''),
            user_prompt: String(r['user_prompt'] ?? ''),
            ai_summary: String(r['ai_summary'] ?? ''),
            quality_score: Number(r['quality_score']) || 0,
            quality_tags: String(r['quality_tags'] ?? ''),
            category: String(r['category'] ?? ''),
            timestamp: Number(r['timestamp']) || 0,
          }),
        );
        return ok(reply, gems);
      } catch (e) {
        return err(reply, 500, `query gems: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });

  app.get('/knowledge/token-stats', (req, reply) => {
    return withDb(reply, (db) => {
      const pad = (n: number) => String(n).padStart(2, '0');
      const t = new Date();
      const endDefault = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
      const s = new Date(t);
      s.setMonth(s.getMonth() - 1);
      const startDefault = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
      const qq = req.query as { start_date?: string; end_date?: string };
      const endDate = qq.end_date ?? endDefault;
      const startDate = qq.start_date ?? startDefault;
      const startTs = dateToUnixMs(startDate);
      const endTs = dateToUnixMs(endDate) + 86400000;
      const row1 = db
        .prepare(
          `SELECT COALESCE(sum(token_count),0) AS tt, count(*) AS tc, COALESCE(avg(token_count),0) AS av FROM workspace_sessions WHERE token_count > 0 AND created_at BETWEEN ? AND ?`,
        )
        .get(startTs, endTs) as { tt: number; tc: number; av: number };
      const row2 = db
        .prepare(
          `SELECT token_count AS mx, COALESCE(name,'') AS nm FROM workspace_sessions WHERE token_count > 0 AND created_at BETWEEN ? AND ? ORDER BY token_count DESC LIMIT 1`,
        )
        .get(startTs, endTs) as { mx: number; nm: string } | undefined;
      const stats = {
        total_tokens: Number(row1?.tt ?? 0),
        total_sessions: Number(row1?.tc ?? 0),
        avg_per_session: Number(row1?.av ?? 0),
        max_tokens: Number(row2?.mx ?? 0),
        max_session_name: row2?.nm ?? '',
        project_distribution: [] as { project: string; tokens: number; sessions: number }[],
        daily_trend: [] as { date: string; tokens: number; sessions: number }[],
      };
      try {
        stats.project_distribution = (
          db
            .prepare(
              `SELECT COALESCE(r.project_name, 'unknown') as proj, sum(ws.token_count) as tokens, count(DISTINCT ws.composer_id) as sessions FROM workspace_sessions ws LEFT JOIN (SELECT DISTINCT session_id, project_name FROM rag_knowledge_chunks) r ON ws.composer_id = r.session_id WHERE ws.token_count > 0 AND ws.created_at BETWEEN ? AND ? GROUP BY proj ORDER BY tokens DESC`,
            )
            .all(startTs, endTs) as { proj: string; tokens: number; sessions: number }[]
        ).map((r) => ({ project: r.proj, tokens: r.tokens, sessions: r.sessions }));
      } catch {}
      try {
        stats.daily_trend = (
          db
            .prepare(
              `SELECT date(created_at/1000, 'unixepoch', 'localtime') as d, sum(token_count) as tokens, count(*) as sessions FROM workspace_sessions WHERE token_count > 0 AND created_at BETWEEN ? AND ? GROUP BY d ORDER BY d`,
            )
            .all(startTs, endTs) as { d: string; tokens: number; sessions: number }[]
        ).map((r) => ({ date: r.d, tokens: r.tokens, sessions: r.sessions }));
      } catch {}
      const merged = new Map<string, { project: string; tokens: number; sessions: number }>();
      for (const p of stats.project_distribution) {
        const ex = merged.get(p.project);
        if (ex) {
          ex.tokens += p.tokens;
          ex.sessions += p.sessions;
        } else merged.set(p.project, { ...p });
      }
      stats.project_distribution = [...merged.values()].sort((a, b) => b.tokens - a.tokens);
      return ok(reply, stats);
    });
  });

  app.post('/knowledge/rag', (req, reply) => {
    const b = req.body as { q?: string; limit?: number } | undefined;
    const qq = req.query as { q?: string; limit?: string };
    let q = (typeof b?.q === 'string' ? b.q : '') || qq.q || '';
    let limit = typeof b?.limit === 'number' && !Number.isNaN(b.limit) ? b.limit : parseInt(qq.limit ?? '5', 10);
    if (!q) return err(reply, 400, "query parameter 'q' is required");
    if (limit <= 0 || limit > 20) limit = 5;
    return withDb(reply, (db) => {
      const pattern = `%${escapeLike(q)}%`;
      const lowerQ = q.toLowerCase();
      const results: RagSearchResult[] = [];
      try {
        const rows = db
          .prepare(
            `SELECT user_query, ai_response_core, COALESCE(main_topic,'') AS main_topic, COALESCE(tags,'') AS tags FROM rag_knowledge_chunks WHERE user_query LIKE ? ESCAPE '\\' OR ai_response_core LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT ?`,
          )
          .all(pattern, pattern, limit) as { user_query: string; ai_response_core: string; main_topic: string; tags: string }[];
        for (const row of rows) {
          const r: RagSearchResult = {
            query: row.user_query,
            answerCore: row.ai_response_core,
            topic: row.main_topic,
            tags: row.tags,
            score: 0,
            source: 'chunk',
          };
          r.score = chunkRelevance(lowerQ, r);
          results.push(r);
        }
      } catch {}
      let gemLimit = Math.floor(limit / 2);
      if (gemLimit < 2) gemLimit = 2;
      try {
        const rows = db
          .prepare(
            `SELECT user_prompt, COALESCE(ai_response_summary,'') AS ai_summary, category, COALESCE(quality_tags,'') AS quality_tags, quality_score FROM prompt_gems WHERE (user_prompt LIKE ? ESCAPE '\\' OR ai_response_summary LIKE ? ESCAPE '\\') AND quality_score >= 3 ORDER BY quality_score DESC, timestamp DESC LIMIT ?`,
          )
          .all(pattern, pattern, gemLimit) as {
            user_prompt: string;
            ai_summary: string;
            category: string;
            quality_tags: string;
            quality_score: number;
          }[];
        for (const row of rows) {
          results.push({
            query: row.user_prompt,
            answerCore: row.ai_summary,
            topic: row.category,
            tags: row.quality_tags,
            score: row.quality_score,
            source: 'gem',
          });
        }
      } catch {}
      results.sort((a, b) => b.score - a.score);
      return ok(reply, (results.length > limit ? results.slice(0, limit) : results).map(rw));
    });
  });
};
