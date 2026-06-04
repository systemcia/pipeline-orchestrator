import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AnalyticsDailyPoint, AnalyticsDaySummary, AnalyticsProjectStat, AnalyticsSkillStat } from '@pipeline/shared';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openPipelineDb } from '../db.js';
import { defaultSessionsRoot } from './session-detail.js';

type ST = { date: string; sessions: number; tasks: number; failed: number };
const ZPIPE = { total_sessions: 0, completed_sessions: 0, failed_tasks: 0, total_tasks: 0, avg_tasks_per_session: 0, task_fail_rate: 0, top_failures: [] as { error: string; count: number }[], session_trend: [] as ST[] };
const SKILL_RE = /\/([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;

type DailySummaryRow = {
  date: string;
  summary: string;
  work_categories: string;
  total_sessions: number;
  projects: string | null;
};
type ProjectJson = {
  project_name?: string;
  session_count?: number;
  work_items?: { description?: string; category?: string }[];
};

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const defEnd = () => ymd(new Date());
const defStart = () => {
  const x = new Date();
  x.setMonth(x.getMonth() - 1);
  return ymd(x);
};
const sessRoot = defaultSessionsRoot;

async function collectSessionDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  if (!root || !existsSync(root)) return out;
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of top) {
    if (!p.isDirectory()) continue;
    const pp = join(root, p.name);
    if (existsSync(join(pp, 'state.json'))) {
      out.push(pp);
      continue;
    }
    let subs;
    try {
      subs = await readdir(pp, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const sp = join(pp, s.name);
      if (existsSync(join(sp, 'state.json'))) out.push(sp);
    }
  }
  return out;
}

function buildOverview(start: string, end: string) {
  const db = openPipelineDb();
  if (!db) {
    return {
      date_range: `${start} ~ ${end}`, total_days: 0, total_sessions: 0,
      avg_daily_sessions: 0, daily_trend: [], project_distribution: [],
      category_distribution: {}, daily_summaries: [], skill_usage: [],
    };
  }

  try {
    const rows = db.prepare(
      'SELECT date, summary, work_categories, total_sessions, projects FROM daily_summaries WHERE date BETWEEN ? AND ? ORDER BY date',
    ).all(start, end) as DailySummaryRow[];

    const dailyTrend: AnalyticsDailyPoint[] = [];
    const dailySummaries: AnalyticsDaySummary[] = [];
    const categoryDistribution: Record<string, number> = {};
    const pdays = new Map<string, Set<string>>();
    const psess = new Map<string, number>();
    const skillMap = new Map<string, number>();
    let totalSessions = 0;

    for (const row of rows) {
      const ts = row.total_sessions ?? 0;
      totalSessions += ts;
      dailyTrend.push({ date: row.date, sessions: ts });

      let cats: Record<string, number> = {};
      try { cats = JSON.parse(row.work_categories) as Record<string, number>; } catch { /* ignore */ }
      for (const [k, v] of Object.entries(cats)) {
        if (v > 0) categoryDistribution[k] = (categoryDistribution[k] ?? 0) + v;
      }

      let projects: ProjectJson[] = [];
      try { if (row.projects) projects = JSON.parse(row.projects) as ProjectJson[]; } catch { /* ignore */ }

      const projNames: string[] = [];
      for (const p of projects) {
        const n = p.project_name ?? '';
        if (!n) continue;
        projNames.push(n);
        psess.set(n, (psess.get(n) ?? 0) + (p.session_count ?? 0));
        let ds = pdays.get(n);
        if (!ds) { ds = new Set(); pdays.set(n, ds); }
        ds.add(row.date);

        for (const w of p.work_items ?? []) {
          const desc = w.description ?? '';
          SKILL_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = SKILL_RE.exec(desc)) !== null) {
            const k = m[1];
            if (k) skillMap.set(k, (skillMap.get(k) ?? 0) + 1);
          }
        }
      }

      dailySummaries.push({
        date: row.date,
        sessions: ts,
        projects: projNames,
        categories: cats,
        summary: row.summary ?? '',
      });
    }

    const skillUsage: AnalyticsSkillStat[] = [...skillMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const projectDistribution: AnalyticsProjectStat[] = [...psess.entries()]
      .map(([name, sessions]) => ({ name, sessions, days: pdays.get(name)?.size ?? 0 }))
      .sort((a, b) => b.sessions - a.sessions);

    const n = rows.length;
    return {
      date_range: `${start} ~ ${end}`,
      total_days: n,
      total_sessions: totalSessions,
      avg_daily_sessions: n > 0 ? totalSessions / n : 0,
      daily_trend: dailyTrend,
      project_distribution: projectDistribution,
      category_distribution: categoryDistribution,
      daily_summaries: dailySummaries,
      skill_usage: skillUsage,
    };
  } finally {
    db.close();
  }
}

