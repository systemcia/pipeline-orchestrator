import type { ValidationResult } from '@pipeline/shared';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** API 列表行形状（与 Go model.SessionSummary 的 JSON 标签一致）。 */
export interface SessionSummaryApi {
  id: string;
  name: string;
  project_id?: string;
  status: string;
  scale?: string;
  mode?: string;
  created_at: string | null;
  updated_at: string | null;
  task_count: number;
  completed_count: number;
  failed_count: number;
  running_count: number;
  progress: number;
}

export interface LogEntryApi {
  name: string;
  size: number;
  mod_time: string;
}

export interface SnapshotEntryApi {
  name: string;
  ref: string;
  mod_time: string;
}

interface ParsedTask {
  id: string;
  status: string;
  depends_on: string[] | null;
  started_at?: unknown;
  completed_at?: unknown;
  log_file?: string;
  agent_type?: string;
  error?: string;
}

interface ParsedState {
  id: string;
  name: string;
  project_id?: string;
  status: string;
  scale?: string;
  mode?: string;
  created_at: string | null;
  updated_at: string | null;
  config: Record<string, unknown>;
  tasks: ParsedTask[];
}

function validateID(id: string): Error | null {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return new Error(`invalid session id: ${id}`);
  }
  return null;
}

function effectiveProjectID(state: ParsedState): string {
  if (state.project_id && state.project_id !== '') return state.project_id;
  return '_default';
}

function formatModTime(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function collectSessionRelPaths(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw e;
  }
  const paths: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name.startsWith('pipe-')) {
      paths.push(name);
      continue;
    }
    let sub;
    try {
      sub = await readdir(join(root, name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of sub) {
      if (!se.isDirectory() || !se.name.startsWith('pipe-')) continue;
      paths.push(join(name, se.name));
    }
  }
  return paths;
}

function normalizeStateRecord(raw: Record<string, unknown>, rel: string): void {
  const tasks = raw['tasks'] as Array<Record<string, unknown>> | undefined;
  if (!tasks) raw['tasks'] = [];
  else {
    for (const t of tasks) {
      if (t['depends_on'] == null) t['depends_on'] = [];
    }
  }
  const id = raw['id'];
  if (id == null || id === '') raw['id'] = basename(rel);
}

function recordToParsedState(raw: Record<string, unknown>): ParsedState {
  const st: ParsedState = {
    id: String(raw['id'] ?? ''),
    name: (raw['name'] as string) ?? '',
    status: (raw['status'] as string) ?? '',
    created_at: (raw['created_at'] as string | null) ?? null,
    updated_at: (raw['updated_at'] as string | null) ?? null,
    config: (raw['config'] as Record<string, unknown>) ?? {},
    tasks: (raw['tasks'] as ParsedTask[]) ?? [],
  };
  const pid = raw['project_id'];
  if (pid !== undefined && pid !== null && String(pid) !== '') st.project_id = String(pid);
  const scale = raw['scale'];
  if (scale !== undefined && scale !== null) st.scale = String(scale);
  const mode = raw['mode'];
  if (mode !== undefined && mode !== null) st.mode = String(mode);
  return st;
}

export class SessionFsService {
  constructor(private readonly root: string) {}

  private async readStateRecordByRel(rel: string): Promise<Record<string, unknown>> {
    const data = await readFile(join(this.root, rel, 'state.json'), 'utf8');
    const raw = JSON.parse(data) as Record<string, unknown>;
    normalizeStateRecord(raw, rel);
    return raw;
  }

  async findSessionRelPath(id: string): Promise<string> {
    const v = validateID(id);
    if (v) throw v;
    const rels = await collectSessionRelPaths(this.root);
    for (const rel of rels) {
      let raw: Record<string, unknown>;
      try {
        raw = await this.readStateRecordByRel(rel);
      } catch {
        continue;
      }
      const sid = String(raw['id'] ?? '');
      if (sid === id) return rel;
    }
    throw new Error(`session ${id} not found`);
  }

  async readState(id: string): Promise<ParsedState> {
    const rel = await this.findSessionRelPath(id);
    const raw = await this.readStateRecordByRel(rel);
    return recordToParsedState(raw);
  }

  /** 完整 state.json 对象（与 Go GetSession 序列化一致，含扩展字段）。 */
  async getSessionRecord(id: string): Promise<Record<string, unknown>> {
    const v = validateID(id);
    if (v) throw v;
    const rel = await this.findSessionRelPath(id);
    return this.readStateRecordByRel(rel);
  }

