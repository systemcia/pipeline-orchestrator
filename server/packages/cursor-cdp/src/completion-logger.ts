import { logger } from "./logger.js";
import type { CompletionResult, CompletionSignal } from "./types.js";

const COMPONENT = "completion";

export function logPollResult(iteration: number, signals: Record<string, boolean>): void {
  logger.debug(COMPONENT, `poll iteration ${iteration}`, {
    iteration,
    signals,
  });
}

export function logSignalTriggered(signal: CompletionSignal, elapsed_ms: number): void {
  logger.info(COMPONENT, `signal triggered: ${signal}`, {
    signal,
    elapsed_ms,
  });
}

export function logFinalResult(result: CompletionResult): void {
  logger.info(COMPONENT, `completion detected: ${result.signal}`, {
    signal: result.signal,
    elapsed_ms: result.elapsed_ms,
    blocked_reason: result.blocked_reason,
  });
}

export function logTimeout(timeout_ms: number, elapsed_ms: number): void {
  logger.info(COMPONENT, "completion timeout", {
    timeout_ms,
    elapsed_ms,
  });
}
