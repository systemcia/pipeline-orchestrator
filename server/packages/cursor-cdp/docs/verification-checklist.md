# cursor-cdp 基础全链路手动验证清单

> 任务 10.1-verify-basic  
> 用途：在无自动化 CDP 环境时，供人工逐步验证 MCP Server 与 Cursor CDP 的基础连通性。  
> 验证范围：`status` → `list_windows` → `switch_project` → `new_chat` → `raw_send` → `read`

---

## 1. 前置条件

完成以下准备后，再执行第 2 节清单。

### 1.1 构建 cursor-cdp 包

```bash
cd /home/go/src/pipeline-orchestrator/server/packages/cursor-cdp
npm install
npm run build
```

**验收标准**：`dist/index.js` 存在且无 TypeScript 编译错误。

### 1.2 以 CDP 调试端口启动 Cursor

```bash
cursor --remote-debugging-port=12678
```

> 默认端口为 `12678`，与 `cursor-cdp.config.json` 中 `default_port` 一致。  
> 若使用其他端口，后续所有 tool 调用需传入 `port` 参数。

**快速自检**（可选）：

```bash
curl -s http://127.0.0.1:12678/json | jq '.[].title'
```

应返回至少一个 Cursor 窗口标题。

### 1.3 启动 MCP Server

任选 **stdio** 或 **HTTP** 模式之一。

#### 方式 A：stdio（推荐，注册到 Cursor MCP）

将 `mcp-config.example.json` 中的 `mcpServers.cursor-cdp` 合并到项目或全局 `mcp.json`，替换绝对路径后重启 Cursor。

```json
{
  "mcpServers": {
    "cursor-cdp": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/pipeline-orchestrator/server/packages/cursor-cdp/dist/index.js"
      ],
      "cwd": "/ABSOLUTE/PATH/TO/pipeline-orchestrator/server/packages/cursor-cdp"
    }
  }
}
```

**验收标准**：Cursor Settings → MCP 中 `cursor-cdp` 状态为 **connected**（绿点）。

#### 方式 B：HTTP/SSE（独立进程）

```bash
cd /home/go/src/pipeline-orchestrator/server/packages/cursor-cdp
npm run start:http
# 等价于: node dist/index.js --transport=http --port=18099
```

**验收标准**：终端输出 `cursor-cdp HTTP/SSE transport listening on port 18099`。

### 1.4 测试环境建议

| 项 | 建议值 |
|----|--------|
| 已打开项目 | `pipeline-orchestrator`（或任意已知项目名） |
| 窗口类型 | 同时打开 **Editor** 与 **Agent** 窗口（若有） |
| Composer | 当前窗口 Chat 面板可见，非全屏遮挡 |
| 网络 | 本机 `127.0.0.1:12678` 可访问 |

---

## 2. 基础验证清单

按顺序执行，前一步通过后再进行下一步。

- [ ] **status**：返回 `connected=true`
- [ ] **list_windows**：正确识别 Agent / Editor 窗口
- [ ] **switch_project**：切换到指定项目
- [ ] **new_chat**：创建新对话
- [ ] **raw_send**：发送文本消息
- [ ] **read**：读取对话内容

---

## 3. 逐步验证详情

### 3.1 status — 查询 CDP 连接状态

**目的**：确认 MCP Server 能通过 CDP 连接到 Cursor 实例。

#### 输入

```json
{}
```

或显式指定端口：

```json
{ "port": 12678 }
```

#### 预期输出（成功）

```json
{
  "connected": true,
  "project": "pipeline-orchestrator",
  "model": "claude-4-opus",
  "window_type": "Editor",
  "busy": false
}
```

| 字段 | 说明 |
|------|------|
| `connected` | **必须为 `true`** |
| `project` | 当前激活窗口的项目名（从 `document.title` 解析） |
| `model` | Composer 区域当前选中的模型名 |
| `window_type` | `"Agent"` 或 `"Editor"` |
| `busy` | AI 是否正在生成（`true` 表示忙碌中） |

#### 预期输出（失败 — CDP 未启动）

