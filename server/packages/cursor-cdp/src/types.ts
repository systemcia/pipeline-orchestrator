export type WindowType = "Agent" | "Editor";

export type RunSkillStatus = "complete" | "timeout" | "blocked" | "error";

export type AttachmentType = "image" | "file" | "url";

export interface Attachment {
  type: AttachmentType;
  source: string;
}

export interface WindowInfo {
  idx: number;
  type: WindowType;
  title: string;
  project: string;
}

export interface CursorCdpConfig {
  default_port: number;
  /** CDP 主机地址，默认 localhost；WSL 连 Windows Cursor 时需设为 Windows 主机 IP */
  cdp_host: string;
  default_model?: string;
  default_timeout: number;
  /** continue_chat 会话空闲超时（秒），超时后自动新建对话防止上下文污染，默认 3600 */
  session_timeout: number;
  /** 日志目录，默认 ~/.cursor-cdp/logs/ */
  log_dir?: string;
}

export interface ConnectionState {
  connected: boolean;
  port: number;
  lastHealthCheck?: Date;
}

export type CompletionSignal = "dom_ready" | "status_clear" | "blocked" | "timeout";

export interface CompletionResult {
  signal: CompletionSignal;
  elapsed_ms: number;
  blocked_reason?: string;
}

export interface RunSkillInput {
  project: string;
  skill?: string;
  prompt: string;
  attachments?: Attachment[];
  model?: string;
  port?: number;
  timeout?: number;
  screenshot?: boolean;
}

export interface RunSkillOutput {
  status: RunSkillStatus;
  response: string;
  duration_ms: number;
  truncated?: boolean;
  /** 会话因超时被自动回收，已新建对话（仅 continue_chat 场景） */
  new_session?: boolean;
  screenshot_path?: string;
  blocked_reason?: string;
  error?: string;
}

export interface RawSendInput {
  prompt: string;
  port?: number;
}

export interface RawSendOutput {
  ok: boolean;
  error?: string;
}

export interface ReadInput {
  port?: number;
}

export interface ReadOutput {
  conversation: string;
  last_message: string;
  message_count: number;
}

export interface StatusInput {
  port?: number;
}

export interface StatusOutput {
  connected: boolean;
  project: string;
  model: string;
  window_type: WindowType;
  busy: boolean;
}

export interface ScreenshotInput {
  path?: string;
  port?: number;
}

export interface ScreenshotOutput {
  saved_to: string;
}

export interface SwitchProjectInput {
  project: string;
  port?: number;
}

export interface SwitchProjectOutput {
  ok: boolean;
  current: string;
  error?: string;
}

export interface SwitchModelInput {
  model: string;
  port?: number;
}

export interface SwitchModelOutput {
  ok: boolean;
  current: string;
  error?: string;
}

export interface NewChatInput {
  port?: number;
}

export interface NewChatOutput {
  ok: boolean;
}

export interface ContinueChatInput {
  prompt: string;
  timeout?: number;
  /** 会话空闲超时（秒），超过此时间自动新建对话，默认取 config.session_timeout */
  session_timeout?: number;
  port?: number;
  screenshot?: boolean;
}

export type ContinueChatOutput = RunSkillOutput;

export interface ListWindowsInput {
  port?: number;
}

export interface ListWindowsOutput {
  windows: WindowInfo[];
}
