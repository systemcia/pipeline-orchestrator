import http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { ConnectionManager } from "./connection.js";
import { rawSendTool } from "./tools/raw-send.js";
import { readTool } from "./tools/read.js";
import { continueChatTool, runSkillTool } from "./tools/run-skill.js";
import { screenshotTool } from "./tools/screenshot.js";
import {
  listWindowsTool,
  newChatTool,
  statusTool,
  switchModelTool,
  switchProjectTool,
} from "./tools/session.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ContinueChatInput,
  ListWindowsInput,
  NewChatInput,
  RawSendInput,
  ReadInput,
  RunSkillInput,
  ScreenshotInput,
  StatusInput,
  SwitchModelInput,
  SwitchProjectInput,
} from "./types.js";

const SERVER_NAME = "cursor-cdp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_HTTP_PORT = 18099;

type TransportMode = "stdio" | "http";

interface TransportConfig {
  mode: TransportMode;
  port: number;
}

interface HttpSession {
  transport: SSEServerTransport;
  server: McpServer;
}

function parseArgs(argv: string[]): TransportConfig {
  let mode: TransportMode = "stdio";
  let port = DEFAULT_HTTP_PORT;

  for (const arg of argv) {
    if (arg === "--transport=http" || arg === "--transport=sse") {
      mode = "http";
      continue;
    }

    if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        port = parsed;
      }
    }
  }

  return { mode, port };
}

const portSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("CDP debugging port (defaults to config)");

const attachmentSchema = z.object({
  type: z.enum(["image", "file", "url"]),
  source: z.string().describe("Local file path or URL"),
});

function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function successResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: jsonText(data) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function buildInput<T>(fields: Record<string, unknown>): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

async function runTool<T>(
  manager: ConnectionManager,
  fn: (manager: ConnectionManager) => Promise<T>,
): Promise<CallToolResult> {
  try {
    const result = await fn(manager);
    return successResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

function createServer(manager: ConnectionManager): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "status",
    {
      description: "Query Cursor CDP connection status and current session info",
      inputSchema: { port: portSchema },
    },
    async ({ port }) =>
      runTool(manager, (m) =>
        statusTool(m, buildInput<StatusInput>({ port })),
      ),
  );

  server.registerTool(
    "list_windows",
    {
      description: "List all open Cursor windows with project and type info",
      inputSchema: { port: portSchema },
    },
    async ({ port }) =>
      runTool(manager, (m) =>
        listWindowsTool(m, buildInput<ListWindowsInput>({ port })),
      ),
  );

  server.registerTool(
    "switch_project",
    {
      description: "Switch to a Cursor window by project name",
      inputSchema: {
        project: z.string().describe("Target project name from window title"),
        port: portSchema,
      },
    },
    async ({ project, port }) =>
      runTool(manager, (m) =>
        switchProjectTool(m, buildInput<SwitchProjectInput>({ project, port })),
      ),
  );

  server.registerTool(
    "switch_model",
    {
      description: "Switch the AI model in the current Cursor chat",
      inputSchema: {
        model: z.string().describe("Model name or fuzzy match (e.g. opus, sonnet)"),
        port: portSchema,
      },
    },
    async ({ model, port }) =>
      runTool(manager, (m) =>
        switchModelTool(m, buildInput<SwitchModelInput>({ model, port })),
      ),
  );

  server.registerTool(
    "new_chat",
    {
      description: "Create a new chat conversation in the current Cursor window",
      inputSchema: { port: portSchema },
    },
    async ({ port }) =>
      runTool(manager, (m) =>
        newChatTool(m, buildInput<NewChatInput>({ port })),
      ),
  );

  server.registerTool(
    "read",
    {
      description: "Read the current chat conversation content",
      inputSchema: { port: portSchema },
    },
    async ({ port }) =>
      runTool(manager, (m) =>
        readTool(m, buildInput<ReadInput>({ port })),
      ),
  );

  server.registerTool(
    "screenshot",
    {
      description: "Capture a screenshot of the current Cursor window",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Save path (supports ~/); auto-generated if omitted"),
        port: portSchema,
      },
    },
    async ({ path, port }) =>
      runTool(manager, (m) =>
        screenshotTool(m, buildInput<ScreenshotInput>({ path, port })),
      ),
  );

  server.registerTool(
    "raw_send",
    {
      description: "Send prompt text to Cursor without waiting for completion",
      inputSchema: {
        prompt: z.string().describe("Text to send to the composer input"),
        port: portSchema,
      },
    },
    async ({ prompt, port }) =>
      runTool(manager, (m) =>
        rawSendTool(m, buildInput<RawSendInput>({ prompt, port })),
      ),
  );

  server.registerTool(
    "run_skill",
    {
      description:
        "Run a Skill in a target project: switch project, send prompt, wait for completion, extract result",
      inputSchema: {
        project: z.string().describe("Target project name"),
        prompt: z.string().describe("Instruction to send to the Skill or chat"),
        skill: z
          .string()
          .optional()
          .describe('Skill prefix (e.g. "/pipeline"); omitted means prompt only'),
        model: z.string().optional().describe("Model override (fuzzy match)"),
        port: portSchema,
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in seconds (default from config, max 1800)"),
        screenshot: z
          .boolean()
          .optional()
          .describe("Capture screenshot after completion"),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe("Attachments to include with the prompt"),
      },
    },
    async ({ project, prompt, skill, model, port, timeout, screenshot, attachments }) =>
      runTool(manager, (m) =>
        runSkillTool(m, buildInput<RunSkillInput>({
          project, prompt, skill, model, port, timeout, screenshot, attachments,
        })),
      ),
  );

  server.registerTool(
    "continue_chat",
    {
      description:
        "Send a follow-up prompt in the CURRENT chat session (no new chat), wait for completion, and return the response. Auto-creates a new chat if the session has been idle beyond session_timeout to prevent context pollution.",
      inputSchema: {
        prompt: z.string().describe("Follow-up instruction to send"),
        port: portSchema,
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in seconds (default from config, max 1800)"),
        session_timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Session idle timeout in seconds (default 3600). If exceeded, a new chat is created automatically."),
        screenshot: z
          .boolean()
          .optional()
          .describe("Capture screenshot after completion"),
      },
    },
    async ({ prompt, port, timeout, session_timeout, screenshot }) =>
      runTool(manager, (m) =>
        continueChatTool(m, buildInput<ContinueChatInput>({
          prompt, port, timeout, session_timeout, screenshot,
        })),
      ),
  );

  return server;
}

