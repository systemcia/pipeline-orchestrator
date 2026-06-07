import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CursorCdpConfig } from "./types.js";

const DEFAULT_CONFIG: CursorCdpConfig = {
  default_port: 9226,
  cdp_host: "localhost",
  default_timeout: 300,
  session_timeout: 3600,
};

function getConfigPaths(): string[] {
  const paths: string[] = [];

  const envPath = process.env["CURSOR_CDP_CONFIG"];
  if (envPath) {
    paths.push(envPath);
  }

  paths.push(path.join(process.cwd(), "cursor-cdp.config.json"));
  paths.push(path.join(os.homedir(), ".cursor-cdp", "config.json"));

  return paths;
}

function resolveHost(): string {
  const envHost = process.env["CURSOR_CDP_HOST"];
  if (envHost) return envHost;

  if (process.env["WSL_DISTRO_NAME"] && !process.env["CURSOR_CDP_HOST"]) {
    return detectWslHost();
  }
  return DEFAULT_CONFIG.cdp_host;
}

function detectWslHost(): string {
  try {
    const resolv = fs.readFileSync("/etc/resolv.conf", "utf-8");
    const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match?.[1] && match[1] !== "127.0.0.1") {
      return match[1];
    }
  } catch {
    // resolv.conf 不可读，回退 localhost
  }
  return DEFAULT_CONFIG.cdp_host;
}

function mergeWithDefaults(partial: Partial<CursorCdpConfig>): CursorCdpConfig {
  const config: CursorCdpConfig = {
    default_port: partial.default_port ?? DEFAULT_CONFIG.default_port,
    cdp_host: partial.cdp_host ?? resolveHost(),
    default_timeout: partial.default_timeout ?? DEFAULT_CONFIG.default_timeout,
    session_timeout: partial.session_timeout ?? DEFAULT_CONFIG.session_timeout,
  };

  if (partial.default_model !== undefined) {
    config.default_model = partial.default_model;
  }

  if (partial.log_dir !== undefined) {
    config.log_dir = partial.log_dir;
  }

  return config;
}

function readConfigFile(filePath: string): CursorCdpConfig | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as Partial<CursorCdpConfig>;
    return mergeWithDefaults(parsed);
  } catch {
    return null;
  }
}

export function loadConfig(): CursorCdpConfig {
  for (const configPath of getConfigPaths()) {
    const config = readConfigFile(configPath);
    if (config !== null) {
      return config;
    }
  }

  return mergeWithDefaults({});
}