```json
{
  "connected": false,
  "project": "",
  "model": "",
  "window_type": "Editor",
  "busy": false
}
```

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `connected=false` | Cursor 未加 `--remote-debugging-port=12678` |
| MCP tool 报错 | `npm run build` 未完成或 MCP 未注册 |
| `project` 为空 | 当前为 Agent 窗口（设计行为）或标题格式未识别 |

---

### 3.2 list_windows — 枚举所有 Cursor 窗口

**目的**：列出同一 CDP 端口下所有 workbench 页面，区分 Agent / Editor。

#### 输入

```json
{}
```

#### 预期输出（成功）

```json
{
  "windows": [
    {
      "idx": 0,
      "type": "Editor",
      "title": "index.tsx - pipeline-orchestrator [WSL: ubuntu] - Cursor",
      "project": "pipeline-orchestrator"
    },
    {
      "idx": 1,
      "type": "Agent",
      "title": "Cursor Agent",
      "project": ""
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `idx` | 窗口索引，供 `switch_project` 内部使用 |
| `type` | `"Agent"`（URL 含 `agentic`）或 `"Editor"`（`electron-sandbox/workbench`） |
| `title` | CDP target 原始标题 |
| `project` | Editor 窗口从标题解析；Agent 窗口通常为空 |

#### 验收标准

- [ ] `windows` 数组非空
- [ ] 至少一个 `type: "Editor"` 且 `project` 非空
- [ ] 若打开了 Agent 窗口，存在 `type: "Agent"` 条目
- [ ] `idx` 从 0 连续递增

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `windows: []` | 无 workbench 页面 target，Cursor 未完全启动 |
| 仅有 Editor 无 Agent | 未打开 Agent 窗口（非错误，视环境而定） |
| `project` 全部为空 | 仅 Agent 窗口或标题格式异常 |

---

### 3.3 switch_project — 切换到指定项目窗口

**目的**：按项目名模糊匹配并激活对应 Cursor 窗口。

> **记录**：从 3.2 输出中选取一个已知 `project` 值作为 `project` 参数。

#### 输入

```json
{
  "project": "pipeline-orchestrator"
}
```

#### 预期输出（成功）

```json
{
  "ok": true,
  "current": "pipeline-orchestrator"
}
```

#### 预期输出（失败 — 项目不存在）

```json
{
  "ok": false,
  "current": "",
  "error": "Project not found: nonexistent-project"
}
```

#### 验收标准

- [ ] 返回 `ok: true`
- [ ] `current` 与目标项目名匹配（或为目标窗口 `title`）
- [ ] **目视确认**：Cursor 前台窗口已切换到对应项目

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `Project not found` | 项目名拼写错误或未打开该项目 |
| `ok=true` 但窗口未切换 | 多实例端口不一致，检查 `port` 参数 |

---

### 3.4 new_chat — 创建新对话

**目的**：在当前激活窗口中通过快捷键（Ctrl+N / Cmd+N）打开新的 Composer 对话。

#### 输入

```json
{}
```

#### 预期输出（成功）

```json
{
  "ok": true
}
```

#### 预期输出（失败）

```json
{
  "ok": false
}
```

> `new_chat` 在 composer 输入框 3s 内未就绪时返回 `ok: false`（无 `error` 字段）。

#### 验收标准

- [ ] 返回 `ok: true`
- [ ] **目视确认**：Chat 面板出现空白新对话，composer 输入框可编辑

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `ok: false` | 快捷键被拦截、Chat 面板未展开、DOM 选择器变更 |
| 创建了对话但非新对话 | 当前已在空对话中，先发送一条消息再重试 |

---

### 3.5 raw_send — 发送文本消息（不等待完成）

**目的**：向 composer 输入框填入文本并回车发送，不阻塞等待 AI 回复完成。

#### 输入

```json
{
  "prompt": "请用一句话回复：cursor-cdp 基础验证测试"
}
```

#### 预期输出（成功）

```json
{
  "ok": true
}
```

#### 预期输出（失败）

```json
{
  "ok": false,
  "error": "Composer input not found"
}
```

#### 验收标准

- [ ] 返回 `ok: true`
- [ ] **目视确认**：用户消息已出现在对话区域
- [ ] AI 开始生成回复（`status` 的 `busy` 可能变为 `true`）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `Composer input not found` | 未执行 `new_chat` 或 Chat 面板未聚焦 |
| `ok: true` 但无消息 | 输入框选择器失效，检查 `docs/dom-research.md` |
| CDP 连接错误 | 窗口已关闭或 CDP 端口变更 |

---

### 3.6 read — 读取当前对话内容

**目的**：从 DOM 提取当前 Chat 对话，返回 markdown 格式文本。

> **时机**：在 3.5 发送后等待 AI 回复完成（或至少用户消息已渲染），再调用。

#### 输入

```json
{}
```

#### 预期输出（成功 — 有对话内容）

```json
{
  "conversation": "请用一句话回复：cursor-cdp 基础验证测试\n\n（AI 回复内容...）",
  "last_message": "（AI 最后一条回复的 markdown 文本）",
  "message_count": 2
}
```

#### 预期输出（空对话）

```json
{
  "conversation": "",
  "last_message": "",
  "message_count": 0
}
```

| 字段 | 说明 |
|------|------|
| `conversation` | 完整对话 markdown（已过滤 tool call、按钮等 UI 元素） |
| `last_message` | 最后一条消息的 markdown |
| `message_count` | 消息节点数量 |

#### 验收标准

- [ ] `message_count >= 1`（至少包含 3.5 发送的用户消息）
- [ ] `conversation` 包含发送的 prompt 文本片段
- [ ] 若 AI 已回复，`last_message` 非空且为 AI 侧内容

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `message_count: 0` | 对话容器选择器失效，或当前非 Chat 视图 |
| 内容不完整 | AI 仍在生成，稍后重试；或折叠块被过滤 |
| 含大量 UI 残留 | DOM 结构变更，需更新 `selectors.ts` |

---

## 4. 推荐执行顺序（端到端）

```
status (connected=true)
    ↓
