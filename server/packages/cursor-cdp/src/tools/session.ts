import { ConnectionManager } from "../connection.js";
import { SELECTORS } from "../selectors.js";
import type {
  ListWindowsInput,
  ListWindowsOutput,
  NewChatInput,
  NewChatOutput,
  StatusInput,
  StatusOutput,
  SwitchModelInput,
  SwitchModelOutput,
  SwitchProjectInput,
  SwitchProjectOutput,
  WindowInfo,
  WindowType,
} from "../types.js";
import { withToolLog } from "../tool-logger.js";
import { isMacOS, sleep } from "../utils.js";

const MENU_WAIT_MS = 500;
const MENU_POLL_MS = 50;
const NEW_CHAT_WAIT_MS = 3000;
const NEW_CHAT_POLL_MS = 200;

function classifyByUrl(url: string): WindowType | null {
  if (!url.includes("workbench") && !url.includes("sessions")) {
    return null;
  }
  if (url.includes("/agentic/") || url.includes("/vs/code/agentic/")) {
    return "Agent";
  }
  if (url.includes("/sessions/") && !url.includes("electron-sandbox/workbench")) {
    return "Agent";
  }
  if (
    url.includes("/electron-sandbox/workbench/") ||
    url.includes("/electron-browser/workbench/")
  ) {
    return "Editor";
  }
  return null;
}

function parseProjectFromTitle(title: string, windowType?: WindowType): string {
  if (windowType === "Agent") {
    return "";
  }

  const stripped = title.replace(/\s[-—]\s*Cursor\s*$/i, "").trim();
  const parts = stripped.split(" - ");
  if (parts.length < 2) {
    return windowType === undefined ? stripped : "";
  }
  const raw = parts[parts.length - 1] ?? "";
  const m = raw.match(/^(.+?)\s*(\[(?:WSL|SSH|Codespaces|Dev):[^\]]+\])\s*$/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  return raw.trim();
}

async function getCurrentModel(
  manager: ConnectionManager,
  port?: number,
): Promise<string> {
  return String(
    await manager.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(SELECTORS.model.trigger)});
        return (el?.textContent || "").trim();
      })()`,
      port,
    ) ?? "",
  );
}

async function waitForModelMenu(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const deadline = Date.now() + MENU_WAIT_MS;
  while (Date.now() < deadline) {
    const visible = await manager.evaluate(
      `(() => {
        const menus = document.querySelectorAll(${JSON.stringify(SELECTORS.model.menu)});
        return [...menus].some((menu) => menu.offsetParent !== null);
      })()`,
      port,
    );
    if (visible) {
      return true;
    }
    await sleep(MENU_POLL_MS);
  }
  return false;
}

async function detectBusy(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const result = await manager.evaluate(
    `!!document.querySelector(${JSON.stringify(SELECTORS.status.generating)}) || !!document.querySelector(${JSON.stringify(SELECTORS.status.spinner)})`,
    port,
  );
  return Boolean(result);
}

async function statusToolInner(
  manager: ConnectionManager,
  input: StatusInput,
): Promise<StatusOutput> {
  if (!manager.getState(input.port).connected) {
    try {
      await manager.getClient(input.port);
    } catch {
      return {
        connected: false,
        project: "",
        model: "",
        window_type: "Editor",
        busy: false,
      };
    }
  }

  const title = String(
    await manager.evaluate("document.title", input.port) ?? "",
  );
  const url = String(
    await manager.evaluate("location.href", input.port) ?? "",
  );
  const windowType = classifyByUrl(url) ?? "Editor";
  const project = parseProjectFromTitle(title);
  const model = String(
    await manager.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(SELECTORS.model.trigger)});
        return (el?.textContent || "").trim();
      })()`,
      input.port,
    ) ?? "",
  );
  const busy = await detectBusy(manager, input.port);

  return {
    connected: true,
    project,
    model,
    window_type: windowType,
    busy,
  };
}

export async function statusTool(
  manager: ConnectionManager,
  input: StatusInput,
): Promise<StatusOutput> {
  return withToolLog("status", input as Record<string, unknown>, () =>
    statusToolInner(manager, input),
  );
}

