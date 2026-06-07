import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const RETENTION_DAYS = 7;
const LOG_FILE_PREFIX = "cursor-cdp-";
const DEFAULT_LOG_DIR = path.join(os.homedir(), ".cursor-cdp", "logs");

function resolveLogDir(logDir?: string): string {
  if (!logDir) {
    return DEFAULT_LOG_DIR;
  }
  if (logDir === "~") {
    return os.homedir();
  }
  if (logDir.startsWith("~/")) {
    return path.join(os.homedir(), logDir.slice(2));
  }
  return logDir;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  logDir?: string;
}

export class Logger {
  private level: LogLevel;
  private logDir: string;
  private currentDate = "";
  private fileStream: fs.WriteStream | null = null;
  private initialized = false;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.logDir = options.logDir ?? DEFAULT_LOG_DIR;
  }

  debug(component: string, message: string, data?: unknown): void {
    this.write("debug", component, message, data);
  }

  info(component: string, message: string, data?: unknown): void {
    this.write("info", component, message, data);
  }

  warn(component: string, message: string, data?: unknown): void {
    this.write("warn", component, message, data);
  }

  error(component: string, message: string, data?: unknown): void {
    this.write("error", component, message, data);
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.cleanupOldLogs();
    this.openLogFile();
  }

  private cleanupOldLogs(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    try {
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        const match = file.match(/^cursor-cdp-(\d{4}-\d{2}-\d{2})\.log$/);
        if (!match) {
          continue;
        }
        const fileDate = match[1];
        if (fileDate && fileDate < cutoffStr) {
          fs.unlinkSync(path.join(this.logDir, file));
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  private getTodayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private openLogFile(): void {
    this.currentDate = this.getTodayDate();
    const filePath = path.join(this.logDir, `${LOG_FILE_PREFIX}${this.currentDate}.log`);
    this.fileStream = fs.createWriteStream(filePath, { flags: "a" });
    this.fileStream.on("error", () => {
      this.fileStream = null;
    });
  }

  private rotateIfNeeded(): void {
    const today = this.getTodayDate();
    if (today === this.currentDate) {
      return;
    }
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
    this.openLogFile();
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private write(level: LogLevel, component: string, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    this.ensureInitialized();
    this.rotateIfNeeded();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
    };
    if (data !== undefined) {
      entry.data = data;
    }

    const line = JSON.stringify(entry) + "\n";
    process.stderr.write(line);

    if (this.fileStream && !this.fileStream.destroyed) {
      this.fileStream.write(line);
    }
  }
}

let loggerInstance: Logger | null = null;

function getLoggerInstance(): Logger {
  if (!loggerInstance) {
    const config = loadConfig();
    loggerInstance = new Logger({
      logDir: resolveLogDir(config.log_dir),
    });
  }
  return loggerInstance;
}

export const logger = new Proxy({} as Logger, {
  get(_target, prop: string) {
    const instance = getLoggerInstance();
    const value = instance[prop as keyof Logger];
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});
