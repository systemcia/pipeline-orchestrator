import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/** 将路径中的 `~` 展开为 os.homedir()。 */
function expandUserPath(p: string): string {
  if (p === '~') {
    return homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * 解析 Pipeline 主库路径（不检测文件是否存在）。
 * 优先级：PIPELINE_DATA_DB > $PIPELINE_SESSIONS_DIR/pipeline.db > /opt/pipeline-orchestrator/sessions/pipeline.db
 */
export function resolvePipelineDbPath(): string {
  const explicit = process.env['PIPELINE_DATA_DB']?.trim();
  if (explicit) {
    return expandUserPath(explicit);
  }
  const sessionsDir = process.env['PIPELINE_SESSIONS_DIR']?.trim();
  if (sessionsDir) {
    return join(expandUserPath(sessionsDir), 'pipeline.db');
  }
  return '/opt/pipeline-orchestrator/sessions/pipeline.db';
}

/**
 * 每次调用检测文件是否存在并只读打开；不缓存连接，便于热检测。
 * 文件不存在返回 null，由调用方降级处理。
 */
export function openPipelineDb(): DatabaseSync | null {
  const dbPath = resolvePipelineDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * 以读写模式打开 Pipeline 主库。写操作（INSERT/UPDATE/DELETE）必须用此函数。
 */
export function openPipelineDbRW(): DatabaseSync | null {
  const dbPath = resolvePipelineDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  return new DatabaseSync(dbPath);
}

/**
 * 以只读方式打开 SQLite（使用 Node.js 内置 node:sqlite）。
 * API 与 better-sqlite3 兼容（同步 prepare/all/get）。
 * 调用方负责 close()。
 */
export function getDb(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite file not found: ${dbPath}`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 转义 SQL LIKE 通配符。 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
