import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AnalyticsDailyPoint, AnalyticsDaySummary, AnalyticsProjectStat, AnalyticsSkillStat } from '@pipeline/shared';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getDb, openPipelineDb } from '../db.js';
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

function aiTrackingUsage(start: string, end: string) {
  const path = join(homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
  if (!existsSync(path)) throw new Error('ai-tracking db not available');
  const db = getDb(path);
  try {
    const sql = `SELECT date(createdAt/1000, 'unixepoch', 'localtime') as d, model, source, count(*) as cnt FROM ai_code_hashes WHERE date(createdAt/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? GROUP BY d, model, source ORDER BY d`;
    const rows = db.prepare(sql).all(start, end) as { d: string; model: string; source: string; cnt: number }[];
    let total = 0;
    const mm = new Map<string, number>();
    const dm = new Map<string, number>();
    const daily_usage: { date: string; model: string; source: string; code_hashes: number }[] = [];
    for (const r of rows) {
      daily_usage.push({ date: r.d, model: r.model, source: r.source, code_hashes: r.cnt });
      total += r.cnt;
      mm.set(r.model, (mm.get(r.model) ?? 0) + r.cnt);
      dm.set(r.d, (dm.get(r.d) ?? 0) + r.cnt);
    }
    let peakDay = '',
      peakCount = 0;
    const daily_total: AnalyticsDailyPoint[] = [];
    for (const [date, cnt] of dm) {
      daily_total.push({ date, sessions: cnt });
      if (cnt > peakCount) {
        peakCount = cnt;
        peakDay = date;
      }
    }
    daily_total.sort((a, b) => a.date.localeCompare(b.date));
    return {
      total_code_hashes: total,
      daily_usage,
      model_distribution: [...mm.entries()]
        .map(([model, count]) => ({ model, count }))
        .sort((a, b) => b.count - a.count),
      daily_total,
      peak_day: peakDay,
      peak_count: peakCount,
      avg_daily: dm.size > 0 ? total / dm.size : 0,
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
      return sendOk(reply, aiTrackingUsage(q.start_date ?? defStart(), q.end_date ?? defEnd()));
    } catch (e) {
      return sendErr(reply, e);
    }
  });
};
