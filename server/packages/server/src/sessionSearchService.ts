import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { escapeLike } from './db.js';

type SqliteDatabase = DatabaseSync;

type Row = {
  session_id: string;
  name: string;
  project_name?: string;
  token_count: number;
  lines_added: number;
  lines_removed: number;
  created_at: number;
  match_text?: string;
};

export type KnowledgeChunk = {
  id: string;
  session_id: string;
  chunk_index: number;
  project_name: string;
  user_query: string;
  ai_response_core: string;
  main_topic: string;
  tags: string;
  tools_used: string;
  code_languages: string;
  has_code: boolean;
  enrichment_status: string;
  timestamp: number;
};

function toChunk(r: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(r['id']),
    session_id: String(r['session_id']),
    chunk_index: Number(r['chunk_index']),
    project_name: String(r['project_name'] ?? ''),
    user_query: String(r['user_query'] ?? ''),
    ai_response_core: String(r['ai_response_core'] ?? ''),
    main_topic: String(r['main_topic'] ?? ''),
    tags: String(r['tags'] ?? ''),
    tools_used: String(r['tools_used'] ?? ''),
    code_languages: String(r['code_languages'] ?? ''),
    has_code: Boolean(r['has_code']),
    enrichment_status: String(r['enrichment_status'] ?? ''),
    timestamp: Number(r['timestamp']),
  };
}

const CHUNK_SQL =
  'SELECT id,session_id,chunk_index,project_name,user_query,ai_response_core,COALESCE(main_topic,\'\') main_topic,COALESCE(tags,\'\') tags,COALESCE(tools_used,\'\') tools_used,COALESCE(code_languages,\'\') code_languages,has_code,enrichment_status,timestamp FROM rag_knowledge_chunks WHERE session_id=? ORDER BY chunk_index';

const SESSION_FILE_INDEX_SQL =
  'SELECT file_path, source_type FROM session_file_index WHERE session_id = ?';

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        if (o['type'] === 'text' && typeof o['text'] === 'string') parts.push(o['text']);
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return parts.join('\n');
  }
  return content != null && content !== '' ? String(content) : '';
}

function parseTranscriptMessageField(rawMsg: unknown): string {
  if (typeof rawMsg === 'string') {
    const s = rawMsg.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const pr = parsed as Record<string, unknown>;
          return extractTextFromContent(pr['content'] ?? rawMsg);
        }
        if (Array.isArray(parsed)) {
          return extractTextFromContent(parsed);
        }
      } catch {
        /* 非合法 JSON，保留原串 */
      }
    }
    return rawMsg;
  }
  if (rawMsg && typeof rawMsg === 'object' && !Array.isArray(rawMsg)) {
    const rm = rawMsg as Record<string, unknown>;
    return extractTextFromContent(rm['content'] ?? '');
  }
  return rawMsg != null ? String(rawMsg) : '';
}

