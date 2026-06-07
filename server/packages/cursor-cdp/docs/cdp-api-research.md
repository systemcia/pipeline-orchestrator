# CDP API 可用性调研 — Cursor IDE / Electron

> **Task**: 1.2-cdp-api-verify  
> **技术栈**: TypeScript + [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)  
> **调研日期**: 2026-06-06  
> **目标**: 验证 CDP API 在 Cursor Electron 环境中的可用性，为 `cursor-cdp` MCP Server 提供实现依据

---

## 1. 环境与连接

### 1.1 前置条件

Cursor 基于 Electron（Chromium + Node.js），需以 remote debugging 模式启动：

```bash
# Linux / WSL
cursor --remote-debugging-port=9222

# macOS（需完全退出后重启，Cmd+Q 而非仅关窗口）
open -a Cursor --args --remote-debugging-port=9222

# Windows（快捷方式 Target 追加）
"C:\...\Cursor.exe" --remote-debugging-port=9222
```

验证 CDP 端口可用：

```bash
curl http://127.0.0.1:9222/json
# 期望：JSON 数组，每项含 id / title / url / webSocketDebuggerUrl / type
```

### 1.2 目标选择

Cursor 是多窗口、多 Target 应用。`/json` 返回的 target 类型包括：

| type | 说明 | 操控 UI 推荐 |
|------|------|-------------|
| `page` | 渲染进程页面（Workbench UI） | **首选** — DOM/Input/Page 域均在此 |
| `browser` | 浏览器级 target | 用于 `Target.getTargets` / 跨 tab 管理 |
| `webview` | 内嵌 webview | 部分面板可能在此 |
| `background_page` | 扩展后台页 | 通常不需要 |

筛选 Workbench 主窗口示例（title 含 "Cursor" 或工作区名）：

```typescript
import CDP from 'chrome-remote-interface';

const targets = await CDP.List({ port: 9222 });
const workbench = targets.find(
  (t) => t.type === 'page' && t.title.includes('Cursor')
);
const client = await CDP({ target: workbench, port: 9222 });
```

### 1.3 chrome-remote-interface 连接模板

```typescript
import CDP from 'chrome-remote-interface';

async function connect(port = 9222) {
  const client = await CDP({ port });
  const { Page, Runtime, Input, DOM, Target } = client;

  await Promise.all([
    Page.enable(),
    Runtime.enable(),
    DOM.enable(),
  ]);

  return { client, Page, Runtime, Input, DOM, Target };
}
```

**注意**：`chrome-remote-interface` 声明兼容所有 CDP 实现（含 Electron）。连接前必须先 `List` 选定正确 target，否则默认连第一个 page。

### 1.4 本机验证状态

| 检查项 | 结果 |
|--------|------|
| `http://127.0.0.1:9222/json` 可达 | ❌ 未启动（需用户以 `--remote-debugging-port` 重启 Cursor） |
| 社区项目实证（CursorRemote / Gantry / PIDEA） | ✅ 多个项目已在生产使用 |
| 官方 CDP 协议定义 | ✅ 全部 API 均有正式 schema |

> 以下各 API 可用性评级基于：**官方协议支持 + Electron 社区实证 + VS Code/Cursor 同类项目经验**。标记 `需实测` 的项在 Cursor 启动 CDP 后应逐一跑通。

---

## 2. Electron 与 Chrome 浏览器的差异

| 维度 | Chrome 浏览器 | Electron (Cursor/VS Code) |
|------|--------------|---------------------------|
| CDP 协议支持 | 完整 | 渲染进程完整；主进程通过 Node Inspector（不同端口/ws） |
| 多调试客户端 | 支持多个同时连接 | **单 target 仅支持一个调试连接**（打开内置 DevTools 会导致外部 CDP 断连） |
| 进程模型 | 单浏览器多 tab | Main（Node）+ 多 Renderer（每窗口/iframe） |
| `Runtime.evaluate` 上下文 | 页面 JS | 页面 JS；主进程需连 Node Inspector target |
| 安全限制 | 常规 CSP | Cursor 可能有 `contextIsolation` / sandbox，部分 DOM 在 shadow DOM 内 |
| 后台节流 | 标准 | 窗口失焦时 DOM 提取可能被 throttle（CursorRemote 有 `stale` 状态报告） |
| 快捷键 | 标准 | 部分快捷键由 Electron 菜单/主进程拦截，不一定到达 renderer |

