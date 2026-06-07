import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConnectionManager } from "../connection.js";
import type { ScreenshotInput, ScreenshotOutput } from "../types.js";
import { withToolLog } from "../tool-logger.js";

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

function defaultScreenshotPath(): string {
  const timestamp = Date.now();
  return path.join(
    os.homedir(),
    ".cursor-cdp",
    "screenshots",
    `screenshot-${timestamp}.png`,
  );
}

async function screenshotToolInner(
  manager: ConnectionManager,
  input: ScreenshotInput,
): Promise<ScreenshotOutput> {
  const client = await manager.getClient(input.port);
  await client.Page.enable();
  const { data } = await client.Page.captureScreenshot({ format: "png" });

  const savePath = expandHome(input.path ?? defaultScreenshotPath());
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  fs.writeFileSync(savePath, Buffer.from(data, "base64"));

  return { saved_to: savePath };
}

export async function screenshotTool(
  manager: ConnectionManager,
  input: ScreenshotInput,
): Promise<ScreenshotOutput> {
  return withToolLog("screenshot", input as Record<string, unknown>, () =>
    screenshotToolInner(manager, input),
  );
}