list_windows (记录目标 project)
    ↓
switch_project (切换到目标项目)
    ↓
new_chat (ok=true)
    ↓
raw_send (发送测试 prompt)
    ↓
[等待 AI 回复或至少用户消息渲染]
    ↓
read (conversation 含 prompt，message_count >= 1)
```

---

## 5. 验证记录模板

复制以下模板，逐项填写实际结果：

```markdown
## 验证记录

- 日期：
- 执行人：
- Cursor 版本：
- CDP 端口：12678
- MCP 模式：stdio / http

| 步骤 | 结果 | 备注 |
|------|------|------|
| status | PASS / FAIL | |
| list_windows | PASS / FAIL | |
| switch_project | PASS / FAIL | |
| new_chat | PASS / FAIL | |
| raw_send | PASS / FAIL | |
| read | PASS / FAIL | |

### 总体结论

- [ ] 全部通过
- [ ] 部分失败（见备注）
```

---

## 6. 相关文档

- [窗口识别规则](./window-identification.md)
- [DOM 选择器调研](./dom-research.md)
- [CDP API 调研](./cdp-api-research.md)
- [MCP 注册示例](../mcp-config.example.json)

---

## 7. run_skill 高级验证清单（t45）

> 任务 t45：跨项目调用，验证 CompletionDetector 完成检测 + extractResult 结果提取。  
> **前置**：第 1 节环境就绪，且至少打开两个不同项目窗口（如 `pipeline-orchestrator` 与另一项目）。

### 7.1 验证项总览

- [ ] **跨项目调用**：`run_skill({project: "xxx", prompt: "hello"})`
- [ ] **Skill 前缀调用**：`run_skill({project: "xxx", skill: "/optimization-master", prompt: "review this"})`
- [ ] **模型切换**：`run_skill({project: "xxx", prompt: "test", model: "sonnet"})`
- [ ] **完成检测**：确认 CompletionDetector 正确返回 `complete`
- [ ] **结果提取**：确认 `response` 为纯 AI 文本（无 tool_call/thinking 噪音）
- [ ] **截图参数**：`run_skill({..., screenshot: true})` 确认截图保存

---

### 7.2 跨项目调用

**目的**：从当前 MCP 会话所在窗口，远程切换到另一已打开项目并执行 Skill。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "hello"
}
```