**关键坑点**：
1. 不要同时打开 Cursor 内置 DevTools（Help → Toggle Developer Tools）和外部 CDP 客户端
2. 操控 UI 必须 attach 到 **renderer `page` target**，不是 `browser` target
3. VS Code Extension Host 进程**不**出现在 `9222/json` 列表中（见 [node-cdp-ws 实验](https://github.com/TomasHubelbauer/node-cdp-ws)），无法通过 CDP 直接操控扩展逻辑
4. Workbench UI 大量使用自定义组件（Monaco Editor、Shadow DOM），`querySelector` 选择器需逆向工程

---

## 3. API 详细调研

### 3.1 Runtime.evaluate

**可用性**: ✅ 可用（渲染进程 page target）  
**用途**: 在页面上下文执行 JS，查询/操作 DOM

#### 参数格式

```json
{
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.querySelector('.title')?.textContent",
    "returnByValue": true,
    "awaitPromise": false,
    "silent": false,
    "userGesture": false
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `expression` | string | **必填**。要执行的 JS 表达式 |
| `returnByValue` | boolean | `true` 时直接返回 JSON 可序列化值（推荐） |
| `awaitPromise` | boolean | 表达式返回 Promise 时等待 resolve |
| `contextId` | number | 指定 execution context（多 iframe 时有用） |
| `uniqueContextId` | string | 跨进程导航时更可靠的 context 标识 |
| `timeout` | number | 超时毫秒数；**不可设 0 或空**（会报 Execution was terminated） |
| `userGesture` | boolean | 标记为用户手势触发（影响 autoplay 等） |
| `silent` | boolean | 静默模式，异常不暂停 |

#### 返回值

```json
{
  "result": {
    "type": "string",
    "value": "Hello"
  },
  "exceptionDetails": null
}
```

失败时 `exceptionDetails` 含 `text`、`lineNumber`、`columnNumber`。

#### chrome-remote-interface 用法

```typescript
const { result, exceptionDetails } = await Runtime.evaluate({
  expression: `(() => {
    const el = document.querySelector('[data-testid="chat-input"]');
    return el ? { found: true, tag: el.tagName } : { found: false };
  })()`,
  returnByValue: true,
});

if (exceptionDetails) throw new Error(exceptionDetails.text);
console.log(result.value);
```

#### 推荐用法

- DOM 查询优先用 `Runtime.evaluate` + `returnByValue: true`，比 `DOM.querySelector` 链式调用更简洁
- 复杂操作封装为 IIFE，避免序列化问题
- 需要点击元素时，可在 evaluate 内 `element.click()`（比 `dispatchMouseEvent` 更简单可靠）

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 返回值是 RemoteObject | 未设 `returnByValue` 时拿到 objectId，需 `Runtime.getProperties` 二次读取 | 始终设 `returnByValue: true` |
| CSP 阻止 eval | 严格 CSP 页面可能阻止 | 设 `allowUnsafeEvalBlockedByCSP: true` |
| 跨 frame 上下文 | 默认在主 frame 执行 | 用 `contextId` 或 `DOM.getFrameOwner` 定位 |
| Electron 主进程 | 连 page target 无法访问 `require('fs')` 等 Node API | 主进程操控不走此 API |
| Monaco Editor | `innerText` 拿不到编辑器内容 | 需找 Monaco API 或 `editor.getValue()` 专用选择器 |

---

### 3.2 Input.insertText

**可用性**: ✅ 可用（Experimental 标记，但 Electron/Chromium 已实现）  
**用途**: 向**当前焦点元素**注入文本（不模拟按键）

#### 参数格式

```json
{
  "method": "Input.insertText",
  "params": {
    "text": "Hello, Cursor!"
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `text` | string | **必填**。要插入的文本 |

#### 返回值

空对象 `{}`（无错误即成功）。

#### chrome-remote-interface 用法

```typescript
// 先聚焦目标输入框
await Runtime.evaluate({
  expression: `document.querySelector('.chat-input')?.focus()`,
});
await Input.insertText({ text: '帮我写个函数' });
```

#### 推荐用法

- 聊天输入、搜索框等**纯文本注入**场景首选
- 配合 `Runtime.evaluate` 先 `focus()` 目标元素
- 比 `dispatchKeyEvent` 逐字符输入快几个数量级

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 无焦点不生效 | 必须已有 focused element | 先 evaluate `element.focus()` |
| 不触发 input 事件链 | 某些框架（React controlled input）可能不响应 | 改用 evaluate 设置 `value` + 手动 `dispatchEvent(new Event('input'))` |
| Monaco / CodeMirror | 标准 input/textarea 外的编辑器无效 | 用编辑器专用 API 或 `dispatchKeyEvent` |
| 不处理换行语义 | 插入 `\n` 行为取决于当前焦点元素 | 聊天框可用；代码编辑器慎用 |
| Experimental 标记 | 协议标注 Experimental，但 chromedp/Puppeteer 均广泛使用 | 实测通过即可纳入生产 |

---

### 3.3 Input.dispatchMouseEvent

**可用性**: ✅ 可用  
**用途**: 模拟鼠标点击、移动、滚轮

#### 参数格式

```json
{
  "method": "Input.dispatchMouseEvent",
  "params": {
    "type": "mousePressed",
    "x": 307.5,
    "y": 35.5,
    "button": "left",
    "clickCount": 1,
    "modifiers": 0
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | **必填**。`mousePressed` / `mouseReleased` / `mouseMoved` / `mouseWheel` |
| `x`, `y` | number | **必填**。相对主 frame viewport 的 CSS 像素坐标 |
| `button` | string | `none` / `left` / `middle` / `right` / `back` / `forward` |
| `clickCount` | integer | 点击次数（双击 = 2） |
| `modifiers` | integer | 位掩码：Alt=1, Ctrl=2, Meta=4, Shift=8 |
| `buttons` | integer | 按下按钮掩码：Left=1, Right=2, Middle=4 |
| `deltaX`, `deltaY` | number | 滚轮事件专用 |

完整点击需 **press + release** 两个事件：

```typescript
async function clickAt(x: number, y: number) {
  await Input.dispatchMouseEvent({
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await Input.dispatchMouseEvent({
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}
```

#### 返回值

空对象 `{}`。

#### 坐标获取

CDP Input 域不接受 CSS 选择器，需先用 DOM 域或 evaluate 算坐标：

```typescript
// 方式 A：Runtime.evaluate（推荐）
const { result } = await Runtime.evaluate({
  expression: `(() => {
    const el = document.querySelector('.target');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`,
  returnByValue: true,
});
await clickAt(result.value.x, result.value.y);

// 方式 B：DOM.getBoxModel（更精确，适合复杂布局）
```

#### 推荐用法

- 简单点击：优先 `Runtime.evaluate(() => el.click())` 
- 需要真实鼠标事件链（hover、drag、右键菜单）：用 `dispatchMouseEvent`
- Gantry / CursorRemote 等项目用此 API 点击聊天按钮、模式切换等

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 坐标系 | 相对 viewport 而非屏幕 | 用 `getBoundingClientRect()` |
| 缺 release 事件 | 只发 pressed 导致按下状态挂起 | press + release 成对发送 |
| 缩放 / HiDPI | deviceScaleFactor 影响坐标 | 先 `Page.getLayoutMetrics` 获取 `visualViewport` |
| 元素不可见 | 被遮挡或 `display:none` | evaluate 检查 `offsetParent` / `getClientRects()` |
| iframe 内元素 | 坐标需加 iframe offset | 用 `DOM.getFrameOwner` 累加偏移 |

---

### 3.4 Input.dispatchKeyEvent

**可用性**: ✅ 可用  
**用途**: 模拟键盘按键，包括快捷键（Ctrl+N、Ctrl+Shift+P 等）

#### 参数格式

```json
{
  "method": "Input.dispatchKeyEvent",
  "params": {
    "type": "rawKeyDown",
    "key": "n",
    "code": "KeyN",
    "windowsVirtualKeyCode": 78,
    "nativeVirtualKeyCode": 78,
    "modifiers": 2
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | **必填**。`keyDown` / `keyUp` / `rawKeyDown` / `char` |
| `key` | string | DOM key 值，如 `Enter`、`Control`、`n` |
| `code` | string | 物理键，如 `KeyN`、`ControlLeft` |
| `text` | string | `char` 事件生成的文本 |
| `modifiers` | integer | Alt=1, Ctrl=2, Meta=4, Shift=8（可组合，如 Ctrl+Shift=10） |
| `windowsVirtualKeyCode` | integer | Windows 虚拟键码 |
| `nativeVirtualKeyCode` | integer | 原生虚拟键码 |

#### Ctrl+N 示例（Windows/Linux）

```typescript
const CTRL = 2;

// keyDown Ctrl
await Input.dispatchKeyEvent({
  type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
  windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: CTRL,
});
// keyDown N（带 Ctrl modifier）
await Input.dispatchKeyEvent({
  type: 'rawKeyDown', key: 'n', code: 'KeyN',
  windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: CTRL,
});
// keyUp N
await Input.dispatchKeyEvent({
  type: 'keyUp', key: 'n', code: 'KeyN',
  windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: CTRL,
});
// keyUp Ctrl
await Input.dispatchKeyEvent({
  type: 'keyUp', key: 'Control', code: 'ControlLeft',
  windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
});
```

macOS 将 `modifiers` 中 Ctrl 换为 Meta（`modifiers: 4`），`key` 用 `Meta`。

#### 返回值

空对象 `{}`。

#### 推荐用法

- 特殊键（Enter、Tab、Escape、方向键）：单个 `rawKeyDown` + `keyUp`
- 快捷键：modifier 键先 down，字母键 down/up，modifier 再 up
- 纯文本输入优先 `Input.insertText`，键盘事件仅用于快捷键和特殊键

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| Electron 菜单拦截 | Ctrl+N / Ctrl+S 等可能被主进程菜单处理，renderer 收不到 | 部分快捷键有效（如 Ctrl+Shift+P 命令面板）；无效时需 alternative（evaluate 调 command） |
| 平台键位差异 | macOS Meta vs Windows Ctrl | 抽象 `KeyCombo` 层按平台映射 |
| 缺少 key/code | 部分应用不响应 | 同时提供 `key`、`code`、`windowsVirtualKeyCode` |
| 输入法干扰 | IME 组合键场景复杂 | 文本注入用 `insertText` 绕过 |
| 需焦点 | 快捷键发送到当前焦点窗口/元素 | 先 `Target.activateTarget` + `Page.bringToFront` |

---

### 3.5 Page.captureScreenshot

**可用性**: ✅ 可用  
**用途**: 截取当前页面（viewport）截图，用于状态确认和调试

#### 参数格式

```json
{
  "method": "Page.captureScreenshot",
  "params": {
    "format": "png",
    "quality": 80,
    "captureBeyondViewport": false,
    "fromSurface": true
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `format` | string | `png`（默认）/ `jpeg` / `webp` |
| `quality` | integer | JPEG 质量 0-100 |
| `clip` | object | `{ x, y, width, height, scale }` 截取区域 |
| `fromSurface` | boolean | 从 surface 而非 view 捕获（默认 true） |
| `captureBeyondViewport` | boolean | 是否截取视口外内容（默认 false） |
| `optimizeForSpeed` | boolean | 优先速度而非体积 |

#### 返回值

```json
{
  "data": "<base64-encoded-image>"
}
```

#### chrome-remote-interface 用法

```typescript
const { data } = await Page.captureScreenshot({ format: 'png' });
const buffer = Buffer.from(data, 'base64');
// 写入文件或返回给 MCP 调用方
```

#### 推荐用法

- 操作前后截图对比，验证 UI 状态
- 传给 Vision 模型做 UI 理解（CursorRemote / Gantry 均用此思路）
- 不需要逐元素坐标时，截图 + AI 识别是 fallback 方案

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 仅 viewport | 默认不截全页 | 设 `captureBeyondViewport: true` 或先滚动拼接 |
| 弹窗/下拉 | 非 DOM 层叠元素可能不完整 | 截图前等待 UI 稳定（`setTimeout` / `Page.lifecycleEvent`） |
| 深色主题 | 不影响 API，但影响 AI 识别 | 固定主题或训练时考虑 |
| 体积大 | 全屏 PNG 可达数百 KB | 用 `jpeg` + `quality` 或 `clip` 缩小区域 |
| 需先 enable | 未 `Page.enable()` 会失败 | 连接时统一 enable |

---

### 3.6 Target.getTargets

**可用性**: ✅ 可用（需在 browser target 或已 flatten 的 session 上调用）  
**用途**: 列出所有可调试 target（窗口/tab/webview）

#### 参数格式

```json
{
  "method": "Target.getTargets",
  "params": {}
}
```

可选 `filter` 参数（Experimental）过滤 target 类型。

#### 返回值

```json
{
  "targetInfos": [
    {
      "targetId": "ABC...",
      "type": "page",
      "title": "workspace - Cursor",
      "url": "vscode-file://vscode-app/...",
      "attached": false,
      "canAccessOpener": false
    }
  ]
}
```

#### chrome-remote-interface 用法

```typescript
// 方式 A：HTTP 发现（更简单）
const targets = await CDP.List({ port: 9222 });

// 方式 B：CDP 命令（需在 browser 级连接）
const { targetInfos } = await Target.getTargets();
const pages = targetInfos.filter((t) => t.type === 'page');
```

#### 推荐用法

- 启动时 `List` 枚举所有 page，按 `title` / `url` 匹配 Cursor 主窗口
- 监听 `Target.targetCreated` / `Target.targetDestroyed` 感知窗口开关
- 多工作区场景按 title 区分

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 列表会变化 | 打开新窗口/面板会新增 target | 缓存 targetId，失效时重新 List |
| title 不稳定 | 随打开文件变化 | 用 `url` 含 `vscode-file://` + title 后缀 `- Cursor` 组合判断 |
| browser vs page | `getTargets` 在 page session 行为可能受限 | 优先 HTTP `/json` 或连 browser target |
| attached 状态 | 已被其他客户端 attach 的 target 不可再连 | 避免多客户端抢连 |

---

### 3.7 Target.activateTarget

**可用性**: ✅ 可用  
**用途**: 聚焦指定 target 对应窗口（切到前台）

#### 参数格式

```json
{
  "method": "Target.activateTarget",
  "params": {
    "targetId": "ABC..."
  }
}
```

#### 返回值

空对象 `{}`。

#### chrome-remote-interface 用法

```typescript
await Target.activateTarget({ targetId: workbenchTarget.id });
await Page.bringToFront(); // 配合 Page 域确保窗口前台
```

#### 推荐用法

- 多 Cursor 窗口时，操作前先 `activateTarget` 确保事件发到正确窗口
- 配合 `Input.*` 前调用，避免键鼠事件发到后台窗口

#### 坑点

| 坑 | 说明 | 规避 |
|----|------|------|
| 仅聚焦窗口 | 不保证 OS 级前台（尤其 Linux WM） | 加 `Page.bringToFront()` |
| WSL / 远程桌面 | 无头或远程环境可能无法真正聚焦 | 检测环境，降级为不依赖焦点的 evaluate 方案 |
| targetId 过期 | 窗口关闭后 id 失效 | 操作前重新 getTargets |

---

## 4. 推荐调用时序

典型「向 Cursor 聊天框发送消息」流程：

```
1. CDP.List()                     → 找到 workbench page target
2. CDP({ target })                → 建立连接
3. Page.enable() + Runtime.enable()
4. Target.activateTarget()        → 聚焦窗口
5. Runtime.evaluate()             → 定位聊天输入框、检查可见性
6. Runtime.evaluate()             → input.focus()
7. Input.insertText()             → 注入用户消息
8. Input.dispatchMouseEvent()     → 点击发送按钮（或 evaluate click）
9. Page.captureScreenshot()       → 确认发送成功
```

典型「执行快捷键打开命令面板」流程：

```
1. Target.activateTarget()
2. Page.bringToFront()
3. Input.dispatchKeyEvent() × N   → Ctrl+Shift+P (platform-specific)
4. Runtime.evaluate()             → 等待命令面板 DOM 出现
5. Input.insertText()             → 输入命令名
6. Input.dispatchKeyEvent()       → Enter
```

---

## 5. 验证清单（Cursor 启动后执行）

```bash
# 0. 确认 CDP 端口
curl -s http://127.0.0.1:9222/json | jq '.[].title'

# 1. Runtime.evaluate — 获取页面 title
# 2. Input.insertText — 向焦点元素输入文本
# 3. Input.dispatchMouseEvent — 点击指定坐标
# 4. Input.dispatchKeyEvent — 发送 Enter 键
# 5. Page.captureScreenshot — 保存 base64 截图
# 6. Target.getTargets — 列出所有 target
# 7. Target.activateTarget — 切换窗口聚焦
```

可用 `chrome-remote-interface` CLI 快速验证：

```bash
npx chrome-remote-interface inspect --port=9222
# 交互式执行 Runtime.evaluate({ expression: "document.title" })
```

---

## 6. 结论

| API | Cursor Electron 可用性 | 推荐优先级 | 主要风险 |
|-----|----------------------|-----------|---------|
| `Runtime.evaluate` | ✅ 可用 | **P0** | Monaco/Shadow DOM 选择器 |
| `Input.insertText` | ✅ 可用 | **P0** | 需先 focus；框架响应 |
| `Input.dispatchMouseEvent` | ✅ 可用 | **P1** | 坐标计算；press/release 成对 |
| `Input.dispatchKeyEvent` | ✅ 可用 | **P1** | 主进程拦截部分快捷键 |
| `Page.captureScreenshot` | ✅ 可用 | **P1** | 体积/视口限制 |
| `Target.getTargets` | ✅ 可用 | **P0** | 多窗口 target 管理 |
| `Target.activateTarget` | ✅ 可用 | **P1** | 远程/无头环境聚焦 |

**总结**：CDP API 在 Cursor Electron 渲染进程上**整体可用**，已有 CursorRemote、Gantry、PIDEA 等开源项目实证。核心挑战不在 API 本身，而在于：

1. Workbench UI 的 **DOM 选择器逆向**
2. **单调试连接**限制（不可与内置 DevTools 共存）
3. **Monaco Editor** 等自定义组件的输入模拟
4. 部分**快捷键被 Electron 主进程拦截**

建议 `cursor-cdp` 实现策略：
- 文本注入 → `Input.insertText` + evaluate focus
- DOM 查询 → `Runtime.evaluate` + `returnByValue`
- 点击 → 优先 evaluate `click()`，复杂交互用 `dispatchMouseEvent`
- 快捷键 → `dispatchKeyEvent`，失败时 fallback 到命令面板 evaluate
- 窗口管理 → `CDP.List` + `Target.activateTarget`
- 状态确认 → `Page.captureScreenshot`

---

## 7. 参考来源

- [Chrome DevTools Protocol 官方文档](https://chromedevtools.github.io/devtools-protocol/)
- [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)
- [CursorRemote Setup Guide](https://github.com/len5ky/CursorRemote/blob/HEAD/docs/setup-guide.md) — Cursor `--remote-debugging-port` 配置
- [Gantry](https://github.com/uhaop/Gantry) — CDP 自动化 Cursor/Windsurf/VS Code
- [electron-dev-bridge](https://github.com/delta-and-beta/electron-dev-bridge) — 33 个 CDP 内置工具
- [VS Code #46062](https://github.com/Microsoft/vscode/issues/46062) — Electron 单调试连接限制
- [node-cdp-ws VS Code 实验](https://github.com/TomasHubelbauer/node-cdp-ws) — Extension Host 不可通过 9222 attach
- [PIDEA Cursor Setup](https://github.com/fr4iser90/PIDEA) — 多端口 Cursor 调试配置
