import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompletionDetector } from "../completion.js";
import { ConnectionManager } from "../connection.js";
import { loadConfig } from "../config.js";
import { extractResult } from "../extractor.js";
import { SELECTORS } from "../selectors.js";
import type {
  Attachment,
  ContinueChatInput,
  ContinueChatOutput,
  NewChatInput,
  RawSendInput,
  ReadInput,
  RunSkillInput,
  RunSkillOutput,
  ScreenshotInput,
  StatusInput,
  SwitchModelInput,
  SwitchProjectInput,
} from "../types.js";
import { withToolLog } from "../tool-logger.js";
import { sleep } from "../utils.js";
import { rawSendTool } from "./raw-send.js";
import { readTool } from "./read.js";
import { screenshotTool } from "./screenshot.js";
import {
  listWindowsTool,
  newChatTool,
  statusTool,
  switchModelTool,
  switchProjectTool,
} from "./session.js";

/** 每个 CDP port 的最后一次成功交互时间戳（ms） */
const lastInteraction = new Map<number, number>();

function touchSession(port: number): void {
  lastInteraction.set(port, Date.now());
}

function isSessionExpired(port: number, timeoutSec: number): boolean {
  const last = lastInteraction.get(port);
  if (last === undefined) return true;
  return Date.now() - last > timeoutSec * 1000;
}

const CONNECTION_LOST_HINT =
  "CDP connection lost during execution. Ensure Cursor is running with --remote-debugging-port and retry.";
const CONNECTION_DEAD_HINT =
  "CDP connection dead, restart required.";

function portOpts(port: number | undefined): { port: number } | Record<string, never> {
  return port !== undefined ? { port } : {};
}

function isConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection lost|failed to connect|connection unavailable|port marked unavailable|cdp connection dead/i.test(
    message,
  );
}

function buildConnectionLostError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/dead|restart required|port marked unavailable/i.test(message)) {
    return CONNECTION_DEAD_HINT;
  }
  return CONNECTION_LOST_HINT;
}

function formatAvailableProjects(names: string[]): string {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  return unique.length > 0 ? unique.join(", ") : "(none)";
}

async function buildProjectNotFoundError(
  manager: ConnectionManager,
  project: string,
  port?: number,
): Promise<string> {
  try {
    const { windows } = await listWindowsTool(manager, {
      ...portOpts(port),
    });
    const available = windows.map((w) => w.project || w.title);
    return `Project '${project}' not found. Available: [${formatAvailableProjects(available)}]`;
  } catch {
    return `Project '${project}' not found. Available: [(unable to list)]`;
  }
}

async function safeReadResponse(
  manager: ConnectionManager,
  port?: number,
): Promise<string> {
  try {
    const readResult = await readTool(manager, {
      ...portOpts(port),
    } as ReadInput);
    return extractResult(readResult.conversation);
  } catch {
    return "";
  }
}

async function newChatWithRetry(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const first = await newChatTool(manager, {
    ...portOpts(port),
  } as NewChatInput);
  if (first.ok) {
    return true;
  }

  await sleep(500);
  const second = await newChatTool(manager, {
    ...portOpts(port),
  } as NewChatInput);
  return second.ok;
}

async function getWorkspacePath(
  manager: ConnectionManager,
  port?: number,
): Promise<string | null> {
  const result = await manager.evaluate(
    `(() => {
      const cfg = globalThis.vscode?.context?.configuration?.();
      const uri = cfg?.workspace?.uri;
      if (!uri) return null;
      const workspacePath = uri.fsPath || uri.path || "";
      return workspacePath.replace(/\\/$/, "");
    })()`,
    port,
  );
  return typeof result === "string" && result.length > 0 ? result : null;
}

function buildAttachmentsDir(projectRoot: string): string {
  return path.join(projectRoot, ".cursor-cdp", "attachments");
}

function prepareAttachments(
  attachments: Attachment[],
  projectRoot: string,
): { promptSuffix: string; attachmentsDir: string } {
  const attachmentsDir = buildAttachmentsDir(projectRoot);
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const lines: string[] = ["", "[附件]"];
  let imageIndex = 1;

  for (const attachment of attachments) {
    if (attachment.type === "url") {
      lines.push(`- 链接: ${attachment.source}`);
      continue;
    }

    const ext = path.extname(attachment.source);
    const destName =
      attachment.type === "image"
        ? `img-${String(imageIndex).padStart(3, "0")}${ext || ".png"}`
        : path.basename(attachment.source);
    if (attachment.type === "image") {
      imageIndex += 1;
    }

    const destPath = path.join(attachmentsDir, destName);
    fs.copyFileSync(attachment.source, destPath);

    const reference = `@.cursor-cdp/attachments/${destName}`;
    if (attachment.type === "image") {
      lines.push(`- 图片: ${reference}`);
    } else {
      lines.push(`- 文件: ${reference}`);
    }
  }

  return {
    promptSuffix: lines.length > 2 ? lines.join("\n") : "",
    attachmentsDir,
  };
}