async function pipelineTrend(root: string) {
  if (!root || !existsSync(root)) return ZPIPE;
  let ts = 0,
    comp = 0,
    failT = 0,
    totT = 0;
  const fmap = new Map<string, number>();
  const dmap = new Map<string, ST>();
  const failDetails: { session_id: string; session_name: string; task_id: string; task_name: string; error: string; date: string }[] = [];
  for (const dir of await collectSessionDirs(root)) {
    let raw: string;
    try {
      raw = await readFile(join(dir, 'state.json'), 'utf8');
    } catch {
      continue;
    }
    let st: { id?: string; name?: string; status?: string; created_at?: string; tasks?: { id?: string; name?: string; status?: string; error?: string }[] };
    try {
      st = JSON.parse(raw) as typeof st;
    } catch {
      continue;
    }
    const sid = st.id ?? basename(dir);
    ts++;
    if (st.status === 'COMPLETED') comp++;
    const ca = st.created_at ?? '';
    const day = ca.length >= 10 ? ca.slice(0, 10) : '';
    const tasks = st.tasks ?? [];
    if (day) {
      let pt = dmap.get(day);
      if (!pt) {
        pt = { date: day, sessions: 0, tasks: 0, failed: 0 };
        dmap.set(day, pt);
      }
      pt.sessions++;
      pt.tasks += tasks.length;
    }
    for (const t of tasks) {
      totT++;
      if (t.status === 'FAILED') {
        failT++;
        if (day) {
          const pt = dmap.get(day);
          if (pt) pt.failed++;
        }
        const er = t.error ?? '';
        if (er) fmap.set(er, (fmap.get(er) ?? 0) + 1);
        failDetails.push({
          session_id: sid,
          session_name: st.name ?? '',
          task_id: t.id ?? '',
          task_name: t.name ?? '',
          error: er,
          date: day,
        });
      }
    }
  }
  const topFailures = [...fmap.entries()]
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    total_sessions: ts,
    completed_sessions: comp,
    failed_tasks: failT,
    total_tasks: totT,
    avg_tasks_per_session: ts > 0 ? totT / ts : 0,
    task_fail_rate: totT > 0 ? (failT / totT) * 100 : 0,
    top_failures: topFailures,
    failed_task_details: failDetails,
    session_trend: [...dmap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function feedbackProposals(root: string) {
  if (!root || !existsSync(root)) return [];
  const list: { session_id: string; created_at: string; content: string }[] = [];
  for (const dir of await collectSessionDirs(root)) {
    let c: string;
    try {
      c = (await readFile(join(dir, 'improvements.md'), 'utf8')).trim();
    } catch {
      continue;
    }
    if (!c) continue;
    let sid = '',
      ca = '';
    try {
      const s = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
        id?: string;
        created_at?: string;
      };
      sid = s.id ?? '';
      ca = s.created_at ?? '';
    } catch {}
    list.push({ session_id: sid || basename(dir), created_at: ca, content: c });
  }
  list.sort((a, b) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0));
  return list;
}

type WsRow = { d: string; sessions: number; added: number; removed: number; files: number; tokens: number };