function loadMessagesFromJsonlPath(filePath: string): { type: string; text: string; timestamp: number }[] {
  if (!existsSync(filePath)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = Math.trunc(statSync(filePath).mtimeMs);
  } catch {
    mtimeMs = 0;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: { type: string; text: string; timestamp: number }[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i];
    if (lineRaw === undefined) continue;
    let line = lineRaw.trim();
    if (!line) continue;
    if (i === 0 && line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const o = rec as Record<string, unknown>;
    const role = o['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const text = parseTranscriptMessageField(o['message']).trim();
    if (!text) continue;
    let ts = mtimeMs;
    if (typeof o['timestamp'] === 'number' && Number.isFinite(o['timestamp'])) {
      ts = o['timestamp'];
    }
    out.push({ type: role, text, timestamp: ts });
  }
  return out;
}

export function searchSessions(db: SqliteDatabase, q: string, project: string, limit: number) {
  const esc = escapeLike(q);
  const seen = new Set<string>();
  const out: {
    session_id: string;
    name: string;
    project_name: string;
    token_count: number;
    lines_added: number;
    lines_removed: number;
    created_at: number;
    match_field: string;
    match_text: string;
  }[] = [];
  const add = (r: Row, field: string, text: string) => {
    if (seen.has(r.session_id)) return;
    seen.add(r.session_id);
    out.push({
      session_id: r.session_id,
      name: r.name ?? '',
      project_name: r.project_name ?? '',
      token_count: Number(r.token_count),
      lines_added: Number(r.lines_added),
      lines_removed: Number(r.lines_removed),
      created_at: Number(r.created_at),
      match_field: field,
      match_text: text,
    });
  };
  const nSql =
    "SELECT composer_id session_id,COALESCE(name,'') name,token_count,total_lines_added lines_added,total_lines_removed lines_removed,created_at FROM workspace_sessions WHERE name LIKE ? ESCAPE '\\' AND token_count>0 ORDER BY created_at DESC LIMIT ?";
  try {
    for (const r of db.prepare(nSql).all(`%${esc}%`, limit) as Row[]) add(r, 'name', r.name);
  } catch {
    /* 与 Go 一致：name 路失败不阻断 */
  }
  let cSql =
    "SELECT DISTINCT k.session_id session_id,COALESCE(ws.name,'') name,COALESCE(k.project_name,'') project_name,COALESCE(ws.token_count,0) token_count,COALESCE(ws.total_lines_added,0) lines_added,COALESCE(ws.total_lines_removed,0) lines_removed,COALESCE(ws.created_at,0) created_at,k.user_query match_text FROM rag_knowledge_chunks k LEFT JOIN workspace_sessions ws ON k.session_id=ws.composer_id WHERE k.user_query LIKE ? ESCAPE '\\'";
  const args: (string | number)[] = [`%${esc}%`];
  if (project) {
    cSql += ' AND k.project_name=?';
    args.push(project);
  }
  cSql += ' ORDER BY k.timestamp DESC LIMIT ?';
  args.push(limit);
  try {
    for (const r of db.prepare(cSql).all(...args) as Row[]) add(r, 'query', String(r.match_text ?? ''));
  } catch {
    /* ignore */
  }
  return out.length > limit ? out.slice(0, limit) : out;
}

export function loadSessionContext(db: SqliteDatabase | null, sessionId: string) {
  const ctx = {
    session_id: sessionId,
    name: '',
    project_name: '',
    messages: [] as { type: string; text: string; timestamp: number }[],
    total_messages: 0,
    chunks: [] as KnowledgeChunk[],
  };
  if (db) {
    try {
      const row = db.prepare(SESSION_FILE_INDEX_SQL).get(sessionId) as
        | { file_path?: string; source_type?: string }
        | undefined;
      if (row?.source_type === 'jsonl' && row.file_path) {
        ctx.messages = loadMessagesFromJsonlPath(row.file_path);
        ctx.total_messages = ctx.messages.length;
      }
    } catch {
      /* 表不存在或查询失败：messages 保持空 */
    }
    try {
      ctx.chunks = (db.prepare(CHUNK_SQL).all(sessionId) as Record<string, unknown>[]).map(toChunk);
      if (!ctx.project_name && ctx.chunks[0]) ctx.project_name = ctx.chunks[0].project_name;
    } catch {
      /* ignore */
    }
  }
  return ctx;
}

export function timelineChunks(db: SqliteDatabase, sessionId: string): KnowledgeChunk[] {
  return (db.prepare(CHUNK_SQL).all(sessionId) as Record<string, unknown>[]).map(toChunk);
}

export function relatedSessions(db: SqliteDatabase, sessionId: string, limit: number): Row[] {
  const meta = db
    .prepare(
      "SELECT COALESCE(k.project_name,'') pn FROM rag_knowledge_chunks k LEFT JOIN workspace_sessions ws ON k.session_id=ws.composer_id WHERE k.session_id=? LIMIT 1",
    )
    .get(sessionId) as { pn?: string } | undefined;
  const pn = meta?.pn ?? '';
  if (!pn) return [];
  const sql =
    "SELECT DISTINCT k.session_id session_id,COALESCE(ws.name,'') name,k.project_name project_name,COALESCE(ws.token_count,0) token_count,COALESCE(ws.total_lines_added,0) lines_added,COALESCE(ws.total_lines_removed,0) lines_removed,COALESCE(ws.created_at,0) created_at FROM rag_knowledge_chunks k LEFT JOIN workspace_sessions ws ON k.session_id=ws.composer_id WHERE k.project_name=? AND k.session_id!=? ORDER BY ws.created_at DESC LIMIT ?";
  return db.prepare(sql).all(pn, sessionId, limit) as Row[];
}