function cleanupAttachments(attachmentsDir: string): void {
  try {
    fs.rmSync(attachmentsDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响主流程返回
  }
}

function buildFullPrompt(input: RunSkillInput, attachmentSuffix: string): string {
  const base =
    input.skill?.startsWith("/") === true
      ? `${input.skill} ${input.prompt}`
      : input.prompt;
  return attachmentSuffix ? `${base}${attachmentSuffix}` : base;
}

async function detectTruncated(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const containerSel = JSON.stringify(SELECTORS.panel.root);
  const truncated = await manager.evaluate(
    `(() => {
      const buttons = [...document.querySelectorAll("button")];
      const hasContinue = buttons.some((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
        return /^continue$/i.test(label);
      });
      if (hasContinue) return true;

      const container = document.querySelector(${containerSel});
      const text = container?.textContent || "";
      return /\\b(truncated|hit the length limit|response was cut off)\\b/i.test(text);
    })()`,
    port,
  );
  return Boolean(truncated);
}

function buildRunSkillScreenshotPath(): string {
  const timestamp = Date.now();
  return path.join(
    os.homedir(),
    ".cursor-cdp",
    "screenshots",
    `run-skill-${timestamp}.png`,
  );
}

async function captureScreenshot(
  manager: ConnectionManager,
  port?: number,
): Promise<string | undefined> {
  try {
    const result = await screenshotTool(manager, {
      path: buildRunSkillScreenshotPath(),
      ...portOpts(port),
    } as ScreenshotInput);
    return result.saved_to;
  } catch {
    return undefined;
  }
}

type PartialOutput = Omit<RunSkillOutput, "duration_ms">;

class StepAbort {
  constructor(readonly output: PartialOutput) {}
}

function ensureConnection(
  manager: ConnectionManager,
  port?: number,
): Promise<void> {
  return manager.getClient(port).then(
    () => {},
    (error) => {
      if (isConnectionLost(error)) {
        throw new StepAbort({
          status: "error", error: buildConnectionLostError(error), response: "",
        });
      }
      throw error;
    },
  );
}

async function sendPromptAndWait(
  manager: ConnectionManager,
  prompt: string,
  timeout: number,
  port?: number,
): Promise<PartialOutput> {
  const sendResult = await rawSendTool(manager, {
    prompt,
    ...portOpts(port),
  } as RawSendInput);
  if (!sendResult.ok) {
    throw new StepAbort({
      status: "error",
      error: sendResult.error ?? "Failed to send prompt",
      response: "",
    });
  }

  await sleep(1000);
  const postSendRead = await readTool(manager, { ...portOpts(port) } as ReadInput);
  const postSendBaseline = postSendRead.last_message;

  const detector = new CompletionDetector(manager);
  const contentPollFn = async () => {
    const r = await readTool(manager, { ...portOpts(port) } as ReadInput);
    const msg = r.last_message;
    if (!msg) return postSendBaseline;
    if (msg === prompt || prompt.startsWith(msg) || msg.startsWith(prompt)) {
      return postSendBaseline;
    }
    return msg;
  };
  const completion = await detector.wait({
    timeout,
    ...portOpts(port),
    contentPollFn,
    baselineMessage: postSendBaseline,
  });

  const readResult = await readTool(manager, {
    ...portOpts(port),
  } as ReadInput);
  let response = extractResult(readResult.conversation);
  if (!response && readResult.last_message && readResult.last_message !== postSendBaseline) {
    response = readResult.last_message;
  }
  const truncated = await detectTruncated(manager, port);

  const statusMap: Record<string, RunSkillOutput["status"]> = {
    blocked: "blocked",
    timeout: "timeout",
  };

  return {
    status: statusMap[completion.signal] ?? "complete",
    response,
    ...(completion.blocked_reason !== undefined
      ? { blocked_reason: completion.blocked_reason }
      : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function handleToolError(
  error: unknown,
  finish: (p: PartialOutput) => RunSkillOutput,
  safeResponse: string,
): RunSkillOutput {
  if (error instanceof StepAbort) {
    return finish(error.output);
  }
  if (isConnectionLost(error)) {
    return finish({
      status: "error", error: buildConnectionLostError(error), response: safeResponse,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return finish({ status: "error", error: message, response: safeResponse });
}

async function withScreenshot(
  manager: ConnectionManager,
  port: number | undefined,
  screenshot: boolean | undefined,
  result: RunSkillOutput,
): Promise<RunSkillOutput> {
  if (!screenshot) return result;
  const screenshot_path = await captureScreenshot(manager, port);
  return screenshot_path ? { ...result, screenshot_path } : result;
}

async function runSkillToolInner(
  manager: ConnectionManager,
  input: RunSkillInput,
): Promise<RunSkillOutput> {
  const startTime = Date.now();
  const port = input.port;
  const config = loadConfig();
  const timeout = input.timeout ?? config.default_timeout;
  let attachmentsDir: string | undefined;

  const finish = (partial: PartialOutput): RunSkillOutput => ({
    ...partial,
    duration_ms: Date.now() - startTime,
  });

  try {
    await ensureConnection(manager, port);

    const resolvedModel = input.model ?? config.default_model;
    if (resolvedModel) {
      const status = await statusTool(manager, {
        ...portOpts(port),
      } as StatusInput);
      if (!status.model.toLowerCase().includes(resolvedModel.toLowerCase())) {
        await switchModelTool(manager, {
          model: resolvedModel,
          ...portOpts(port),
        } as SwitchModelInput);
      }
    }

    const switchResult = await switchProjectTool(manager, {
      project: input.project,
      ...portOpts(port),
    } as SwitchProjectInput);
    if (!switchResult.ok) {
      throw new StepAbort({
        status: "error",
        error: await buildProjectNotFoundError(manager, input.project, port),
        response: "",
      });
    }

    const newChatOk = await newChatWithRetry(manager, port);
    if (!newChatOk) {
      throw new StepAbort({
        status: "error",
        error: "Failed to create new chat (composer input not ready after retry)",
        response: "",
      });
    }

    let attachmentSuffix = "";
    if (input.attachments && input.attachments.length > 0) {
      const projectRoot = await getWorkspacePath(manager, port);
      if (!projectRoot) {
        throw new StepAbort({
          status: "error", error: "Workspace path not found", response: "",
        });
      }
      const prepared = prepareAttachments(input.attachments, projectRoot);
      attachmentSuffix = prepared.promptSuffix;
      attachmentsDir = prepared.attachmentsDir;
    }

    const fullPrompt = buildFullPrompt(input, attachmentSuffix);
    const result = await sendPromptAndWait(manager, fullPrompt, timeout, port);
    const resolvedPort = port ?? config.default_port;
    touchSession(resolvedPort);
    return finish(result);
  } catch (error) {
    const safeResponse = await safeReadResponse(manager, port);
    return handleToolError(error, finish, safeResponse);
  } finally {
    if (attachmentsDir) {
      cleanupAttachments(attachmentsDir);
    }
  }
}

export async function runSkillTool(
  manager: ConnectionManager,
  input: RunSkillInput,
): Promise<RunSkillOutput> {
  return withToolLog("run_skill", { ...input }, async () => {
    const result = await runSkillToolInner(manager, input);
    return withScreenshot(manager, input.port, input.screenshot, result);
  });
}

async function continueChatToolInner(
  manager: ConnectionManager,
  input: ContinueChatInput,
): Promise<ContinueChatOutput> {
  const startTime = Date.now();
  const port = input.port;
  const config = loadConfig();
  const timeout = input.timeout ?? config.default_timeout;
  const sessionTimeout = input.session_timeout ?? config.session_timeout;
  const resolvedPort = port ?? config.default_port;

  const finish = (partial: PartialOutput): ContinueChatOutput => ({
    ...partial,
    duration_ms: Date.now() - startTime,
  });

  try {
    await ensureConnection(manager, port);

    let newSession = false;
    if (isSessionExpired(resolvedPort, sessionTimeout)) {
      const ok = await newChatWithRetry(manager, port);
      if (!ok) {
        throw new StepAbort({
          status: "error",
          error: "Session expired but failed to create new chat",
          response: "",
        });
      }
      newSession = true;
    }

    const result = await sendPromptAndWait(manager, input.prompt, timeout, port);
    touchSession(resolvedPort);
    return finish({
      ...result,
      ...(newSession ? { new_session: true } : {}),
    });
  } catch (error) {
    const safeResponse = await safeReadResponse(manager, port);
    return handleToolError(error, finish, safeResponse);
  }
}

export async function continueChatTool(
  manager: ConnectionManager,
  input: ContinueChatInput,
): Promise<ContinueChatOutput> {
  return withToolLog("continue_chat", { ...input }, async () => {
    const result = await continueChatToolInner(manager, input);
    return withScreenshot(manager, input.port, input.screenshot, result);
  });
}