async function runStdio(manager: ConnectionManager): Promise<void> {
  const server = createServer(manager);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await server.close();
      await manager.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Shutdown error after ${signal}: ${message}`);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await server.connect(transport);
}

async function runHttp(manager: ConnectionManager, port: number): Promise<void> {
  const sessions = new Map<string, HttpSession>();
  let shuttingDown = false;

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    try {
      await session.server.close();
      await session.transport.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error closing session ${sessionId}: ${message}`);
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await Promise.all(
        [...sessions.keys()].map((sessionId) => closeSession(sessionId)),
      );
      await manager.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Shutdown error after ${signal}: ${message}`);
    } finally {
      process.exit(0);
    }
  };

  const httpServer = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      try {
        const transport = new SSEServerTransport("/message", res);
        const sessionId = transport.sessionId;
        const server = createServer(manager);

        transport.onclose = () => {
          void closeSession(sessionId);
        };

        sessions.set(sessionId, { transport, server });
        await server.connect(transport);
        console.error(
          `SSE stream established (session=${sessionId}, port=${port})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error establishing SSE stream: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500).end("Error establishing SSE stream");
        }
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400).end("Missing sessionId parameter");
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404).end("Session not found");
        return;
      }

      try {
        await session.transport.handlePostMessage(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error handling message for session ${sessionId}: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500).end("Error handling request");
        }
      }
      return;
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => {
      console.error(
        `cursor-cdp HTTP/SSE transport listening on port ${port} (GET /sse, POST /message)`,
      );
      resolve();
    });
    httpServer.on("error", reject);
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function main(): Promise<void> {
  const manager = new ConnectionManager();
  const config = parseArgs(process.argv.slice(2));

  if (config.mode === "http") {
    await runHttp(manager, config.port);
    return;
  }

  await runStdio(manager);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal server error: ${message}`);
  process.exit(1);
});