> 将 `project` 替换为 `list_windows` 返回的、**非当前前台**的 Editor 窗口项目名。

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "（AI 对 hello 的简短回复，纯文本）",
  "duration_ms": 15000
}
```

#### 验收标准

- [ ] `status` 为 `"complete"`
- [ ] **目视确认**：Cursor 前台窗口已切换到目标项目
- [ ] **目视确认**：目标项目 Chat 面板出现新对话及 AI 回复
- [ ] `response` 非空，为 AI 侧自然语言内容

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `status: "error"` + `Project 'xxx' not found` | 目标项目未打开或项目名拼写错误 |
| `status: "timeout"` | 默认 timeout 300s 内未完成，或网络/模型响应慢 |
| `response` 为空 | 对话 DOM 未渲染完成或 extractor 过滤过度 |

---

### 7.3 Skill 前缀调用

**目的**：验证 `skill` 参数以 `/` 开头时，自动拼接为 `/skill-name prompt` 格式发送。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "skill": "/optimization-master",
  "prompt": "review this"
}
```

> 实际发送内容为：`/optimization-master review this`

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "（optimization-master 风格的 review 回复，纯文本）",
  "duration_ms": 45000
}
```

#### 验收标准

- [ ] `status` 为 `"complete"`
- [ ] **目视确认**：对话首条用户消息以 `/optimization-master` 开头
- [ ] `response` 为 review 类结构化回复，非空

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| Skill 未触发 | `skill` 未以 `/` 开头，或 Cursor 未识别该 Skill |
| `status: "blocked"` | Skill 执行中触发 AskQuestion 或 approval 对话框 |

---

### 7.4 模型切换

**目的**：验证 `model` 参数在发送前自动切换 Composer 模型（仅当当前模型名不包含目标子串时切换）。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "test",
  "model": "sonnet"
}
```

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "（AI 对 test 的简短回复）",
  "duration_ms": 12000
}
```

#### 验收标准

- [ ] 调用前通过 `status` 确认 `model` 已含 `sonnet`（大小写不敏感子串匹配）
- [ ] `status` 为 `"complete"`
- [ ] `response` 非空

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| 模型未切换 | 当前模型名已包含 `sonnet` 子串（设计行为：跳过切换） |
| `switch_model` 静默失败 | Composer 模型选择器 DOM 变更，检查 `docs/dom-research.md` |

---

### 7.5 完成检测（CompletionDetector）

**目的**：确认 `CompletionDetector.wait()` 在 AI 生成结束后返回 `dom_ready` 或 `status_clear`，`run_skill` 映射为 `status: "complete"`。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "请用一句话介绍你自己，不要调用任何工具"
}
```

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "（一句自我介绍）",
  "duration_ms": 8000
}
```

#### 验收标准

- [ ] `status` **必须为 `"complete"`**（非 `timeout` / `blocked` / `error`）
- [ ] `duration_ms` 合理（通常 > 2000，取决于模型响应速度）
- [ ] 日志 `~/.cursor-cdp/logs/completion-*.log` 中可见 `signal: dom_ready` 或 `signal: status_clear`
- [ ] 调用 `status` 时 `busy: false`（生成已结束）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `status: "timeout"` | 任务超出 `timeout`（默认 300s）；或 send 按钮选择器失效导致无法检测完成 |
| 过早返回 `complete` | AI 仍在生成但 status 指示器已清除（偶发，可重试） |

---

### 7.6 结果提取（extractResult）

**目的**：确认 `response` 经 `extractor.ts` 过滤后，不含 tool_call、thinking、UI 噪音。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "列出 1、2、3 三个数字，仅输出数字，不要调用工具"
}
```

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "1\n2\n3",
  "duration_ms": 10000
}
```

#### 验收标准

- [ ] `response` **不包含** `<tool_call>`、`<thinking>`、`Generating...`、`Thinking...`、`Called`、`Ran command` 等字样
- [ ] `response` **不包含** 用户 prompt 原文（extractor 应剥离用户侧内容）
- [ ] 对比 `read` 返回的 `conversation`：`response` 明显更短、更干净
- [ ] 内容为 AI 最终回复的核心文本

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `response` 含 tool 摘要行 | DOM 结构变更，需更新 `extractor.ts` 过滤规则 |
| `response` 为空但 `read` 有内容 | 全部被识别为 thinking/UI 噪音而过滤 |
| `response` 含用户 prompt | extractor 用户块识别失效 |

---

### 7.7 截图参数

**目的**：验证 `screenshot: true` 在 run_skill 结束后保存当前窗口截图。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "回复 OK",
  "screenshot": true
}
```

