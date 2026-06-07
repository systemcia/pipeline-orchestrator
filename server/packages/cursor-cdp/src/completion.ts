import { ConnectionManager } from "./connection.js";
import { loadConfig } from "./config.js";
import {
  logFinalResult,
  logPollResult,
  logSignalTriggered,
  logTimeout,
} from "./completion-logger.js";
import { logger } from "./logger.js";
import { SELECTORS } from "./selectors.js";
import type { CompletionResult, CompletionSignal } from "./types.js";
import { sleep } from "./utils.js";

const POLL_INTERVAL_MS = 2_000;
const CONFIRMATION_DELAY_MS = 500;
const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 1800;

interface PollSignals {
  blocked: boolean;
  blocked_reason?: string;
  send_ready: boolean;
  send_found: boolean;
  status_active: boolean;
  status_generating: boolean;
  status_spinner: boolean;
  status_stop: boolean;
  status_thinking: boolean;
  status_generating_text: boolean;
  is_busy: boolean;
}

function clampTimeout(seconds: number): number {
  return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, seconds));
}

function buildPollExpression(): string {
  const askQuestionSel = JSON.stringify(SELECTORS.askQuestion.container);
  const sendIconSel = JSON.stringify(SELECTORS.composer.sendButton);
  const sendFallbackSel = JSON.stringify(SELECTORS.composer.sendButtonFallback);
  const generatingSel = JSON.stringify(SELECTORS.status.generating);
  const spinnerSel = JSON.stringify(SELECTORS.status.spinner);
  const stopSel = JSON.stringify(SELECTORS.status.stop);
  const thinkingSel = JSON.stringify(SELECTORS.status.thinking);
  const generatingTextSel = JSON.stringify(SELECTORS.status.generatingText);
  const loadingOverlaySel = JSON.stringify(SELECTORS.status.loadingOverlay);

  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };

    const isSendReady = (btn) => {
      if (!btn || !isVisible(btn)) return false;
      const style = window.getComputedStyle(btn);
      if (style.pointerEvents === "none") return false;
      return (
        !btn.disabled &&
        btn.getAttribute("aria-disabled") !== "true" &&
        btn.getAttribute("data-disabled") !== "true"
      );
    };

    const matchesApprovalLabel = (btn) => {
      if (!isVisible(btn)) return false;
      const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
      return /\\b(allow|deny|approve|reject)\\b/i.test(label);
    };

    const askQuestion = !!document.querySelector(${askQuestionSel});

    const approvalDialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    let approval = false;
    if (approvalDialogs.length > 0) {
      for (const dialog of approvalDialogs) {
        if (!isVisible(dialog)) continue;
        if ([...dialog.querySelectorAll("button")].some(matchesApprovalLabel)) {
          approval = true;
          break;
        }
      }
    } else {
      approval = [...document.querySelectorAll("button")].some(matchesApprovalLabel);
    }

    let send_found = false;
    let send_ready = false;

    const sendIcon = document.querySelector(${sendIconSel});
    const sendFallback = document.querySelector(${sendFallbackSel});
    const sendBtn = sendIcon?.closest("button") || sendFallback;

    if (sendBtn) {
      send_found = true;
      send_ready = isSendReady(sendBtn);
    } else {
      for (const btn of document.querySelectorAll(".composer-bar button")) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        const hasSendIcon = btn.querySelector(".codicon-arrow-up, .codicon-send");
        if (!hasSendIcon && !label.includes("send")) continue;
        send_found = true;
        send_ready = isSendReady(btn);
        break;
      }
    }

    const status_generating = !!document.querySelector(${generatingSel});
    const status_spinner =
      !!document.querySelector(${spinnerSel}) ||
      !!document.querySelector(${loadingOverlaySel});
    const status_stop = !!document.querySelector(${stopSel});
    const status_thinking = !!document.querySelector(${thinkingSel});

    const titleEl = document.querySelector(${generatingTextSel});
    const status_generating_text = /generat|think/i.test(titleEl?.textContent || "");

    const status_active =
      status_generating ||
      status_spinner ||
      status_stop ||
      status_thinking ||
      status_generating_text;
    const is_busy = status_active || (send_found && !send_ready);

    let blocked_reason;
    if (askQuestion) blocked_reason = "ask_question";
    else if (approval) blocked_reason = "approval_dialog";

    return {
      blocked: askQuestion || approval,
      blocked_reason,
      send_ready,
      send_found,
      status_active,
      status_generating,
      status_spinner,
      status_stop,
      status_thinking,
      status_generating_text,
      is_busy,
    };
  })()`;
}

function toLogSignals(signals: PollSignals): Record<string, boolean> {
  return {
    blocked: signals.blocked,
    send_ready: signals.send_ready,
    send_found: signals.send_found,
    status_active: signals.status_active,
    status_generating: signals.status_generating,
    status_spinner: signals.status_spinner,
    status_stop: signals.status_stop,
    status_thinking: signals.status_thinking,
    status_generating_text: signals.status_generating_text,
    is_busy: signals.is_busy,
  };
}

export type ContentPollFn = () => Promise<string>;

const CONTENT_STABLE_COUNT = 2;
const MIN_CONTENT_DELAY_MS = 3_000;

export class CompletionDetector {
  private readonly pollExpression = buildPollExpression();
  private warnedSendSelectorMissing = false;

  constructor(private readonly manager: ConnectionManager) {}

  async wait(options: {
    timeout?: number;
    port?: number;
    contentPollFn?: ContentPollFn;
    baselineMessage?: string;
  } = {}): Promise<CompletionResult> {
    const config = loadConfig();
    const timeoutSec = clampTimeout(options.timeout ?? config.default_timeout);
    const port = options.port;
    const startTime = Date.now();
    const deadline = startTime + timeoutSec * 1000;
    let iteration = 0;
    let wasBusy = false;

    let lastSeenContent = "";
    let contentStableCount = 0;
    const useContentPoll = options.contentPollFn !== undefined && options.baselineMessage !== undefined;
    const contentCheckStart = startTime + MIN_CONTENT_DELAY_MS;

    while (Date.now() < deadline) {
      iteration += 1;
      const signals = await this.poll(port);
      logPollResult(iteration, toLogSignals(signals));

      if (!signals.send_found && !this.warnedSendSelectorMissing) {
        this.warnedSendSelectorMissing = true;
        logger.warn("completion", "send button selector not found, falling back to status detection");
      }

      if (signals.blocked) {
        const result: CompletionResult = {
          signal: "blocked",
          elapsed_ms: Date.now() - startTime,
          ...(signals.blocked_reason !== undefined
            ? { blocked_reason: signals.blocked_reason }
            : {}),
        };
        logSignalTriggered("blocked", result.elapsed_ms);
        logFinalResult(result);
        return result;
      }

      if (signals.is_busy) {
        wasBusy = true;
      }

      if (wasBusy && signals.send_found && signals.send_ready) {
        const confirmed = await this.confirmSignal("dom_ready", port, startTime);
        if (confirmed) {
          const result: CompletionResult = {
            signal: "dom_ready",
            elapsed_ms: Date.now() - startTime,
          };
          logFinalResult(result);
          return result;
        }
      } else if (wasBusy && !signals.status_active) {
        const confirmed = await this.confirmSignal("status_clear", port, startTime);
        if (confirmed) {
          const result: CompletionResult = {
            signal: "status_clear",
            elapsed_ms: Date.now() - startTime,
          };
          logFinalResult(result);
          return result;
        }
      }

      if (useContentPoll && Date.now() >= contentCheckStart) {
        try {
          const current = await options.contentPollFn!();
          if (current && current !== options.baselineMessage) {
            if (current === lastSeenContent) {
              contentStableCount += 1;
              if (contentStableCount >= CONTENT_STABLE_COUNT) {
                logSignalTriggered("status_clear", Date.now() - startTime);
                const result: CompletionResult = {
                  signal: "status_clear",
                  elapsed_ms: Date.now() - startTime,
                };
                logger.info("completion", "content-based completion detected");
                logFinalResult(result);
                return result;
              }
            } else {
              lastSeenContent = current;
              contentStableCount = 1;
            }
          }
        } catch {
          // content poll failed, continue with DOM detection
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const elapsed_ms = Date.now() - startTime;
    logTimeout(timeoutSec * 1000, elapsed_ms);
    const result: CompletionResult = { signal: "timeout", elapsed_ms };
    logFinalResult(result);
    return result;
  }

  private async poll(port?: number): Promise<PollSignals> {
    const raw = await this.manager.evaluate(this.pollExpression, port);
    return (raw ?? {
      blocked: false,
      send_ready: false,
      send_found: false,
      status_active: false,
      status_generating: false,
      status_spinner: false,
      status_stop: false,
      status_thinking: false,
      status_generating_text: false,
      is_busy: true,
    }) as PollSignals;
  }

  private async confirmSignal(
    expectedSignal: Extract<CompletionSignal, "dom_ready" | "status_clear">,
    port: number | undefined,
    startTime: number,
  ): Promise<boolean> {
    logSignalTriggered(expectedSignal, Date.now() - startTime);
    await sleep(CONFIRMATION_DELAY_MS);

    const signals = await this.poll(port);
    if (signals.blocked) {
      return false;
    }

    if (expectedSignal === "dom_ready") {
      return signals.send_found && signals.send_ready && !signals.status_active;
    }

    return !signals.status_active;
  }
}
