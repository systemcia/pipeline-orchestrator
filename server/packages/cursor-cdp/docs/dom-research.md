# Cursor IDE DOM 结构调研

> **任务**: t1 — 1.1-dom-reverse  
> **目的**: 为 `cursor-cdp` MCP Server 提供 CDP 自动化所需的选择器基线  
> **调研日期**: 2026-06-06  
> **验证状态**: 本文档基于公开资料与社区逆向项目汇总；**本地 CDP 端点未连通**（`9222`/`12678` 均不可用），部分选择器标注为「推测」，需在后续 task 中通过 `opencli cursor dump` 或 CDP `Runtime.evaluate` 实测确认。

---

## 1. 背景与约束

### 1.1 技术栈

| 组件 | 说明 |
|------|------|
| 宿主 | Cursor IDE（Electron，VS Code fork） |
| CDP 端口 | `--remote-debugging-port=12678`（本项目约定；社区常用 `9222`） |
| CDP 目标 | `workbench` page target（`http://127.0.0.1:<port>/json` 过滤 `url` 含 `workbench`） |
| 输入引擎 | ProseMirror/TipTap（`contenteditable` + `role="textbox"`），**必须用 CDP `Input.insertText` + `Input.dispatchKeyEvent`**，不可直接写 `innerText` |

### 1.2 设计决策 D2 — 三级完成检测

| 层级 | 信号 | 用途 |
|------|------|------|
| L1 DOM | Send 按钮 `disabled` → `enabled` | 输入框可再次提交 |
| L2 状态 | `Generating...` / Stop 按钮 / Spinner 消失 | Agent 生成结束 |
| L3 超时 | `CURSOR_ACTION_TIMEOUT_MS`（默认 30s） | 兜底 |

### 1.3 调研来源