#### 预期输出（成功）

```json
{
  "status": "complete",
  "response": "OK",
  "duration_ms": 8000,
  "screenshot_path": "/home/<user>/.cursor-cdp/screenshots/run-skill-1717654321000.png"
}
```

#### 验收标准

- [ ] `screenshot_path` 字段存在且为绝对路径
- [ ] 路径匹配模式 `~/.cursor-cdp/screenshots/run-skill-<timestamp>.png`
- [ ] 文件存在且为有效 PNG 图像
- [ ] 截图内容为当前 Cursor 窗口（含 Chat 面板）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| 无 `screenshot_path` 字段 | `screenshot` 未传 `true`，或 `screenshotTool` 执行失败（静默） |
| 文件不存在 | 目录权限问题，检查 `~/.cursor-cdp/screenshots/` 是否可写 |

---

## 8. 异常路径验证清单（t46）

> 任务 t46：验证超时、断连、blocked、项目不存在等异常路径的 status 与 error 字段。

### 8.1 验证项总览

- [ ] **超时**：设置 `timeout=5s`，发送长时间任务，确认 `status=timeout`
- [ ] **断连**：中途关闭 Cursor，确认 `status=error` + Connection lost
- [ ] **blocked**：触发 AskQuestion，确认 `status=blocked` + `blocked_reason`
- [ ] **项目不存在**：`run_skill({project: "nonexistent"})` 确认 error + 可用项目列表

---

### 8.2 超时

**目的**：验证 `CompletionDetector` 在 deadline 到达后返回 `timeout` 信号，`run_skill` 映射为 `status: "timeout"` 并返回 partial `response`。

> **注意**：`CompletionDetector` 将 `timeout` 下限钳制为 **10 秒**（`MIN_TIMEOUT_SEC=10`）。传入 `timeout: 5` 实际按 10s 计算。建议使用 `timeout: 10` 配合耗时任务验证。

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "请详细分析整个项目的架构，逐文件阅读并输出完整报告，不要跳过任何目录",
  "timeout": 10
}
```

#### 预期输出（超时）

```json
{
  "status": "timeout",
  "response": "（已生成的 partial 回复，可能为空或部分内容）",
  "duration_ms": 10500
}
```

#### 验收标准

- [ ] `status` **必须为 `"timeout"`**
- [ ] `duration_ms` ≈ `timeout * 1000`（±3s 轮询误差）
- [ ] `error` 字段**不存在**（timeout 不是 error）
- [ ] 日志中可见 `signal: timeout`
- [ ] `response` 为超时时刻已渲染的对话内容（允许 partial 或空）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `status: "complete"` | 任务在 10s 内意外快速完成；增大 prompt 复杂度或缩短 timeout |
| `status: "error"` | CDP 连接问题，非超时场景 |

---

### 8.3 断连（Connection lost）

**目的**：验证 run_skill 执行过程中 CDP 连接断开时，返回 `status: "error"` 及标准断连提示。

#### 操作步骤

1. 发起一个预计耗时 > 30s 的 `run_skill` 调用
2. **在 AI 生成过程中**关闭 Cursor 或终止 `--remote-debugging-port` 进程
3. 等待 MCP tool 返回

#### 输入

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "请详细阅读并分析 src 目录下所有 TypeScript 文件，输出完整架构文档",
  "timeout": 300
}
```

#### 预期输出（断连）

```json
{
  "status": "error",
  "error": "CDP connection lost during execution. Ensure Cursor is running with --remote-debugging-port and retry.",
  "response": "（断连前已读取的 partial 内容，可能为空）",
  "duration_ms": 25000
}
```

> 若端口被标记为不可用或需重启，error 可能为：  
> `"CDP connection dead, restart required."`

#### 验收标准

