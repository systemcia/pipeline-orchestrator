# Cursor 窗口识别（CDP Target 区分规则）

> 调研任务 1.3 — cursor-remote-dispatch  
> 目标：通过 CDP 枚举并区分 Cursor **Agent 窗口**与 **Editor 窗口**，提取项目名，供 `list_windows` / `switch_project` / `run_skill` 使用。

## 背景

Cursor 基于 Electron + VS Code 架构。启动时加 `--remote-debugging-port={port}`（本项目默认 **12678**）后，所有 `BrowserWindow` 共享同一 CDP 端口，每个顶层窗口对应一个独立的 `page` target。

**设计决策**（见 `openspec/changes/cursor-remote-dispatch/design.md` D1 闭合问题 #1）：

- **优先使用 Agent 窗口**（独立进程，长任务不阻塞编辑）
- Agent 窗口不存在时 **降级到 Editor 窗口**

---

## 1. CDP 端点与 Target 列表结构

### 1.1 发现端点

| 端点 | 用途 |
|------|------|
| `GET http://127.0.0.1:{port}/json` | 列出所有可调试 target（与 `/json/list` 等价） |
| `GET http://127.0.0.1:{port}/json/version` | 浏览器级元信息（含 `webSocketDebuggerUrl` 指向 browser target） |
| `GET http://127.0.0.1:{port}/json/protocol` | 完整 CDP 协议定义 |

**推荐**：窗口枚举用 HTTP `/json`，轻量、直接返回 `webSocketDebuggerUrl`，无需先连 browser target。

### 1.2 HTTP `/json` 返回的单条 Target 结构

```json
{
  "description": "",
  "devtoolsFrontendUrl": "/devtools/inspector.html?ws=127.0.0.1:12678/devtools/page/ABC123...",
  "id": "ABC123DEF456...",
  "title": "index.tsx - pipeline-orchestrator [WSL: ubuntu] - Cursor",
  "type": "page",
  "url": "vscode-file://vscode-app/home/user/.cursor/.../out/vs/code/electron-sandbox/workbench/workbench.html",
  "webSocketDebuggerUrl": "ws://127.0.0.1:12678/devtools/page/ABC123..."
}
```

| 字段 | 说明 |
|------|------|
| `id` | Target 唯一 ID，连接 WebSocket 时使用 |
| `type` | Target 类型。Cursor 顶层窗口均为 **`page`** |
| `title` | 窗口标题（OS 级），会随活动文件变化，**不稳定** |
| `url` | 页面加载 URL。**区分 Agent/Editor 的最可靠静态特征** |
| `webSocketDebuggerUrl` | 页面级 CDP WebSocket 地址，操控该窗口时连接此 URL |

### 1.3 典型 Target 类型分布

