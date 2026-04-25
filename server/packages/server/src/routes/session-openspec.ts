import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionFsService } from './session-detail.js';

export interface OpenSpecInfoApi {
  name: string;
  status: 'active' | 'archived';
  has_proposal: boolean;
  has_design: boolean;
  has_tasks: boolean;
}

export interface RepairResult {
  repaired: string[];
  message: string;
}

async function tryReadFile(fp: string): Promise<string> {
  try { return await readFile(fp, 'utf8'); } catch { return ''; }
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * OpenSpec 关联服务，负责：
 * - 解析 session 对应的 OpenSpec change 目录（含 archive 降级）
 * - 提供需求追踪 / 设计简报的 fallback 读取
 * - 文档补全与 state.json 修复
 */
export class SessionOpenSpecService {
  private rootsCache: string[] | null = null;
  private rootsCacheTs = 0;

  constructor(private readonly svc: SessionFsService, private readonly sessionsRoot: string) {}

  private resolveChangeName(raw: Record<string, unknown>): string {
    return ((raw['openspec_change'] as string) ?? '').trim()
      || ((raw['name'] as string) ?? '').trim();
  }

  private async findChangeInRoot(root: string, change: string): Promise<string | null> {
    const active = resolve(root, 'openspec', 'changes', change);
    if (await pathExists(active)) return active;

    const archiveDir = resolve(root, 'openspec', 'changes', 'archive');
    const archivePattern = /^\d{4}-\d{2}-\d{2}-/;
    try {
      const entries = await readdir(archiveDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || !archivePattern.test(e.name)) continue;
        if (e.name.slice(11) === change) return join(archiveDir, e.name);
      }
    } catch { /* archive dir doesn't exist */ }
    return null;
  }

  private async collectKnownRoots(): Promise<string[]> {
    const now = Date.now();
    if (this.rootsCache && now - this.rootsCacheTs < 60_000) return this.rootsCache;

    const rels = await this.svc.collectSessionRelPaths();
    const roots = new Set<string>();
    for (const rel of rels) {
      try {
        const r = await this.svc.readStateByRel(rel);
        const v = ((r['openspec_repo_root'] as string) ?? '').trim();
        if (v) roots.add(v);
      } catch { continue; }
    }
    this.rootsCache = [...roots];
    this.rootsCacheTs = now;
    return this.rootsCache;
  }

  private async resolveDir(raw: Record<string, unknown>): Promise<string | null> {
    const change = this.resolveChangeName(raw);
    if (!change) return null;

    const explicitRoot = ((raw['openspec_repo_root'] as string) ?? '').trim();
    if (explicitRoot) {
      const found = await this.findChangeInRoot(explicitRoot, change);
      if (found) return found;
    }

    for (const r of await this.collectKnownRoots()) {
      const found = await this.findChangeInRoot(r, change);
      if (found) return found;
    }
    return null;
  }

  async getInfo(id: string): Promise<OpenSpecInfoApi | null> {
    const rel = await this.svc.findSessionRelPath(id);
    const raw = await this.svc.readStateByRel(rel);
    const change = this.resolveChangeName(raw);
    if (!change) return null;
    const dir = await this.resolveDir(raw);
    if (!dir) return null;
    return {
      name: change,
      status: dir.includes('/archive/') ? 'archived' : 'active',
      has_proposal: await pathExists(join(dir, 'proposal.md')),
      has_design: await pathExists(join(dir, 'design.md')),
      has_tasks: await pathExists(join(dir, 'tasks.md')),
    };
  }

  async readAnalysisTrace(id: string): Promise<string> {
    const rel = await this.svc.findSessionRelPath(id);
    const content = await this.svc.readFileByRel(rel, 'analysis-trace.md');
    if (content) return content;

    const raw = await this.svc.readStateByRel(rel);
    const dir = await this.resolveDir(raw);
    if (!dir) return '';
    return this.buildAnalysisTraceContent(dir, 'OpenSpec 自动生成');
  }

  async readDesignBrief(id: string): Promise<string> {
    const rel = await this.svc.findSessionRelPath(id);
    const content = await this.svc.readFileByRel(rel, 'design-brief.md');
    if (content) return content;

    const raw = await this.svc.readStateByRel(rel);
    const dir = await this.resolveDir(raw);
    if (!dir) return '';
    const design = await tryReadFile(join(dir, 'design.md'));
    if (!design) return '';
    return `# 设计简报（OpenSpec 自动生成）\n\n${design}`;
  }

  async repairDocs(id: string): Promise<RepairResult> {
    const rel = await this.svc.findSessionRelPath(id);
    const sessionDir = join(this.sessionsRoot, rel);
    const statePath = join(sessionDir, 'state.json');
    const stateData = await readFile(statePath, 'utf8');
    const state = JSON.parse(stateData) as Record<string, unknown>;
    const repaired: string[] = [];

    const existingTrace = await this.svc.readFileByRel(rel, 'analysis-trace.md');
    const existingBrief = await this.svc.readFileByRel(rel, 'design-brief.md');

    const dir = await this.resolveDir(state);

    if (dir) {
      if (!existingTrace) {
        const md = await this.buildAnalysisTraceContent(dir, 'OpenSpec 补全');
        if (md) {
          await writeFile(join(sessionDir, 'analysis-trace.md'), md, 'utf8');
          repaired.push('analysis-trace.md');
        }
      }

      if (!existingBrief) {
        const design = await tryReadFile(join(dir, 'design.md'));
        if (design) {
          await writeFile(join(sessionDir, 'design-brief.md'), `# 设计简报（OpenSpec 补全）\n\n${design}`, 'utf8');
          repaired.push('design-brief.md');
        }
      }

      const change = this.resolveChangeName(state);
      if (!((state['openspec_change'] as string) ?? '').trim() && change) {
        state['openspec_change'] = change;
        state['openspec_repo_root'] = dir.replace(/\/openspec\/changes\/.*$/, '');
        state['updated_at'] = new Date().toISOString();
        await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
        repaired.push('state.json (openspec_change)');
      }
    } else if (!existingTrace) {
      const sessionMd = await this.svc.readFileByRel(rel, 'session.md');
      const contextMd = await this.svc.readFileByRel(rel, 'context.md');
      if (sessionMd || contextMd) {
        const parts: string[] = ['# 需求追踪（增强编排补全）\n'];
        if (contextMd) { parts.push('## 项目上下文\n'); parts.push(contextMd); }
        if (sessionMd) { parts.push('\n## 会话记录\n'); parts.push(sessionMd); }
        await writeFile(join(sessionDir, 'analysis-trace.md'), parts.join('\n'), 'utf8');
        repaired.push('analysis-trace.md');
      }
    }

    if (repaired.length === 0) {
      return { repaired, message: '无需补全，文档已完整或无可用数据源' };
    }
    return { repaired, message: `已补全: ${repaired.join(', ')}` };
  }

  private async buildAnalysisTraceContent(dir: string, source: string): Promise<string> {
    const proposal = await tryReadFile(join(dir, 'proposal.md'));
    const tasks = await tryReadFile(join(dir, 'tasks.md'));
    if (!proposal && !tasks) return '';
    const parts: string[] = [`# 需求追踪（${source}）\n`];
    if (proposal) { parts.push('## 提案摘要\n'); parts.push(proposal); }
    if (tasks) { parts.push('\n## 任务清单\n'); parts.push(tasks); }
    return parts.join('\n');
  }
}