  async listSessions(project: string): Promise<SessionSummaryApi[]> {
    let rels: string[];
    try {
      rels = await collectSessionRelPaths(this.root);
    } catch (e) {
      throw new Error(`scan sessions dir: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result: SessionSummaryApi[] = [];
    for (const rel of rels) {
      let raw: Record<string, unknown>;
      try {
        raw = await this.readStateRecordByRel(rel);
      } catch {
        continue;
      }
      const state = recordToParsedState(raw);
      const pid = effectiveProjectID(state);
      if (project && pid !== project) continue;
      let completed = 0;
      let failed = 0;
      let running = 0;
      for (const t of state.tasks) {
        switch (t.status) {
          case 'COMPLETED':
          case 'SKIPPED':
            completed++;
            break;
          case 'FAILED':
            failed++;
            break;
          case 'RUNNING':
            running++;
            break;
          default:
            break;
        }
      }
      let progress = 0;
      if (state.tasks.length > 0) {
        progress = (completed / state.tasks.length) * 100;
      }
      const sid = state.id || basename(rel);
      const row: SessionSummaryApi = {
        id: sid,
        name: state.name,
        project_id: pid,
        status: state.status,
        created_at: state.created_at,
        updated_at: state.updated_at,
        task_count: state.tasks.length,
        completed_count: completed,
        failed_count: failed,
        running_count: running,
        progress,
      };
      if (state.scale !== undefined) row.scale = state.scale;
      if (state.mode !== undefined) row.mode = state.mode;
      result.push(row);
    }
    result.sort((a, b) => {
      const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
      const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      return tb - ta;
    });
    return result;
  }

  async getSessionProjectId(id: string): Promise<string> {
    const st = await this.readState(id);
    return effectiveProjectID(st);
  }

  async readSessionFile(id: string, name: string): Promise<string> {
    const v = validateID(id);
    if (v) throw v;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      throw new Error(`invalid file name: ${name}`);
    }
    const rel = await this.findSessionRelPath(id);
    const fp = join(this.root, rel, name);
    try {
      const data = await readFile(fp, 'utf8');
      return data;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return '';
      throw new Error(`read ${name}: ${err.message}`);
    }
  }

  async listLogs(id: string): Promise<LogEntryApi[]> {
    const v = validateID(id);
    if (v) throw v;
    const rel = await this.findSessionRelPath(id);
    const logsDir = join(this.root, rel, 'logs');
    let entries;
    try {
      entries = await readdir(logsDir, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw new Error(`read logs dir: ${err.message}`);
    }
    const result: LogEntryApi[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
      try {
        const st = await stat(join(logsDir, entry.name));
        result.push({
          name: entry.name,
          size: st.size,
          mod_time: formatModTime(st.mtime),
        });
      } catch {
        continue;
      }
    }
    return result;
  }

  async listSnapshots(id: string): Promise<SnapshotEntryApi[]> {
    const v = validateID(id);
    if (v) throw v;
    const rel = await this.findSessionRelPath(id);
    const snapDir = join(this.root, rel, 'snapshots');
    let entries;
    try {
      entries = await readdir(snapDir, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw new Error(`read snapshots dir: ${err.message}`);
    }
    const result: SnapshotEntryApi[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.ref')) continue;
      try {
        const fp = join(snapDir, entry.name);
        const st = await stat(fp);
        let content = '';
        try {
          content = await readFile(fp, 'utf8');
        } catch {
          /* 与 Go 一致：忽略读 ref 正文失败 */
        }
        result.push({
          name: entry.name.replace(/\.ref$/, ''),
          ref: content.trim(),
          mod_time: formatModTime(st.mtime),
        });
      } catch {
        continue;
      }
    }
    return result;
  }

  async validateSession(id: string): Promise<ValidationResult> {
    const v = validateID(id);
    if (v) throw v;
    const state = await this.readState(id);
    const result: ValidationResult = { ok: true, errors: [], warnings: [] };

    for (const t of state.tasks) {
      if (t.depends_on == null) {
        result.errors.push(`${t.id}: depends_on is null`);
      }
      if (t.status === 'COMPLETED' || t.status === 'FAILED') {
        if (t.started_at == null) {
          result.errors.push(`${t.id}: ${t.status} 但无 started_at`);
        }
        if (t.completed_at == null) {
          result.errors.push(`${t.id}: ${t.status} 但无 completed_at`);
        }
        if (!t.log_file) {
          result.warnings.push(`${t.id}: ${t.status} 但无 log_file`);
        }
        if (!t.agent_type) {
          result.warnings.push(`${t.id}: 无 agent_type`);
        }
      }
      if (t.status === 'FAILED' && !t.error) {
        result.errors.push(`${t.id}: FAILED 但无 error 描述`);
      }
    }

    const rel = await this.findSessionRelPath(id);
    const logsDir = join(this.root, rel, 'logs');
    let logCount = 0;
    try {
      const logEntries = await readdir(logsDir);
      for (const name of logEntries) {
        if (name.endsWith('.md')) logCount++;
      }
    } catch {
      /* ignore */
    }
    let doneCount = 0;
    for (const t of state.tasks) {
      if (t.status === 'COMPLETED' || t.status === 'FAILED') doneCount++;
    }
    if (doneCount > 0 && logCount === 0) {
      result.errors.push(`${doneCount} 个 task 已完成但 logs/ 目录为空`);
    }

    result.ok = result.errors.length === 0;
    return result;
  }

  getSessionConfigPayload(raw: Record<string, unknown>): Record<string, unknown> {
    const cfg = raw['config'];
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      return cfg as Record<string, unknown>;
    }
    return {};
  }
}

export function defaultSessionsRoot(): string {
  return (
    process.env['PIPELINE_SESSIONS_DIR'] ??
    process.env['SESSIONS_DIR'] ??
    '/opt/pipeline-orchestrator/sessions'
  );
}