一次 Cursor 启动后 `/json` 通常包含多种 target（参考 [CursorRemote](https://github.com/len5ky/CursorRemote) 实践）：

| type | 数量级 | 是否操控目标 |
|------|--------|-------------|
| `page` | 1~N（每个 BrowserWindow 一个） | **是** — 仅含 workbench 的 page |
| `iframe` | 数十 | 否 |
| `webview` | 数个 | 否 |
| `worker` | 数个 | 否 |
| `service_worker` | 0~1 | 否 |

**过滤规则**：`type === "page"` **且** `url` 包含 `workbench`。

### 1.4 `Target.getTargets` 返回结构（WebSocket CDP）

通过 browser target 的 WebSocket 调用 `Target.getTargets`，返回 `targetInfos` 数组。每条 `TargetInfo`：

```json
{
  "targetId": "ABC123...",
  "type": "page",
  "title": "pipeline-orchestrator - Cursor",
  "url": "vscode-file://vscode-app/.../workbench/workbench.html",
  "attached": false,
  "canAccessOpener": true,
  "browserContextId": "..."
}
```

| 字段 | 与 HTTP `/json` 对应 |
|------|---------------------|
| `targetId` | `id` |
| `type` / `title` / `url` | 同义 |
| — | `webSocketDebuggerUrl` 需自行拼接：`ws://{host}:{port}/devtools/page/{targetId}` |

**注意**：Electron/Cursor 对 `Target.getBrowserContexts` 支持不完整，[CursorRemote](https://github.com/len5ky/CursorRemote/blob/main/docs/architecture.md) 因此直接连 page target 的 WebSocket，而非走 Puppeteer 的 browser 级连接。窗口发现阶段优先 HTTP `/json`。

### 1.5 完整列表示例

```json
[
  {
    "id": "page-editor-001",
    "type": "page",
    "title": "index.tsx - pipeline-orchestrator [WSL: ubuntu] - Cursor",
    "url": "vscode-file://vscode-app/.../vs/code/electron-sandbox/workbench/workbench.html",
    "webSocketDebuggerUrl": "ws://127.0.0.1:12678/devtools/page/page-editor-001"
  },
  {
    "id": "page-agent-002",
    "type": "page",
    "title": "Cursor Agents",
    "url": "vscode-file://vscode-app/.../vs/code/agentic/electron-browser/workbench/workbench.html",
    "webSocketDebuggerUrl": "ws://127.0.0.1:12678/devtools/page/page-agent-002"
  },
  {
    "id": "iframe-003",
    "type": "iframe",
    "title": "",
    "url": "vscode-webview://...",
    "webSocketDebuggerUrl": "ws://127.0.0.1:12678/devtools/page/iframe-003"
  }
]
```

---

## 2. Agent 窗口 vs Editor 窗口特征

Cursor 3（2026-04）引入独立的 **Agents Window**，与经典 **Editor Window** 并存。二者均为独立 `BrowserWindow`，但加载不同的 workbench 入口。

架构来源：[VS Code agentic window 实现](https://github.com/microsoft/vscode/commit/2414a6301dfc0d960fdb6bbb35fddd6c7af3b1fb)（Cursor 继承同源 fork）。

### 2.1 识别优先级

```
1. URL 路径（静态、无需连接）     ← 首选
2. DOM 探针（连接后 Runtime.evaluate）← 兜底 / 消歧
3. title 启发式（不稳定）         ← 仅作辅助
```

### 2.2 Editor 窗口

| 维度 | 特征 |
|------|------|
| **type** | `page` |
| **URL 模式** | 含 `workbench`，且路径为以下之一（**不含** `agentic`）： |
| | `.../vs/code/electron-sandbox/workbench/workbench.html` |
| | `.../vs/code/electron-browser/workbench/workbench.html` |
| **title 格式** | `{活动文件名} - {项目名} [{远程限定符}] - Cursor` |
| **title 示例** | `"SKILL.md - server-setup [SSH: server] - Cursor"` |
| | `"index.tsx - pipeline-orchestrator [WSL: ubuntu] - Cursor"` |
| **UI 特征** | 经典 IDE：文件树、多标签编辑器、终端、内嵌 Agent 侧栏（Cursor 2.x 风格） |
| **项目绑定** | 通常单 workspace；title 中项目名较明确 |

### 2.3 Agent 窗口（Cursor 3+ Agents Window）

| 维度 | 特征 |
|------|------|
| **type** | `page` |
| **URL 模式** | 含 `workbench`，且路径含 **`agentic`**： |
| | `.../vs/code/agentic/electron-browser/workbench/workbench.html` |
| **备选 URL** | 部分构建可能使用 `sessions` 路径（VS Code sessions 层遗留）： |
| | `.../vs/code/electron-browser/sessions/sessions.html` |
| **title 格式** | 多为固定窗口名，**不**跟随活动文件变化 |
| **title 示例** | `"Cursor Agents"` |
| | `"Agents - Cursor"` |
| | 少数版本可能仍显示 `{项目名} - Cursor`（需结合 URL 判断） |
| **UI 特征** | Agent-first 布局：glass-sidebar 全局 agent 列表（`.glass-sidebar-agent-list-container`），多项目并行 |
| **项目绑定** | **多 workspace**；单窗口可管理多个项目，title 不一定含目标项目名 |

### 2.4 URL 判别速查

| URL 包含 | 窗口类型 |
|----------|---------|
| `/vs/code/agentic/` 或 `/agentic/` | **Agent** |
| `/sessions/` 且不含 `electron-sandbox/workbench` | **Agent**（备选） |
| `/electron-sandbox/workbench/` 或 `/electron-browser/workbench/`（无 agentic） | **Editor** |

### 2.5 DOM 探针（连接后确认）

当 URL 不明确或 Cursor 版本变更时，连接 target 后执行：

```javascript
(() => {
  const hasAgentRail = !!document.querySelector(
    '.glass-sidebar-agent-list-container, .agent-sidebar-cell'
  );
  const hasEditorTabs = !!document.querySelector(
    '.tabs-container .tab, .editor-group-container'
  );
  if (hasAgentRail && !hasEditorTabs) return 'Agent';
  if (hasEditorTabs) return 'Editor';
  // agentic workbench 加载的 JS bundle 路径也可作为信号
  const scripts = [...document.scripts].map(s => s.src).join(' ');
  if (scripts.includes('agentic/workbench.desktop.main')) return 'Agent';
  if (scripts.includes('workbench.desktop.main')) return 'Editor';
  return 'Unknown';
})()
```

---

## 3. 项目名提取

### 3.1 推荐：CDP `Runtime.evaluate`（连接后）

VS Code/Cursor 内部 API，**不受 title 变化影响**（[CursorRemote 实践](https://github.com/len5ky/CursorRemote/blob/main/docs/architecture.md)）：

```javascript
(() => {
  const cfg = globalThis.vscode?.context?.configuration?.();
  const uri = cfg?.workspace?.uri;
  if (!uri) return null;
  const path = uri.path || uri.fsPath || '';
  const base = path.replace(/\/$/, '').split('/').pop() || '';
  const qualifier = uri.authority ? ` [${uri.authority}]` : '';
  return { project: base, qualifier, full: base + qualifier };
})()
```

| 字段 | 含义 | 示例 |
|------|------|------|
| `project` | 工作区文件夹 basename | `pipeline-orchestrator` |
| `qualifier` | 远程连接限定符 | ` [WSL: ubuntu]`、` [SSH: myserver]` |
| `full` | 带限定符的完整名 | `pipeline-orchestrator [WSL: ubuntu]` |

**Agent 窗口注意**：多 workspace 场景下 `workspace.uri` 返回**当前聚焦**的项目，不一定是 `run_skill` 目标项目。需结合 `switch_project` 的模糊匹配或用户在 Agent 侧栏选中的项目。

### 3.2 降级：从 title 解析（未连接时）

Editor 窗口 title 规律（来自 CursorRemote issue #11 实测日志）：

```
"{filename} - {project} [{qualifier}] - Cursor"
```

**解析步骤**：

1. 去掉末尾 ` - Cursor`（或 ` — Cursor`）
2. 按 ` - ` 分割
3. 若 ≥2 段：取**最后一段之前的那一段**为项目名（第一段是活动文件名）
4. 可选：剥离 `[WSL: ...]` / `[SSH: ...]` 限定符用于匹配

```text
"index.tsx - pipeline-orchestrator [WSL: ubuntu] - Cursor"
  → strip suffix → "index.tsx - pipeline-orchestrator [WSL: ubuntu]"
  → split → ["index.tsx", "pipeline-orchestrator [WSL: ubuntu]"]
  → project = "pipeline-orchestrator"
  → qualifier = "[WSL: ubuntu]"
```

Agent 窗口 title 常为 `"Cursor Agents"` 等固定字符串，**无法从 title 可靠提取项目名**。此时：

- `list_windows` 返回 `project: ""` 或 `"*"`（多项目）
- `switch_project` 优先匹配 Editor 窗口；若仅 Agent 窗口存在，连接后用 `Runtime.evaluate` 或侧栏 DOM 定位项目

### 3.3 项目名匹配规则（`switch_project`）

与 spec 一致：

- **子串匹配**：`project` 参数是窗口项目名的子串即命中（如 `"knight"` 匹配 `"knight-platform"`）
- **限定符无关**：匹配时忽略 `[WSL: ...]` 后缀
- **大小写**：默认不敏感（实现时统一 `toLowerCase()`）

---

## 4. 多窗口场景识别策略

### 4.1 枚举流程

```
fetchTargets(port)
  → filter: type=page AND url contains "workbench"
  → classify: Agent | Editor (by URL, DOM probe if ambiguous)
  → extractProject: title parse (fast) OR defer to evaluate on connect
  → return WindowInfo[]
```

### 4.2 窗口选择优先级（`run_skill` / `switch_project`）

给定目标 `project`：

```
1. Agent 窗口 + project 匹配（evaluate 或 title）
2. Editor 窗口 + project 匹配（title 子串或 evaluate）
3. 仅一个 workbench 窗口 → 降级使用
4. 无匹配 → 返回 error "project not found"
```

同一项目可能**同时**存在 Agent 窗口和 Editor 窗口（用户 `Cmd+Shift+P → Open Agents Window` 后两者并存）。调度时 **Agent 优先**。

### 4.3 多实例 / 多端口

每个 Cursor 进程使用独立 `--remote-debugging-port`（如 12678、9227）。`list_windows` 按 `port` 参数查询对应实例，不跨端口合并。

### 4.4 窗口生命周期

- 新窗口：`Target.targetCreated` 或周期性 `refresh`（建议 10s）重新拉取 `/json`
- 关窗：target 从列表消失；in-flight 操作应 reject
- title 变化：`Target.targetInfoChanged` / 重新 fetch；**不应**因活动文件切换而误判窗口类型（类型由 URL 决定，不变）

---

## 5. 窗口识别伪代码

```typescript
// ── 类型 ──────────────────────────────────────────
type WindowType = "Agent" | "Editor";

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CursorWindow {
  idx: number;
  targetId: string;
  type: WindowType;
  title: string;
  project: string;       // 可能为空（Agent 多项目窗口）
  qualifier?: string;    // e.g. "[WSL: ubuntu]"
  wsUrl: string;
}

// ── URL 分类 ──────────────────────────────────────
function classifyByUrl(url: string): WindowType | null {
  if (!url.includes("workbench") && !url.includes("sessions")) return null;
  if (url.includes("/agentic/") || url.includes("/vs/code/agentic/")) return "Agent";
  if (url.includes("/sessions/") && !url.includes("electron-sandbox/workbench")) return "Agent";
  if (url.includes("/electron-sandbox/workbench/") || url.includes("/electron-browser/workbench/")) {
    return "Editor";
  }
  return null;
}

// ── title 解析（Editor 降级）──────────────────────
function parseProjectFromTitle(title: string): { project: string; qualifier?: string } {
  const stripped = title.replace(/\s[-—]\s*Cursor\s*$/i, "").trim();
  const parts = stripped.split(" - ");
  if (parts.length < 2) return { project: stripped }; // Agent 固定标题等
  const raw = parts[parts.length - 1]; // 最后一段 = 项目+限定符
  const m = raw.match(/^(.+?)\s*(\[(?:WSL|SSH|Codespaces|Dev):[^\]]+\])\s*$/i);
  if (m) return { project: m[1].trim(), qualifier: m[2] };
  return { project: raw.trim() };
}

// ── 枚举 ──────────────────────────────────────────
async function listWindows(cdpPort: number): Promise<CursorWindow[]> {
  const targets: CdpTarget[] = await fetch(`http://127.0.0.1:${cdpPort}/json`).then(r => r.json());

  const workbenchPages = targets.filter(
    t => t.type === "page" && (t.url.includes("workbench") || t.url.includes("sessions"))
  );

  return workbenchPages.map((t, idx) => {
    const type = classifyByUrl(t.url) ?? "Editor"; // 未知时偏保守
    const { project, qualifier } = type === "Editor"
      ? parseProjectFromTitle(t.title)
      : { project: "" }; // Agent 窗口 title 不可靠，后续 evaluate 补充
    return { idx, targetId: t.id, type, title: t.title, project, qualifier, wsUrl: t.webSocketDebuggerUrl };
  });
}

// ── 连接后精确项目名 ──────────────────────────────
async function resolveProject(wsUrl: string): Promise<string> {
  const result = await cdpEvaluate(wsUrl, `
    (() => {
      const uri = globalThis.vscode?.context?.configuration?.()?.workspace?.uri;
      if (!uri) return "";
      const p = (uri.path || uri.fsPath || "").replace(/\\/$/, "");
      return p.split("/").pop() || "";
    })()
  `);
  return result || "";
}

// ── DOM 类型确认（可选兜底）──────────────────────
async function confirmWindowType(wsUrl: string): Promise<WindowType> {
  const t = await cdpEvaluate(wsUrl, `/* §2.5 探针脚本 */`);
  return t === "Agent" ? "Agent" : "Editor";
}

// ── 选择目标窗口（run_skill 用）──────────────────
function pickWindow(windows: CursorWindow[], project: string): CursorWindow | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s*\[[^\]]+\]/g, "").trim();
  const want = norm(project);

  const matches = (w: CursorWindow) =>
    norm(w.project).includes(want) || norm(w.title).includes(want);

  return (
    windows.find(w => w.type === "Agent" && matches(w)) ??
    windows.find(w => w.type === "Editor" && matches(w)) ??
    (windows.length === 1 ? windows[0] : null)
  );
}
```

---

## 6. 验证清单

本地验证步骤（任务 10.1 前置）：

1. 分别以默认方式和 `--remote-debugging-port=12678` 启动 Cursor
2. 仅开 Editor：`curl -s http://127.0.0.1:12678/json | jq '.[] | select(.type=="page") | {title,url}'`
3. `Cmd+Shift+P → Open Agents Window`，重复 curl，确认出现 `agentic` URL 的 page target
4. 对比两种窗口的 `title` 差异，记录实际格式
5. 连接各 target，执行 §3.1 evaluate 脚本，核对 `project` 与文件系统路径一致