| 来源 | 可信度 | 说明 |
|------|--------|------|
| [CursorRemote selectors.json](https://github.com/len5ky/CursorRemote/blob/main/selectors.json) | 高 | 生产级 CDP 桥接，级联选择器策略 |
| [CursorRemote dom-extractor.ts](https://github.com/len5ky/CursorRemote/blob/main/src/server/dom-extractor.ts) | 高 | 消息/问卷/活动状态提取实现 |
| [Gantry README](https://github.com/uhaop/Gantry) | 中高 | Cursor v0.48.7 选择器断裂告警与自动发现 |
| [OpenCLI Cursor 适配器](https://opencli.info/docs/adapters/desktop/cursor.html) | 中 | `opencli cursor dump` DOM 导出能力 |
| Cursor 社区论坛 CSS 定制帖 | 中 | `.anysphere-*` / `.aislash-*` 类名 |
| VS Code `interactive-session` 源码 | 中 | 继承层 DOM 结构参考 |

---

## 2. Agent 面板 DOM 层次结构

Cursor Agent 面板位于 **Auxiliary Bar**（右侧 AI 面板），与 VS Code Chat Widget 共享部分结构，Cursor 叠加了 `composer-*` / `anysphere-*` 命名空间。

```
.monaco-workbench
└── #workbench.parts.auxiliarybar                    ← Agent 面板根容器 [已确认]
    ├── .agent-sidebar-* / .glass-sidebar-*          ← 会话历史侧栏（v0.1.45+ glass-sidebar）[已确认]
    │   └── .agent-sidebar-cell                      ← 单个 Chat Tab [已确认]
    │       └── [data-composer-id]                   ← Tab 关联的 Composer ID [已确认]
    ├── .composer-bar / div.composer-bar.editor      ← Composer 主栏 [已确认]
    │   ├── .composer-unified-dropdown[data-mode]    ← 模式选择器 (Agent/Plan/Debug/Ask) [已确认]
    │   ├── .ui-model-picker__trigger                ← 模型选择器触发器 (Cursor 3.5+) [已确认]
    │   │   └── .composer-unified-dropdown-model     ← 模型选择器触发器 (旧版) [已确认]
    │   ├── .composer-questionnaire-toolbar          ← AskQuestion 问卷 UI [已确认]
    │   └── .composer-bar-input-area (推测)          ← 输入区容器 [推测]
    │       ├── .aislash-editor-input                ← Composer 可编辑输入 [已确认]
    │       │   └── [contenteditable="true"][role="textbox"]
    │       └── button (Send/Stop)                   ← 提交/停止按钮 [推测]
    └── [data-flat-index] 消息列表区                  ← 对话消息容器 [已确认]
        ├── [data-message-role="human"]              ← 用户消息 [已确认]
        │   └── .aislash-editor-input-readonly
        ├── [data-message-role="ai"]                 ← AI 消息 [已确认]
        │   ├── [data-message-kind="assistant"]
        │   │   └── .markdown-root / .anysphere-markdown-container-root
        │   └── [data-message-kind="tool"]
        │       └── .ui-tool-call-line-* / .composer-*-tool-*
        ├── .loading-indicator-v3                    ← 生成中 Spinner [已确认]
        └── .make-shine                              ← Thinking 闪烁动画 [已确认]
```

**CDP 页面定位**:

```javascript
// 过滤 CDP /json 列表
targets.filter(t => t.type === 'page' && t.url.includes('workbench'))
```

---

## 3. 关键元素选择器

> 格式：**主选择器** | **备选选择器** | **验证状态**

### 3.1 Send / Submit 按钮

| 属性 | 值 |
|------|-----|
| 主选择器 (CSS) | `.composer-bar button:not([disabled]) .codicon-arrow-up, .composer-bar button:not([disabled]) .codicon-send` |
| 备选 1 | `button[aria-label*="Send" i]` |
| 备选 2 | `.composer-bar .monaco-action-bar .action-item button:not([disabled])` |
| 备选 3 | `#workbench\\.parts\\.auxiliarybar button:not([disabled])[aria-label]`（在输入框同级 toolbar 中最后一个 button） |
| ARIA | `aria-label` 含 `Send` / `Submit`；生成中可能变为 `Stop` |
| disabled 检测 | `button[disabled]` 或 `aria-disabled="true"` 或 `data-disabled="true"` |
| 验证状态 | **推测** — CursorRemote 通过 `Enter` 提交而非点击按钮；社区未见稳定 class 文档 |

**D2 L1 检测逻辑（推测）**:

```javascript
const sendBtn = document.querySelector('.composer-bar button:not([disabled])');
const isReady = sendBtn && !sendBtn.disabled && !sendBtn.closest('[aria-busy="true"]');
```

**提交策略（已确认 — CursorRemote 实践）**:

1. Focus 输入框 → `Input.insertText` 写入文本  
2. `Input.dispatchKeyEvent` 发送 `Enter`（桌面默认 Enter=发送，Shift+Enter=换行）  
3. 移动端或 Enter 不可靠时，回退点击 Send 按钮

---

### 3.2 Composer 输入框

| 属性 | 值 |
|------|-----|
| 主选择器 (CSS) | `#workbench\\.parts\\.auxiliarybar [contenteditable="true"][role="textbox"]` |
| 备选 1 | `.composer-bar [contenteditable="true"]` |
| 备选 2 | `.aislash-editor-input[contenteditable="true"]` |
| 备选 3 | `div.new-composer-input[role="textbox"]`（Gantry v0.48.7 自动发现） |
| 备选 4 | `#workbench\\.parts\\.auxiliarybar textarea` |
| 备选 5 | `[contenteditable="true"]`（全局兜底，需配合可见性过滤） |
| ARIA | `role="textbox"`, `aria-multiline="true"`, `contenteditable="true"` |
| Placeholder | `.aislash-editor-placeholder`（相邻元素）[已确认] |
| 验证状态 | **已确认**（CursorRemote selectors.json + 社区 CSS）；`new-composer-input` 为 **已确认**（Gantry 告警日志） |

**可见性过滤（推测）**:

```javascript
const inputs = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
  .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 20);
```

**注意**: Cursor 使用 ProseMirror，DOM 赋值无效；必须通过 CDP Input 域注入。

---

### 3.3 对话消息容器

| 属性 | 值 |
|------|-----|
| 主选择器 (CSS) | `#workbench\\.parts\\.auxiliarybar` |
| 备选 1 | `div.composer-bar.editor` |
| 备选 2 | `[class*="composer-bar"]` |
| 备选 3 | `[class*="composer-panel"]` |
| 备选 4 | `[class*="chat-widget"]` |
| 消息条目 | `[data-flat-index]`（每条消息 wrapper）[已确认] |
| 用户消息文本 | `.aislash-editor-input-readonly` [已确认] |
| AI 消息正文 | `.markdown-root` / `.anysphere-markdown-container-root` [已确认] |
| 稳定属性 | `data-message-role`, `data-message-kind`, `data-message-id` [已确认] |
| 验证状态 | 容器选择器 **已确认**（CursorRemote）；消息 data-* 属性 **已确认** |

**读取策略（已确认）**:

```javascript
const messages = [...container.querySelectorAll('[data-flat-index]')].map(el => ({
  role: el.getAttribute('data-message-role'),
  kind: el.getAttribute('data-message-kind'),
  id: el.getAttribute('data-message-id'),
  index: el.getAttribute('data-flat-index'),
}));
```

---

### 3.4 模型选择器 / 下拉菜单

| 属性 | 值 |
|------|-----|
| 触发器 — 主选择器 | `.ui-model-picker__trigger`（Cursor 3.5+ 新皮肤）[已确认] |
| 触发器 — 备选 1 | `.composer-unified-dropdown-model` [已确认] |
| 触发器 — 备选 2 | `[class*="composer-unified-dropdown-model"]`（Gantry）[已确认] |
| 菜单 — 主选择器 | `[data-testid="model-picker-menu"]`（旧版，3.5+ 已移除）[已确认-已废弃] |
| 菜单 — 备选 1 | `[role="menu"]`（打开后第一个可见 menu）[已确认] |
| 菜单 — 备选 2 | `document.getElementById(trigger.getAttribute('aria-controls'))` [已确认] |
| 菜单项 | `[role="menuitem"]`, `.composer-unified-context-menu-item` [已确认] |
| 当前模型 | 触发器 `textContent`（排除子 button "Edit" 文本）[已确认] |
| 已选标记 | 菜单项内 `.codicon-check`（非 `data-is-selected`，后者仅表 hover）[已确认] |
| 验证状态 | **已确认**（CursorRemote v0.1.45+ release notes + command-executor.ts） |

---

### 3.5 模式选择器（Agent / Plan / Debug / Ask）

| 属性 | 值 |
|------|-----|
| 主选择器 (CSS) | `.composer-unified-dropdown[data-mode]` |
| 备选 1 | `.composer-bar-input-buttons[data-mode]` |
| 当前模式 | `data-mode` 属性值（如 `agent`, `plan`, `debug`, `ask`）[已确认] |
| 菜单项 | `[id*="composer-mode-"][id$="-{modeId}"]` [已确认] |
| 验证状态 | **已确认**（CursorRemote selectors.json + architecture.md） |

---

### 3.6 生成状态指示器（Generating / Stop / Spinner）

| 信号 | 主选择器 | 备选选择器 | 验证状态 |
|------|----------|------------|----------|
| Spinner | `.loading-indicator-v3` | `[class*="loading-indicator"]` | **已确认** |
| Thinking 动画 | `.make-shine` | `[class*="make-shine"]` | **已确认** |
| 状态栏文字 | `span.auxiliary-bar-chat-title` | `[class*="auxiliary-bar-chat-title"]` | **已确认** |
| 状态栏 — 泛化 | `[class*="status"]`, `[class*="thinking"]`, `[class*="spinner"]`, `[class*="loading"]` | selectors.json `agentStatus` 级联 | **已确认** |
| VS Code 继承 | `.chat-loading-overlay[role="status"][aria-live="polite"]` | `.chat-loading-overlay .codicon-loading` | **推测**（VS Code 源码） |
| Stop 按钮 | `button[aria-label*="Stop" i]` | `button .codicon-debug-stop` | **推测** |
| Cancel 按钮 | `button[aria-label*="Cancel" i]` | 文本匹配 `Cancel` / `Stop` | **推测** |

**D2 L2 检测逻辑（已确认 + 推测）**:

```javascript
// 已确认信号
const isGenerating =
  !!document.querySelector('.loading-indicator-v3') ||
  !!document.querySelector('.make-shine') ||
  /generat|think/i.test(document.querySelector('span.auxiliary-bar-chat-title')?.textContent || '');

// 推测：Stop 按钮出现 = 生成中
const stopBtn = document.querySelector('button[aria-label*="Stop" i], button .codicon-debug-stop');
const isStreaming = isGenerating || !!stopBtn;
```

**agentStatus 枚举**（CursorRemote）：`idle` | `thinking` | `generating` | `running_tool` | `waiting_approval` | `error` [已确认]

---

### 3.7 AskQuestion UI 元素

AskQuestion 工具激活时渲染 `.composer-questionnaire-toolbar`（非普通文本问答）[已确认]。

| 元素 | 主选择器 | 备选选择器 | 验证状态 |
|------|----------|------------|----------|
| 问卷根容器 | `.composer-questionnaire-toolbar` | `[class*="questionnaire-toolbar"]` | **已确认** |
| 步骤标签 | `.composer-questionnaire-toolbar-stepper-label` | 文本如 `1 of 3` | **已确认** |
| 问题列表 | `.composer-questionnaire-toolbar-question` | — | **已确认** |
| 当前问题 | `.composer-questionnaire-toolbar-question-active` | — | **已确认** |
| 问题编号 | `.composer-questionnaire-toolbar-question-number` | — | **已确认** |
| 问题正文 | `.composer-questionnaire-toolbar-question .markdown-root` | — | **已确认** |
| 选项容器 | `.composer-questionnaire-toolbar-option` | — | **已确认** |
| 选项字母按钮 | `.composer-questionnaire-toolbar-option-letter` | — | **已确认** |
| 选项文本 | `.composer-questionnaire-toolbar-option-label` | — | **已确认** |
| 自由输入选项 | `.composer-questionnaire-toolbar-option-freeform` | — | **已确认** |
| Skip 按钮 | `.composer-questionnaire-toolbar-actions .composer-skip-button` | `button[aria-label*="Skip" i]` | **已确认** |
| Continue 按钮 | `.composer-questionnaire-toolbar-actions .composer-run-button` | `button[aria-label*="Continue" i]` | **已确认** |
| Continue disabled | `[data-disabled="true"]` on Continue button | `button[disabled]` | **已确认** |

**交互流程（已确认）**:

1. 检测 `.composer-questionnaire-toolbar` 是否存在  
2. 点击 `.composer-questionnaire-toolbar-option-letter` 选择选项  
3. 点 Continue（`.composer-run-button`，需 `data-disabled !== "true"`）或 Skip（`.composer-skip-button`）

---

## 4. 选择器汇总表

| # | 元素 | 主选择器 | 备选选择器 | 状态 |
|---|------|----------|------------|------|
| 1 | Agent 面板根 | `#workbench\\.parts\\.auxiliarybar` | `[class*="composer-bar"]` | 已确认 |
| 2 | Send 按钮 | `.composer-bar button:not([disabled]) .codicon-arrow-up` | `button[aria-label*="Send" i]` | 推测 |
| 3 | Composer 输入 | `#workbench\\.parts\\.auxiliarybar [contenteditable="true"][role="textbox"]` | `.aislash-editor-input`, `div.new-composer-input` | 已确认 |
| 4 | 消息容器 | `[data-flat-index]` (within auxiliarybar) | `.anysphere-markdown-container-root` | 已确认 |
| 5 | 模型选择器 | `.ui-model-picker__trigger` | `.composer-unified-dropdown-model` | 已确认 |
| 6 | 模式选择器 | `.composer-unified-dropdown[data-mode]` | `.composer-bar-input-buttons[data-mode]` | 已确认 |
| 7 | 生成状态 | `.loading-indicator-v3` + `.make-shine` | `span.auxiliary-bar-chat-title` | 已确认 |
| 8 | Stop 按钮 | `button[aria-label*="Stop" i]` | `button .codicon-debug-stop` | 推测 |
| 9 | AskQuestion 根 | `.composer-questionnaire-toolbar` | `[class*="questionnaire-toolbar"]` | 已确认 |
| 10 | AskQuestion 选项 | `.composer-questionnaire-toolbar-option-letter` | `.composer-questionnaire-toolbar-option` | 已确认 |

共记录 **10 个 DOM 元素/组件**（含 Stop 按钮与模式选择器扩展）。

---

## 5. 版本敏感性与维护策略

| 风险 | 影响 | 缓解 |
|------|------|------|
| Cursor 版本升级改变 Composer 布局 | 输入框选择器断裂 | 级联策略 + 环境变量覆盖（Gantry: `CURSOR_CHAT_INPUT_SELECTOR`） |
| 模型选择器换肤 (3.5+) | 模型切换失败 | 新旧 trigger 双轨 + `aria-controls` 菜单解析 |
| Glass sidebar 迁移 | Chat Tab 检测失败 | `.agent-sidebar-cell` + `.glass-sidebar-agent-menu-btn` 双轨 |
| Hash class 变化 | CSS class 选择器失效 | 优先 `data-*` 属性 + ARIA role/label |
| 后台窗口节流 | CDP evaluate 超时 | 保持 Cursor 窗口前台 |

**推荐验证命令**:

```bash
# 1. 启动 Cursor
cursor --remote-debugging-port=12678

# 2. 检查 CDP 端点
curl http://127.0.0.1:12678/json/list | jq '.[].url'

# 3. DOM 导出（OpenCLI）
export OPENCLI_CDP_ENDPOINT="http://127.0.0.1:12678"
opencli cursor dump    # → /tmp/cursor-dom.html + /tmp/cursor-snapshot.json

# 4. 选择器健康检查（Gantry 模式）
npx tsx scripts/cdp-preflight.ts
```

---

## 6. 后续 Task 验证清单

- [ ] 连通 CDP，确认 `workbench` page target 存在
- [ ] 实测 Send 按钮选择器（空输入 disabled / 有输入 enabled / 生成中 Stop）
- [ ] 实测 `Input.insertText` + Enter 提交流程
- [ ] 验证 `[data-flat-index]` 消息提取与 D2 完成检测时序
- [ ] 触发 AskQuestion（Plan Mode + AskQuestion tool），验证 questionnaire 选择器
- [ ] 记录 Cursor 版本号（Help → About）与选择器快照归档

---

## 7. 参考链接

- [CursorRemote selectors.json](https://github.com/len5ky/CursorRemote/blob/main/selectors.json)
- [CursorRemote architecture.md](https://github.com/len5ky/CursorRemote/blob/main/docs/architecture.md)
- [Gantry — Cursor CDP Bridge](https://github.com/uhaop/Gantry)
- [OpenCLI Cursor Adapter](https://opencli.info/docs/adapters/desktop/cursor.html)
- [VS Code Chat Widget AGENTS_CHAT_WIDGET.md](https://github.com/microsoft/vscode/blob/main/src/vs/sessions/browser/widget/AGENTS_CHAT_WIDGET.md)
- [Cursor Forum — Chat Panel CSS Classes](https://forum.cursor.com/t/changing-chat-panel-font-size-line-height-easily/375)
- [Cursor Forum — AskQuestion Tool](https://forum.cursor.com/t/how-can-i-use-clarifying-questions-with-my-skill/152102)