function aiCodeStats(start: string, end: string) {
  const db = openPipelineDb();
  if (!db) return null;
  try {
    const sql = `SELECT date(created_at/1000, 'unixepoch', 'localtime') as d,
      count(*) as sessions, sum(total_lines_added) as added,
      sum(total_lines_removed) as removed, sum(files_changed_count) as files,
      sum(token_count) as tokens
    FROM workspace_sessions
    WHERE total_lines_added > 0 AND date(created_at/1000, 'unixepoch', 'localtime') BETWEEN ? AND ?
    GROUP BY d ORDER BY d`;
    let rows = db.prepare(sql).all(start, end) as WsRow[];
    if (rows.length === 0) {
      const range = db.prepare(
        `SELECT min(date(created_at/1000,'unixepoch','localtime')) as mn, max(date(created_at/1000,'unixepoch','localtime')) as mx FROM workspace_sessions WHERE total_lines_added > 0`,
      ).get() as { mn: string | null; mx: string | null } | undefined;
      if (range?.mn && range?.mx) {
        rows = db.prepare(sql).all(range.mn, range.mx) as WsRow[];
      }
    }
    let totalAdded = 0, totalRemoved = 0, totalSessions = 0, totalFiles = 0, totalTokens = 0;
    let peakDay = '', peakAdded = 0;
    const daily: { date: string; lines_added: number; lines_removed: number; sessions: number; files: number }[] = [];
    for (const r of rows) {
      totalAdded += r.added; totalRemoved += r.removed;
      totalSessions += r.sessions; totalFiles += r.files; totalTokens += r.tokens;
      daily.push({ date: r.d, lines_added: r.added, lines_removed: r.removed, sessions: r.sessions, files: r.files });
      if (r.added > peakAdded) { peakAdded = r.added; peakDay = r.d; }
    }
    const first = rows[0] as WsRow | undefined;
    const last = rows[rows.length - 1] as WsRow | undefined;
    const actualStart = first?.d ?? start;
    const actualEnd = last?.d ?? end;
    const modeRows = db.prepare(
      `SELECT unified_mode as mode, count(*) as cnt FROM workspace_sessions WHERE total_lines_added > 0 AND date(created_at/1000,'unixepoch','localtime') BETWEEN ? AND ? GROUP BY unified_mode ORDER BY cnt DESC`,
    ).all(actualStart, actualEnd) as { mode: string; cnt: number }[];
    return {
      total_lines_added: totalAdded,
      total_lines_removed: totalRemoved,
      total_sessions: totalSessions,
      total_files: totalFiles,
      total_tokens: totalTokens,
      avg_daily_added: daily.length > 0 ? Math.round(totalAdded / daily.length) : 0,
      peak_day: peakDay,
      peak_added: peakAdded,
      mode_distribution: modeRows.map((m) => ({ mode: m.mode || 'unknown', count: m.cnt })),
      daily,
      actual_range: { start: actualStart, end: actualEnd },
    };
  } finally {
    db.close();
  }
}

function sendOk(reply: FastifyReply, data: unknown) {
  try {
    return reply.send({ dat: data });
  } catch (e) {
    return reply.code(500).send({ dat: null, error: e instanceof Error ? e.message : String(e) });
  }
}

function sendErr(reply: FastifyReply, e: unknown) {
  return reply.code(500).send({ dat: null, error: e instanceof Error ? e.message : String(e) });
}

type Qs = { start_date?: string; end_date?: string };
export const analyticsPlugin: FastifyPluginAsync = async (app) => {
  app.get('/analytics/overview', (req, reply) => {
    const q = req.query as Qs;
    try {
      return sendOk(reply, buildOverview(q.start_date ?? defStart(), q.end_date ?? defEnd()));
    } catch (e) {
      return sendErr(reply, e);
    }
  });
  app.get('/analytics/pipeline-trend', async (_r, reply) => {
    try {
      return sendOk(reply, await pipelineTrend(sessRoot()));
    } catch (e) {
      return sendErr(reply, e);
    }
  });
  app.get('/analytics/feedback-proposals', async (_r, reply) => {
    try {
      return sendOk(reply, await feedbackProposals(sessRoot()));
    } catch (e) {
      return sendErr(reply, e);
    }
  });
  app.get('/analytics/ai-tracking', (req, reply) => {
    const q = req.query as Qs;
    try {
      const data = aiCodeStats(q.start_date ?? defStart(), q.end_date ?? defEnd());
      if (!data) return sendErr(reply, new Error('pipeline.db not available'));
      return sendOk(reply, data);
    } catch (e) {
      return sendErr(reply, e);
    }
  });
};
