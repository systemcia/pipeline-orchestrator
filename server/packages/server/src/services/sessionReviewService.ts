import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openPipelineDbRW } from '../db.js';

const generatingSet = new Set<string>();

export class SessionReviewService {
  constructor(private sessionsRoot: string) {}

  isGenerating(sessionId: string): boolean {
    return generatingSet.has(sessionId);
  }

  async generate(sessionId: string): Promise<void> {
    if (generatingSet.has(sessionId)) {
      throw new Error('review already in progress');
    }
    generatingSet.add(sessionId);
    try {
      await this._doGenerate(sessionId);
    } finally {
      generatingSet.delete(sessionId);
    }
  }

  private async _doGenerate(sessionId: string): Promise<void> {
    const sessDir = await this._findSessionDir(sessionId);
    if (!sessDir) throw new Error(`session dir not found: ${sessionId}`);

    const artifacts = await this._collectArtifacts(sessDir);
    if (!artifacts) throw new Error('insufficient artifacts for review');

    const apiBase = process.env['OPENAI_API_BASE_URL'] || process.env['OPENAI_BASE_URL'];
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiBase || !apiKey) throw new Error('OPENAI_API_BASE_URL and OPENAI_API_KEY required');

    const model = process.env['OPENAI_MODEL'] || 'gpt-4o';

    const systemPrompt = `你是一个资深的 AI 编排会话分析师。你的任务是从编排 session 的产出物中客观复盘，提取经验教训和改进建议。

要求：
1. 不美化失败，如实记录问题
2. 建议必须可落地，指向具体路径或模块
3. 禁止编造未发生的事件
4. 经验必须可检索，带场景和标签`;

    const userPrompt = `请分析以下编排 session 的产出物，生成两部分内容：

## 第一部分：经验总结（lessons）
包含：成功模式、失败模式与根因、关键经验（带标签）、成本与效率分析

## 第二部分：改进建议（improvements）  
包含：失败模式 Top-N、可执行改进项（含问题、建议、目标文件、优先级、预期效果）

请用两个一级标题 "# 经验总结" 和 "# 改进建议" 分隔两部分。

--- 产出物 ---

${artifacts}`;

    const base = apiBase.replace(/\/$/, '');
    const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('empty LLM response');

    const { lessons, improvements } = this._splitResponse(content);

    await writeFile(join(sessDir, 'lessons.md'), lessons, 'utf-8');
    if (improvements.length > 10) {
      await writeFile(join(sessDir, 'improvements.md'), improvements, 'utf-8');
    }

    this._writeToKnowledgeDb(sessionId, sessDir, lessons, improvements);
  }

  private _splitResponse(content: string): { lessons: string; improvements: string } {
    const improvIdx = content.indexOf('# 改进建议');
    if (improvIdx > 0) {
      return {
        lessons: content.slice(0, improvIdx).trim(),
        improvements: content.slice(improvIdx).trim(),
      };
    }
    return { lessons: content, improvements: '' };
  }

  private _writeToKnowledgeDb(sessionId: string, sessDir: string, lessons: string, improvements: string): void {
    const db = openPipelineDbRW();
    if (!db) return;
    try {
      let projectId = '_default';
      try {
        const stateRaw = readFileSync(join(sessDir, 'state.json'), 'utf-8');
        const state = JSON.parse(stateRaw);
        projectId = state.project_id || '_default';
      } catch {}

      const now = Date.now();
      for (const [fileType, content] of [['lessons', lessons], ['improvements', improvements]] as const) {
        if (!content || content.length < 20) continue;
        const sections = content.split(/\n(?=## )/);
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i]?.trim();
          if (!section || section.length < 10) continue;
          const chunkId = createHash('sha256').update(`review:${sessionId}:${fileType}:${i}`).digest('hex').slice(0, 32);
          const contentHash = createHash('md5').update(section).digest('hex');
          const titleMatch = section.match(/^##?\s+(.+)/);
          const topic = titleMatch?.[1]?.slice(0, 50) || fileType;
          const tags = fileType === 'improvements'
            ? JSON.stringify(['review', 'improvement'])
            : JSON.stringify(['review', fileType]);
          try {
            db.prepare(`INSERT OR IGNORE INTO rag_knowledge_chunks
              (id, session_id, chunk_index, project_id, project_name,
               user_query, ai_response_core, vector_text,
               has_code, timestamp, content_hash, source, main_topic, tags)
              VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?)`).run(
              chunkId, sessionId, i, projectId, projectId,
              topic, section.slice(0, 2000), `${topic}\n${section.slice(0, 2000)}`,
              0, now, contentHash, 'review', topic, tags,
            );
          } catch (e) {
            console.warn(`[review-db] chunk insert failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }

  private _findSessionDir(sessionId: string): string | null {
    if (!existsSync(this.sessionsRoot)) return null;
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(this.sessionsRoot, entry.name);
      if (entry.name === sessionId) return p;
      try {
        for (const sub of readdirSync(p, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name === sessionId) return join(p, sub.name);
        }
      } catch {}
    }
    return null;
  }

  private async _collectArtifacts(sessDir: string): Promise<string | null> {
    const parts: string[] = [];

    for (const file of ['session.md', 'context.md', 'state.json', 'pending.md', 'analysis-trace.md']) {
      try {
        const content = await readFile(join(sessDir, file), 'utf-8');
        if (content.trim()) parts.push(`### ${file}\n\n${content.slice(0, 3000)}`);
      } catch {}
    }

    try {
      const logsDir = join(sessDir, 'logs');
      const logFiles = await readdir(logsDir);
      for (const lf of logFiles.filter(f => f.endsWith('.md')).slice(0, 10)) {
        try {
          const content = await readFile(join(logsDir, lf), 'utf-8');
          if (content.trim()) parts.push(`### logs/${lf}\n\n${content.slice(0, 1500)}`);
        } catch {}
      }
    } catch {}

    return parts.length >= 2 ? parts.join('\n\n---\n\n') : null;
  }
}
