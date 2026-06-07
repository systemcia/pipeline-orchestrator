import { logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

const COMPONENT = "tool";
const PROMPT_MAX_LENGTH = 200;

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...input };
  const prompt = sanitized["prompt"];
  if (typeof prompt === "string" && prompt.length > PROMPT_MAX_LENGTH) {
    sanitized["prompt"] = `${prompt.slice(0, PROMPT_MAX_LENGTH)}...`;
  }
  return sanitized;
}

export async function withToolLog<T>(
  toolName: string,
  input: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();
  const sanitizedInput = sanitizeInput(input);

  logger.info(COMPONENT, `tool call started: ${toolName}`, {
    toolName,
    input: sanitizedInput,
  });

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    logger.info(COMPONENT, `tool call completed: ${toolName}`, {
      toolName,
      durationMs,
      status: "success",
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    logger.error(COMPONENT, `tool call failed: ${toolName}`, {
      toolName,
      durationMs,
      status: "error",
      error: getErrorMessage(error),
    });

    throw error;
  }
}