- [ ] `status` **必须为 `"error"`**
- [ ] `error` 含 `CDP connection lost` 或 `CDP connection dead`
- [ ] 不会无限挂起，应在合理时间内返回
- [ ] 后续 `status` 调用 `connected: false`（需重启 Cursor）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| 长时间无响应 | MCP Server 进程阻塞，检查 connection manager 超时逻辑 |
| `status: "timeout"` 而非 error | 断连前已到达 timeout deadline |

---

### 8.4 blocked（AskQuestion / approval）

**目的**：验证 AI 执行中触发交互阻塞（AskQuestion 或 approval 对话框）时，返回 `status: "blocked"` 及 `blocked_reason`。

#### 输入（触发 AskQuestion）

```json
{
  "project": "pipeline-orchestrator",
  "prompt": "帮我删除 node_modules 目录并清理所有 git 历史，开始前先问我确认"
}
```

> 或使用会触发 tool approval 的 prompt（如执行 shell 命令需用户批准的场景）。

#### 预期输出（blocked — AskQuestion）

```json
{
  "status": "blocked",
  "blocked_reason": "ask_question",
  "response": "（阻塞前 AI 已输出的 partial 回复）",
  "duration_ms": 30000
}
```

#### 预期输出（blocked — approval 对话框）

```json
{
  "status": "blocked",
  "blocked_reason": "approval_dialog",
  "response": "（阻塞前 partial 回复）",
  "duration_ms": 20000
}
```

#### 验收标准

- [ ] `status` **必须为 `"blocked"`**
- [ ] `blocked_reason` 为 `"ask_question"` 或 `"approval_dialog"`
- [ ] `error` 字段**不存在**
- [ ] **目视确认**：Cursor 界面存在 AskQuestion 弹窗或 Allow/Deny 批准按钮
- [ ] 日志中可见 `signal: blocked`

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `status: "complete"` | AI 未触发交互阻塞，换更激进的 prompt |
| `blocked_reason` 缺失 | DOM 检测到 blocked 但未识别具体原因（仍算部分通过） |

---

### 8.5 项目不存在

**目的**：验证目标项目未打开时，返回 `status: "error"` 并附带可用项目列表。

#### 输入

```json
{
  "project": "nonexistent",
  "prompt": "hello"
}
```

#### 预期输出（失败）

```json
{
  "status": "error",
  "error": "Project 'nonexistent' not found. Available: [pipeline-orchestrator, other-project]",
  "response": "",
  "duration_ms": 500
}
```

#### 验收标准

- [ ] `status` **必须为 `"error"`**
- [ ] `error` 含 `Project 'nonexistent' not found`
- [ ] `error` 含 `Available: [` 及当前已打开项目列表（来自 `list_windows`）
- [ ] `response` 为空字符串
- [ ] `duration_ms` 较短（未进入发送/等待阶段）

#### 失败排查

| 现象 | 可能原因 |
|------|----------|
| `Available: [(none)]` | 仅 Agent 窗口打开，无 Editor 窗口 |
| `Available: [(unable to list)]` | `list_windows` 调用失败，CDP 连接异常 |

---

## 9. run_skill 验证记录模板

复制以下模板，逐项填写 t45/t46 实际结果：

```markdown
## run_skill 高级验证记录

- 日期：
- 执行人：
- Cursor 版本：
- CDP 端口：12678

### t45 — run_skill 正常路径

| 步骤 | 结果 | 备注 |
|------|------|------|
| 跨项目调用 | PASS / FAIL | |
| Skill 前缀调用 | PASS / FAIL | |
| 模型切换 | PASS / FAIL | |
| 完成检测 (complete) | PASS / FAIL | |
| 结果提取 (纯文本) | PASS / FAIL | |
| 截图参数 | PASS / FAIL | |

### t46 — 异常路径

| 步骤 | 结果 | 备注 |
|------|------|------|
| 超时 (timeout) | PASS / FAIL | |
| 断连 (error) | PASS / FAIL | |
| blocked | PASS / FAIL | blocked_reason= |
| 项目不存在 (error) | PASS / FAIL | |

### 总体结论

- [ ] t45 全部通过
- [ ] t46 全部通过
- [ ] 部分失败（见备注）
```
