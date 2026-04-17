/**
 * Pipeline Orchestrator 共享领域类型。
 * 与 Go `server/model`、JSON state/telemetry 及前端消费形状对齐；属性名为 camelCase。
 */

/** 兼容多种 ISO8601 序列化形式的时间；零值在 JSON 中为 null。 */
export type FlexTime = string | null;

/** 流水线会话生命周期状态（与 Go SessionStatus、state.json 一致）。 */
export type SessionStatus =
  | 'PLANNING'
  | 'PROPOSING'
  | 'APPLYING'
  | 'VERIFYING'
  | 'ARCHIVING'
  | 'COMPLETED'
  | 'ARCHIVED'
  | 'PAUSED'
  | 'FAILED';

/** 单个 task 在 DAG 中的执行状态（与 Go TaskStatus、state.json 一致）。 */
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

/** 编排与会话级配置（对齐 Go model.Config）。 */
export interface SessionConfig {
  /** 最大并行 SubAgent / task 数 */
  maxParallel: number;
  /** 超时（分钟） */
  timeoutMinutes: number;
  /** 可选：Skill 扫描目录 */
  skillScanDirs?: string[];
}

/** 单个编排 task 的快照（对齐 Go model.Task；部分字段由 engine 在 state.json 中扩展）。 */
export interface Task {
  id: string;
  name: string;
  description?: string;
  status: TaskStatus;
  tier: string;
  /** 使用的 Skill 名；无则为 null */
  skill: string | null;
  agentType: string;
  dependsOn: string[];
  startedAt?: FlexTime;
  completedAt?: FlexTime;
  error?: string;
  /** 完整快照正文（与 snapshotRef 二选一语义，见 GetSnapshot） */
  snapshot?: string;
  /** 快照引用路径（engine 可能只写此字段） */
  snapshotRef?: string;
  /** 相对会话目录的日志文件路径 */
  logFile?: string;
  corrections: number;
  /** engine 写入的 OpenSpec task 关联（Go 静态模型外扩展） */
  openspecTaskId?: string;
  /** engine 写入的负责 glob 模式 */
  ownsGlobs?: string[];
}

/** RAG 检索记录（对齐 Go model.RagQuery）。 */
export interface RagQuery {
  query: string;
  resultsCount: number;
  timestamp: string;
}

/** 上下文一致性校验结果条目（对齐 Go model.ConsistencyCheck）。 */
export interface ConsistencyCheck {
  type: string;
  tid?: string;
  result: Record<string, unknown>;
  timestamp: string;
}

/** 质量门测试结果条目（对齐 Go model.TestResult）。 */
export interface TestResult {
  type: string;
  result: Record<string, unknown>;
  timestamp: string;
}

/** 完整会话状态，含 tasks 与可选遥测摘要字段（对齐 Go model.SessionState）。 */
export interface SessionState {
  id: string;
  name: string;
  projectId?: string;
  status: SessionStatus;
  scale?: string;
  mode?: string;
  openspecChange?: string;
  createdAt: FlexTime;
  updatedAt: FlexTime;
  config: SessionConfig;
  tasks: Task[];
  ragQueries?: RagQuery[];
  consistencyChecks?: ConsistencyCheck[];
  testResults?: TestResult[];
}

/** 会话列表行摘要（对齐 Go model.SessionSummary）。 */
export interface SessionSummary {
  id: string;
  name: string;
  projectId?: string;
  status: SessionStatus;
  scale?: string;
  mode?: string;
  createdAt: FlexTime;
  updatedAt: FlexTime;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  progress: number;
}

/** 会话日志目录中的文件项（对齐 Go model.LogEntry）。 */
export interface LogEntry {
  name: string;
  size: number;
  modTime: string;
}

/** 会话 snapshots 目录中的条目（对齐 Go model.SnapshotEntry）。 */
export interface SnapshotEntry {
  name: string;
  ref: string;
  modTime: string;
}

/** 会话校验 API 返回（对齐 Go model.ValidationResult）。 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** telemetry.jsonl 中 `event` 取值（对齐 references/session-format.md）。 */
export type TelemetryEventKind = 'start' | 'done' | 'fail';

/** 任务级遥测 JSONL 单行事件（engine `_append_telemetry` 在 payload 外合并 `ts_iso`）。 */
export interface TelemetryEvent {
  /** 记录写入时的 ISO8601 时间（JSON 字段 `ts_iso`） */
  tsIso: string;
  event: TelemetryEventKind;
  tid: string;
  sessionId: string;
  /** done/fail 时由引擎计算的耗时（毫秒） */
  durationMs?: number;
  /** fail 时错误分类 */
  errorClass?: string;
  /** fail 时错误摘要片段 */
  error?: string;
  /** done 时结果摘要，如 COMPLETED */
  outcome?: string;
  tokensIn?: number;
  tokensOut?: number;
  corrections?: number;
  filesChanged?: number;
  agentType?: string;
  skill?: string;
}

/** 分析看板「按日趋势」点（对齐 Go AnalyticsOverview.DailyTrend）。 */
export interface AnalyticsDailyPoint {
  date: string;
  sessions: number;
}

/** 项目维度会话分布（对齐 Go ProjectStat）。 */
export interface AnalyticsProjectStat {
  name: string;
  sessions: number;
  days: number;
}

/** 单日摘要块（对齐 Go DaySummary）。 */
export interface AnalyticsDaySummary {
  date: string;
  sessions: number;
  projects: string[];
  categories: Record<string, number>;
  summary: string;
}

/** Skill 使用次数统计（对齐 Go SkillStat）。 */
export interface AnalyticsSkillStat {
  name: string;
  count: number;
}

/** 分析概览聚合（对齐 Go service.AnalyticsOverview）。 */
export interface AnalyticsOverview {
  dateRange: string;
  totalDays: number;
  totalSessions: number;
  avgDailySessions: number;
  dailyTrend: AnalyticsDailyPoint[];
  projectDistribution: AnalyticsProjectStat[];
  categoryDistribution: Record<string, number>;
  dailySummaries: AnalyticsDaySummary[];
  skillUsage: AnalyticsSkillStat[];
}

/** 知识库 RAG 片段（对齐 Go service.KnowledgeChunk）。 */
export interface KnowledgeChunk {
  id: string;
  sessionId: string;
  chunkIndex: number;
  projectName: string;
  userQuery: string;
  aiResponseCore: string;
  mainTopic: string;
  tags: string;
  toolsUsed: string;
  codeLanguages: string;
  hasCode: boolean;
  enrichmentStatus: string;
  timestamp: number;
}

/**
 * 精炼搜索结果（对齐 Go RagSearchResult；用于 `/api/knowledge/rag-search` 等）。
 * 与「会话关键词搜索」的 {@link SessionSearchResult} 区分。
 */
export interface SearchResult {
  query: string;
  answerCore: string;
  topic: string;
  tags: string;
  score: number;
  source: string;
}

/** 同 {@link SearchResult}，便于与既有前端命名对齐。 */
export type RagSearchResult = SearchResult;

/** 会话关键词 / 知识命中搜索返回行（对齐 Go SessionSearchResult）。 */
export interface SessionSearchResult {
  sessionId: string;
  name: string;
  projectName: string;
  tokenCount: number;
  linesAdded: number;
  linesRemoved: number;
  createdAt: number;
  matchField: string;
  matchText: string;
}
