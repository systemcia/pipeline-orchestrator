import request from './request';
import type { SessionSummary, SessionState, LogEntry, SnapshotEntry } from '@/types/session';

/** 将 API JSON（snake_case）转为与 @pipeline/shared 一致的 camelCase；不改写 `result` 内嵌 map 的键。 */
function keysToCamel<T>(input: unknown): T {
  if (input === null || typeof input !== 'object') {
    return input as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => keysToCamel(item)) as T;
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && key === 'result') {
      out[camelKey] = val;
    } else if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
      out[camelKey] = keysToCamel(val);
    } else {
      out[camelKey] = val;
    }
  }
  return out as T;
}

export const getSessions = () =>
  request<unknown>('/api/sessions').then((raw) => keysToCamel<SessionSummary[]>(raw));

export const getSession = (id: string) =>
  request<unknown>(`/api/sessions/${id}`).then((raw) => keysToCamel<SessionState>(raw));

export const getSessionMD = (id: string) => request<string>(`/api/sessions/${id}/session-md`);

export const getPending = (id: string) => request<string>(`/api/sessions/${id}/pending`);

export const getLogs = (id: string) =>
  request<unknown>(`/api/sessions/${id}/logs`).then((raw) => keysToCamel<LogEntry[]>(raw));

export const getLog = (id: string, name: string) =>
  request<string>(`/api/sessions/${id}/logs/${name}`);

export const getSnapshots = (id: string) =>
  request<unknown>(`/api/sessions/${id}/snapshots`).then((raw) => keysToCamel<SnapshotEntry[]>(raw));

export const deleteSession = (id: string) =>
  request<string>(`/api/sessions/${id}`, { method: 'DELETE' });

export interface ValidationResult {
  ok: boolean;
  errors: string[] | null;
  warnings: string[] | null;
}

export const validateSession = (id: string) =>
  request<ValidationResult>(`/api/sessions/${id}/validate`);

export const getConfig = () => request<Record<string, unknown>>('/api/config');

export interface AnalyticsOverview {
  date_range: string;
  total_days: number;
  total_sessions: number;
  avg_daily_sessions: number;
  daily_trend: { date: string; sessions: number }[];
  project_distribution: { name: string; sessions: number; days: number }[];
  category_distribution: Record<string, number>;
  skill_usage: { name: string; count: number }[];
  daily_summaries: {
    date: string;
    sessions: number;
    projects: string[];
    categories: Record<string, number>;
    summary: string;
  }[];
}

export const getAnalytics = (startDate: string, endDate: string) =>
  request<AnalyticsOverview>(`/api/analytics/overview?start_date=${startDate}&end_date=${endDate}`);

export interface AITrackingSummary {
  total_code_hashes: number;
  daily_usage: { date: string; model: string; source: string; code_hashes: number }[];
  model_distribution: { model: string; count: number }[];
  daily_total: { date: string; sessions: number }[];
  peak_day: string;
  peak_count: number;
  avg_daily: number;
}

export const getAITracking = (startDate: string, endDate: string) =>
  request<AITrackingSummary>(`/api/analytics/ai-tracking?start_date=${startDate}&end_date=${endDate}`);

// Knowledge
export interface KnowledgeChunk {
  id: string; session_id: string; chunk_index: number; project_name: string;
  user_query: string; ai_response_core: string; main_topic: string;
  tags: string; tools_used: string; code_languages: string;
  has_code: boolean; enrichment_status: string; timestamp: number;
}

export interface PromptGem {
  id: string; session_id: string; project_name: string; source: string;
  user_prompt: string; ai_summary: string; quality_score: number;
  quality_tags: string; category: string; timestamp: number;
}

export interface KnowledgeStats {
  total_chunks: number; total_gems: number;
  project_distribution: { project: string; chunks: number; sessions: number }[];
  category_distribution: { category: string; count: number; avg_score: number }[];
}

export const getKnowledgeStats = () => request<KnowledgeStats>('/api/knowledge/stats');
export const getKnowledgeChunks = (project?: string, limit = 20) =>
  request<KnowledgeChunk[]>(`/api/knowledge/chunks?project=${project || ''}&limit=${limit}`);