function isModelAllowed(model: string, allowedModels?: string[]): boolean {
  if (!allowedModels || allowedModels.length === 0) return true;
  const lower = model.toLowerCase();
  return allowedModels.some((a) => {
    const al = a.toLowerCase();
    return lower.includes(al) || al.includes(lower);
  });
}

async function switchModelToolInner(
  manager: ConnectionManager,
  input: SwitchModelInput,
  allowedModels?: string[],
): Promise<SwitchModelOutput> {
  if (!isModelAllowed(input.model, allowedModels)) {
    const currentBefore = await getCurrentModel(manager, input.port);
    return {
      ok: false,
      current: currentBefore,
      error: `Model "${input.model}" blocked by allowed_models whitelist: [${allowedModels!.join(", ")}]`,
    };
  }

  return manager.withLock(async () => {
    const currentBefore = await getCurrentModel(manager, input.port);

    const triggerClicked = await manager.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(SELECTORS.model.trigger)});
        if (!el) return false;
        el.click();
        return true;
      })()`,
      input.port,
    );
    if (!triggerClicked) {
      return {
        ok: false,
        current: currentBefore,
        error: "Model trigger not found",
      };
    }

    const menuVisible = await waitForModelMenu(manager, input.port);
    if (!menuVisible) {
      return {
        ok: false,
        current: currentBefore,
        error: "Model menu did not appear",
      };
    }

    const matchResult = (await manager.evaluate(
      `(() => {
        const target = ${JSON.stringify(input.model)}.toLowerCase();
        const menus = [...document.querySelectorAll(${JSON.stringify(SELECTORS.model.menu)})]
          .filter((menu) => menu.offsetParent !== null);
        const menu = menus[0];
        if (!menu) return { found: false, available: [] };
        const options = menu.querySelectorAll(${JSON.stringify(SELECTORS.model.option)});
        const available = [];
        for (const opt of options) {
          const text = (opt.textContent || "").trim();
          available.push(text);
          if (text.toLowerCase().includes(target)) {
            opt.click();
            return { found: true, matched: text, available };
          }
        }
        return { found: false, available };
      })()`,
      input.port,
    )) as { found: boolean; matched?: string; available: string[] } | null;

    if (!matchResult?.found) {
      const avail = matchResult?.available?.slice(0, 20)?.join(", ") ?? "unknown";
      return {
        ok: false,
        current: currentBefore,
        error: `Model not found: ${input.model} | available: [${avail}]`,
      };
    }

    await sleep(100);
    const current = await getCurrentModel(manager, input.port);
    return { ok: true, current };
  }, input.port);
}

export async function switchModelTool(
  manager: ConnectionManager,
  input: SwitchModelInput,
  allowedModels?: string[],
): Promise<SwitchModelOutput> {
  return withToolLog("switch_model", { ...input }, () =>
    switchModelToolInner(manager, input, allowedModels),
  );
}

function isWorkbenchPage(url: string): boolean {
  return url.includes("workbench") || url.includes("sessions");
}

async function listWindowsToolInner(
  manager: ConnectionManager,
  input: ListWindowsInput,
): Promise<ListWindowsOutput> {
  const targets = await manager.getTargets(input.port);
  const windows: WindowInfo[] = [];

  let idx = 0;
  for (const target of targets) {
    if (target.type !== "page" || !isWorkbenchPage(target.url)) {
      continue;
    }

    const type: WindowType =
      target.url.includes("agentic") || /cursor\s*agents?/i.test(target.title)
        ? "Agent"
        : "Editor";
    windows.push({
      idx,
      type,
      title: target.title,
      project: parseProjectFromTitle(target.title, type),
    });
    idx += 1;
  }

  return { windows };
}

export async function listWindowsTool(
  manager: ConnectionManager,
  input: ListWindowsInput,
): Promise<ListWindowsOutput> {
  return withToolLog("list_windows", input as Record<string, unknown>, () =>
    listWindowsToolInner(manager, input),
  );
}

function matchesProjectQuery(window: WindowInfo, query: string): boolean {
  const q = query.toLowerCase();
  return (
    window.project.toLowerCase().includes(q) ||
    window.title.toLowerCase().includes(q)
  );
}

function pickBestWindowMatch(
  windows: WindowInfo[],
  query: string,
): WindowInfo | null {
  // 优先使用 Agent 窗口（独立运行，不受用户操作干扰）
  const agentWindow = windows.find((w) => w.type === "Agent");
  if (agentWindow) {
    return agentWindow;
  }
  // 无 Agent 窗口时，按 project 匹配 Editor 窗口
  if (query) {
    const matches = windows.filter((w) => matchesProjectQuery(w, query));
    if (matches.length > 0) {
      return matches[0] ?? null;
    }
  }
  return windows[0] ?? null;
}

async function getTargetIdForWindowIdx(
  manager: ConnectionManager,
  port: number | undefined,
  idx: number,
): Promise<string | null> {
  const targets = await manager.getTargets(port);
  let currentIdx = 0;
  for (const target of targets) {
    if (target.type !== "page" || !isWorkbenchPage(target.url)) {
      continue;
    }
    if (currentIdx === idx) {
      return target.targetId;
    }
    currentIdx += 1;
  }
  return null;
}

async function switchProjectToolInner(
  manager: ConnectionManager,
  input: SwitchProjectInput,
): Promise<SwitchProjectOutput> {
  return manager.withLock(async () => {
    const listInput: ListWindowsInput =
      input.port !== undefined ? { port: input.port } : {};
    const { windows } = await listWindowsTool(manager, listInput);
    const matched = pickBestWindowMatch(windows, input.project);

    if (!matched) {
      return {
        ok: false,
        current: "",
        error: `Project not found: ${input.project}`,
      };
    }

    const targetId = await getTargetIdForWindowIdx(
      manager,
      input.port,
      matched.idx,
    );
    if (!targetId) {
      return {
        ok: false,
        current: "",
        error: `Project not found: ${input.project}`,
      };
    }

    await manager.switchTarget(targetId, input.port);

    const current = matched.project || matched.title;
    return { ok: true, current };
  }, input.port);
}

export async function switchProjectTool(
  manager: ConnectionManager,
  input: SwitchProjectInput,
): Promise<SwitchProjectOutput> {
  return withToolLog("switch_project", { ...input }, () =>
    switchProjectToolInner(manager, input),
  );
}

async function getMessageCount(
  manager: ConnectionManager,
  port?: number,
): Promise<number> {
  const result = await manager.evaluate(
    `document.querySelectorAll(${JSON.stringify(SELECTORS.conversation.message)}).length`,
    port,
  );
  return typeof result === "number" ? result : -1;
}

async function tryNewChatViaCommand(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const result = await manager.evaluate(
    `(async () => {
      const cmds = globalThis.vscode?.commands;
      if (!cmds) return false;
      try {
        const allCmds = await cmds.getCommands(true);
        const chatCmds = allCmds.filter(c =>
          /new.*chat|chat.*new|newchat/i.test(c)
        );
        for (const cmd of chatCmds) {
          try { await cmds.executeCommand(cmd); return true; } catch {}
        }
      } catch {}
      return false;
    })()`,
    port,
  );
  return Boolean(result);
}

async function dispatchNewChatViaCDP(
  manager: ConnectionManager,
  port?: number,
): Promise<void> {
  const client = await manager.getClient(port);
  const useMeta = isMacOS();
  const modifiers = useMeta ? 4 : 2;

  await (client.Input.dispatchKeyEvent as Function)({
    type: "rawKeyDown",
    modifiers,
    windowsVirtualKeyCode: 78,
    nativeVirtualKeyCode: 78,
    key: "n",
    code: "KeyN",
  });
  await sleep(50);
  await (client.Input.dispatchKeyEvent as Function)({
    type: "keyUp",
    modifiers: 0,
    windowsVirtualKeyCode: 78,
    nativeVirtualKeyCode: 78,
    key: "n",
    code: "KeyN",
  });
}

async function dispatchNewChatShortcut(
  manager: ConnectionManager,
  port?: number,
): Promise<void> {
  const useMeta = isMacOS();
  await manager.evaluate(
    `(() => {
      const useMeta = ${JSON.stringify(useMeta)};
      const modifierKey = useMeta ? "Meta" : "Control";
      const modifierCode = useMeta ? "MetaLeft" : "ControlLeft";
      const target = document.activeElement || document.body;

      function dispatch(type, key, code, ctrlKey, metaKey) {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code,
            ctrlKey,
            metaKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      const modCtrl = !useMeta;
      const modMeta = useMeta;

      dispatch("keydown", modifierKey, modifierCode, modCtrl, modMeta);
      dispatch("keydown", "n", "KeyN", modCtrl, modMeta);
      dispatch("keypress", "n", "KeyN", modCtrl, modMeta);
      dispatch("keyup", "n", "KeyN", modCtrl, modMeta);
      dispatch("keyup", modifierKey, modifierCode, false, false);
      return true;
    })()`,
    port,
  );
}

async function waitForComposerInput(
  manager: ConnectionManager,
  port?: number,
): Promise<boolean> {
  const selectors = [
    SELECTORS.composer.input,
    SELECTORS.composer.inputFallback,
    SELECTORS.composer.inputAgent,
  ].map(s => JSON.stringify(s)).join(",");
  const deadline = Date.now() + NEW_CHAT_WAIT_MS;
  while (Date.now() < deadline) {
    const ready = await manager.evaluate(
      `(() => {
        const sels = [${selectors}];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) continue;
          if (el.offsetParent === null) continue;
          if (el.isContentEditable === true || el.getAttribute("contenteditable") === "true") {
            return true;
          }
        }
        return false;
      })()`,
      port,
    );
    if (ready) {
      return true;
    }
    await sleep(NEW_CHAT_POLL_MS);
  }
  return false;
}

async function verifyNewChat(
  manager: ConnectionManager,
  port: number | undefined,
  beforeCount: number,
): Promise<boolean> {
  const deadline = Date.now() + NEW_CHAT_WAIT_MS;
  while (Date.now() < deadline) {
    const afterCount = await getMessageCount(manager, port);
    if (beforeCount > 0 && afterCount === 0) return true;
    if (beforeCount > 0 && afterCount < beforeCount) return true;
    await sleep(NEW_CHAT_POLL_MS);
  }
  return false;
}

async function newChatToolInner(
  manager: ConnectionManager,
  input: NewChatInput,
): Promise<NewChatOutput> {
  return manager.withLock(async () => {
    const beforeCount = await getMessageCount(manager, input.port);

    // Strategy 1: vscode command API
    const cmdOk = await tryNewChatViaCommand(manager, input.port);
    if (cmdOk) {
      const verified = await verifyNewChat(manager, input.port, beforeCount);
      if (verified || beforeCount === 0) {
        const ready = await waitForComposerInput(manager, input.port);
        return { ok: ready };
      }
    }

    // Strategy 2: CDP Input.dispatchKeyEvent (Ctrl+N / Cmd+N)
    await dispatchNewChatViaCDP(manager, input.port);
    const cdpVerified = await verifyNewChat(manager, input.port, beforeCount);
    if (cdpVerified || beforeCount === 0) {
      const ready = await waitForComposerInput(manager, input.port);
      return { ok: ready };
    }

    // Strategy 3: legacy DOM synthetic events
    await dispatchNewChatShortcut(manager, input.port);
    const domVerified = await verifyNewChat(manager, input.port, beforeCount);
    if (domVerified || beforeCount === 0) {
      const ready = await waitForComposerInput(manager, input.port);
      return { ok: ready };
    }

    return { ok: false };
  }, input.port);
}

export async function newChatTool(
  manager: ConnectionManager,
  input: NewChatInput,
): Promise<NewChatOutput> {
  return withToolLog("new_chat", input as Record<string, unknown>, () =>
    newChatToolInner(manager, input),
  );
}