---

## 7. 风险与版本兼容

| 风险 | 影响 | 缓解 |
|------|------|------|
| Cursor 升级变更 workbench 路径 | URL 分类失效 | DOM 探针兜底 + selectors 版本适配 |
| Agent 窗口 title 格式变更 | title 解析失败 | 本来就不依赖 Agent title；用 evaluate |
| 仅 Editor 无 Agent（Cursor < 3） | 无 Agent 窗口 | 自动降级 Editor，符合设计 |
| `vscode.context` 内部 API 变更 | evaluate 取项目名失败 | 降级 title 解析 |
| 多 workspace Agent 窗口 | project 指向当前聚焦项 | `switch_project` 需实现侧栏项目切换（后续 task） |

---

## 参考资料

- [Cursor Agents Window 官方文档](https://cursor.com/docs/agent/agents-window)
- [VS Code Agents Window 文档](https://code.visualstudio.com/docs/copilot/agents/agents-window)
- [VS Code agentic window 源码引入](https://github.com/microsoft/vscode/commit/2414a6301dfc0d960fdb6bbb35fddd6c7af3b1fb)
- [CursorRemote 架构文档](https://github.com/len5ky/CursorRemote/blob/main/docs/architecture.md) — CDP 多窗口发现、workspace 提取
- [Chrome DevTools Protocol — Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/)
- [CDP /json 端点说明](https://chromedevtools.github.io/devtools-protocol/) — `GET /json` 返回结构
- 本项目：`openspec/changes/cursor-remote-dispatch/design.md` — D6 `list_windows` / `status` 接口