export const searchKnowledge = (q: string, limit = 10) =>
  request<KnowledgeChunk[]>(`/api/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`);
export const getGems = (category?: string, minScore = 0, limit = 20) =>
  request<PromptGem[]>(`/api/knowledge/gems?category=${category || ''}&min_score=${minScore}&limit=${limit}`);

// Token Stats
export interface TokenStats {
  total_tokens: number; total_sessions: number; avg_per_session: number;
  max_tokens: number; max_session_name: string;
  project_distribution: { project: string; tokens: number; sessions: number }[];
  daily_trend: { date: string; tokens: number; sessions: number }[];
}

export const getTokenStats = (startDate: string, endDate: string) =>
  request<TokenStats>(`/api/knowledge/token-stats?start_date=${startDate}&end_date=${endDate}`);

// Session Search
export interface SessionSearchResult {
  session_id: string; name: string; project_name: string;
  token_count: number; lines_added: number; lines_removed: number;
  created_at: number; match_field: string; match_text: string;
}

export interface SessionContext {
  session_id: string; name: string; project_name: string;
  messages: { type: string; text: string; timestamp: number }[];
  total_messages: number; chunks: KnowledgeChunk[];
}

export const searchSessions = (q: string, project?: string, limit = 20) =>
  request<SessionSearchResult[]>(`/api/search/sessions?q=${encodeURIComponent(q)}&project=${project || ''}&limit=${limit}`);
export const getSessionContext = (sessionId: string) =>
  request<SessionContext>(`/api/search/context/${sessionId}`);
export const getSessionTimeline = (sessionId: string) =>
  request<KnowledgeChunk[]>(`/api/search/timeline/${sessionId}`);
export const findRelatedSessions = (sessionId: string) =>
  request<SessionSearchResult[]>(`/api/search/related/${sessionId}`);

// RAG Search
export interface RagSearchResult {
  query: string; answer_core: string; topic: string;
  tags: string; score: number; source: string;
}
export const ragSearch = (q: string, limit = 5) =>
  request<RagSearchResult[]>('/api/knowledge/rag', {
    method: 'POST',
    body: JSON.stringify({ q, limit }),
  });

// Lessons & Improvements
export const getLessons = (id: string) => request<string>(`/api/sessions/${id}/lessons`);
export const getImprovements = (id: string) => request<string>(`/api/sessions/${id}/improvements`);

// Requirement Tracking
export const getAnalysisTrace = (id: string) => request<string>(`/api/sessions/${id}/analysis-trace`);
export const getDesignBrief = (id: string) => request<string>(`/api/sessions/${id}/design-brief`);

// OpenSpec Info
export interface OpenSpecInfo {
  name: string;
  status: 'active' | 'archived';
  hasProposal: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
}
export const getOpenSpecInfo = (id: string) =>
  request<unknown>(`/api/sessions/${id}/openspec-info`)
    .then((raw) => raw ? keysToCamel<OpenSpecInfo>(raw) : null);

// Session Repair & Complete
export const repairSessionDocs = (id: string) =>
  request<{ repaired: string[]; message: string }>(`/api/sessions/${id}/repair-docs`, { method: 'POST' });

export const completeSession = (id: string) =>
  request<{ ok: boolean; message: string }>(`/api/sessions/${id}/complete`, { method: 'POST' });

// Pipeline Trend
export interface FailedTaskDetail {
  session_id: string; session_name: string;
  task_id: string; task_name: string;
  error: string; date: string;
}
export interface PipelineTrend {
  total_sessions: number; completed_sessions: number;
  failed_tasks: number; total_tasks: number;
  avg_tasks_per_session: number; task_fail_rate: number;
  top_failures: { error: string; count: number }[];
  failed_task_details?: FailedTaskDetail[];
  session_trend: { date: string; sessions: number; tasks: number; failed: number }[];
}
export const getPipelineTrend = () => request<PipelineTrend>('/api/analytics/pipeline-trend');
