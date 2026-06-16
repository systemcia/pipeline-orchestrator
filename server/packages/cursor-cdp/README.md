# cursor-cdp

通过 Chrome DevTools Protocol (CDP) 远程操控 Cursor IDE 的 MCP Server。将 Cursor 的 UI 自动化能力封装为标准 MCP Tools，使 Skill、CI/CD、Shell 脚本等外部调用方能够跨项目触发 Cursor 执行指令并获取结构化结果。

本包是 [Pipeline Orchestrator](https://github.com/pipeline-orchestrator) 远程调度能力的基础设施，适用于「外部系统调起 Cursor 跑 Skill」场景；同 IDE 实例内的 SubAgent 编排仍优先使用 Cursor 内置 `[Task]` 机制。

---

## 快速开始

### 1. 安装与构建

```bash
cd server/packages/cursor-cdp
npm install
npm run build
```

### 2. 开启 Cursor CDP 调试端口

Cursor 需以 `--remote-debugging-port` 启动后，MCP Server 才能连接。本项目默认端口 **12678**（可在 `cursor-cdp.config.json` 中修改）。

启动后验证：

```bash
curl http://127.0.0.1:12678/json
# 期望返回 JSON 数组，含 page target 列表
```

#### macOS

**方式 A：`~/.cursor-flags`（推荐）**

```bash
echo '--remote-debugging-port=12678' > ~/.cursor-flags
```

完全退出 Cursor（`Cmd+Q`），重新打开。

**方式 B：命令行启动**

```bash
open -a Cursor --args --remote-debugging-port=12678
```

**方式 C：修改 Info.plist**

编辑 `/Applications/Cursor.app/Contents/Info.plist`，在 `LSEnvironment` 或启动参数相关字段追加 `--remote-debugging-port=12678`。App 升级后可能覆盖，不推荐长期使用。

#### Linux / WSL2

**方式 A：`.desktop` 文件**

编辑 `~/.local/share/applications/cursor.desktop`（或系统级 `/usr/share/applications/cursor.desktop`），修改 `Exec` 行：

```ini
Exec=/usr/bin/cursor --remote-debugging-port=12678 %F
```

**方式 B：Shell alias**

```bash
# ~/.bashrc 或 ~/.zshrc
alias cursor='cursor --remote-debugging-port=12678'
```

**方式 C：直接命令行**

```bash
cursor --remote-debugging-port=12678
```

#### Windows

1. 右键 Cursor 快捷方式 → **属性**
2. 在「目标」字段末尾追加参数（注意与路径之间有空格）：

```
"C:\Users\<you>\AppData\Local\Programs\cursor\Cursor.exe" --remote-debugging-port=12678
```

3. 通过该快捷方式启动 Cursor（任务栏固定项需重新固定）

> **注意**：仅关闭窗口不会释放 CDP 端口；修改启动参数后须完全退出 Cursor 再重启。多实例并行时，每个实例使用不同端口（如 12678、9227）。

### 3. 注册 MCP Server

将 `mcp-config.example.json` 中的配置合并到你的 MCP 配置文件：

| 作用域 | 路径 |
|--------|------|
| 项目级（推荐） | `<项目>/.cursor/mcp.json` |
| 全局 | `~/.cursor/mcp.json` |

示例（**替换为实际绝对路径**）：

```json
{
  "mcpServers": {
    "cursor-cdp": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/pipeline-orchestrator/server/packages/cursor-cdp/dist/index.js"
      ],
      "cwd": "/ABSOLUTE/PATH/TO/pipeline-orchestrator/server/packages/cursor-cdp",
      "env": {}
    }
  }
}
```

可选环境变量：

```json
"env": {
  "CURSOR_CDP_CONFIG": "/path/to/my-config.json"
}
```

注册后重启 Cursor，在 **Settings → MCP** 确认 `cursor-cdp` 状态为 `connected`，或调用 `status` tool 验证。

---

## 使用方式

### stdio 模式（默认）

Cursor MCP 直连，由 Cursor 以子进程方式拉起 Server，通过 stdin/stdout 通信。适合本地开发，零额外部署。

```bash
npm start
# 等价于 node dist/index.js
```

MCP 配置中使用 `command` + `args` 形式（见上文示例），无需手动启动。

### HTTP/SSE 模式

面向远程机器、CI/CD 等无法使用 stdio 的场景。Server 以 HTTP 服务暴露 MCP SSE 传输层。

```bash
npm run start:http
# 等价于 node dist/index.js --transport=http --port=18099
```

自定义端口：

```bash
node dist/index.js --transport=http --port=18099
```

端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/sse` | 建立 SSE 流，返回 `sessionId` |
| `POST` | `/message?sessionId=<id>` | 发送 MCP 消息 |

支持 MCP SSE 传输的客户端（如部分 Agent 框架）可直连 `http://<host>:18099/sse`。Cursor 内置 MCP 注册仅支持 stdio，远程场景需在调用方侧配置 SSE 端点。

---

## 可用 Tools

| Tool | 说明 | 主要参数 |
|------|------|----------|
| `status` | 查询 CDP 连接状态、当前项目/模型/窗口类型 | `port?` |
| `list_windows` | 列出所有 Cursor 窗口及项目信息 | `port?` |
| `switch_project` | 切换到指定项目窗口 | `project`, `port?` |
| `switch_model` | 切换 AI 模型（支持模糊匹配） | `model`, `port?` |
| `new_chat` | 新建对话 | `port?` |
| `read` | 读取当前对话内容 | `port?` |
| `screenshot` | 截取当前窗口 | `path?`, `port?` |
| `raw_send` | 发送 prompt，不等待完成 | `prompt`, `port?` |
| `run_skill` | 完整编排：切项目 → 发指令 → 等待完成 → 提取结果 | `project`, `prompt`, `skill?`, `model?`, `timeout?`, `screenshot?`, `attachments?`, `port?` |

所有 tool 的 `port` 参数可选，省略时使用配置文件中的 `default_port`（默认 12678）。

`run_skill` 是核心 tool，典型用法：

```json
{
  "project": "my-app",
  "skill": "/optimization-master",
  "prompt": "review 这段代码的性能问题",
  "timeout": 300
}
```

返回 `status` 字段：`complete` | `timeout` | `blocked` | `error`。

---

## 配置文件

配置文件 `cursor-cdp.config.json`，查找优先级：

1. 环境变量 `CURSOR_CDP_CONFIG` 指定的路径
2. 进程工作目录下的 `cursor-cdp.config.json`
3. `~/.cursor-cdp/config.json`

示例：

```json
{
  "default_port": 12678,
  "cdp_host": "localhost",
  "default_model": "opus",
  "default_timeout": 300,
  "log_dir": "~/.cursor-cdp/logs/"
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default_port` | number | `12678` | CDP 调试端口 |
| `cdp_host` | string | `localhost` | CDP 主机地址；WSL NAT 模式下自动探测 Windows 主机 IP |
| `default_model` | string | — | `run_skill` 未指定 model 时的默认模型（模糊匹配） |
| `default_timeout` | number | `300` | `run_skill` 默认超时秒数（最大 1800） |
| `log_dir` | string | `~/.cursor-cdp/logs/` | 结构化日志目录，按日轮转 |

---

## systemd 部署（HTTP 模式）

HTTP/SSE 模式适合以 systemd user service 常驻。以下为手动部署示例（将路径替换为实际值）：

```bash
NODE_BIN=$(command -v node)
CDP_PKG=/ABSOLUTE/PATH/TO/server/packages/cursor-cdp
UDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$UDIR"
cat > "$UDIR/cursor-cdp.service" <<EOF
[Unit]
Description=cursor-cdp MCP Server (HTTP/SSE :18099)
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN dist/index.js --transport=http --port=18099
WorkingDirectory=$CDP_PKG
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now cursor-cdp
```

常用命令：

```bash
systemctl --user status cursor-cdp    # 查看状态
systemctl --user restart cursor-cdp   # 重启
journalctl --user -u cursor-cdp -f    # 查看日志
```

> **前提**：目标机器上的 Cursor 仍需以 `--remote-debugging-port` 启动。systemd 仅托管 MCP Server 进程，不托管 Cursor 本身。

---

## SSH 隧道（远程访问）

CDP 端口仅绑定 `localhost`，无认证机制，**禁止直接暴露公网**。远程访问须通过 SSH 隧道。

### 隧道 CDP 端口（操控远程 Cursor）

在本地执行：

```bash
ssh -N -L 12678:127.0.0.1:12678 user@remote-host
```

本地 MCP Server 连接 `localhost:12678` 即等价于操控远程 Cursor。多实例时按需映射多个端口：

```bash
ssh -N \
  -L 12678:127.0.0.1:12678 \
  -L 9227:127.0.0.1:9227 \
  user@remote-host
```

### 隧道 MCP HTTP 端口（远程调用 MCP Server）

若 cursor-cdp 以 HTTP 模式运行在远程机器：

```bash
ssh -N -L 18099:127.0.0.1:18099 user@remote-host
```

本地客户端连接 `http://localhost:18099/sse`。

### 反向隧道（远程 CI 回调本地 Cursor）

本地 Cursor + 本地 cursor-cdp，远程 CI 通过反向隧道访问：

```bash
# 在本地执行，将本地 18099 暴露到远程
ssh -N -R 18099:127.0.0.1:18099 user@ci-host
```

---

## WSL 跨系统部署

适用于 **Cursor 在 Windows 运行、cursor-cdp 在 WSL 中运行** 的场景（如通过 Remote-WSL 打开项目）。

### 网络连通

Cursor 的 CDP 端口（12678）绑定在 Windows 的 `localhost`。从 WSL 中连接取决于 WSL2 网络模式：

| 模式 | 版本要求 | `cdp_host` 设置 |
|------|----------|-----------------|
| Mirrored（推荐） | Win11 22H2+ | `localhost`（默认即可） |
| NAT（默认） | 所有版本 | Windows 主机 IP（自动探测） |

**自动探测**：当检测到 `WSL_DISTRO_NAME` 环境变量时，cursor-cdp 自动从 `/etc/resolv.conf` 读取 Windows 主机 IP。也可通过环境变量或配置文件手动指定：

```bash
# 环境变量覆盖
export CURSOR_CDP_HOST=172.25.64.1

# 或配置文件
echo '{"cdp_host": "172.25.64.1"}' > ~/.cursor-cdp/config.json
```

验证连通性：

```bash
curl http://${CURSOR_CDP_HOST:-localhost}:12678/json
```

### MCP 注册（wsl.exe 桥接）

Windows 端 Cursor 通过 stdio 启动 WSL 中的 node 进程：

```json
{
  "mcpServers": {
    "cursor-cdp": {
      "command": "wsl.exe",
      "args": [
        "-e", "node",
        "/home/go/src/pipeline-orchestrator/server/packages/cursor-cdp/dist/index.js"
      ]
    }
  }
}
```

> `wsl.exe -e` 直接在默认发行版中执行命令，stdin/stdout 透传到 Cursor。
> 如有多个发行版，使用 `wsl.exe -d <distro> -e node ...`。

### 开启 Mirrored 模式（推荐）

编辑 `%UserProfile%\.wslconfig`：

```ini
[wsl2]
networkingMode=mirrored
```

重启 WSL（`wsl --shutdown`）后生效。Mirrored 模式下 WSL 与 Windows 共享 localhost，无需额外配置 `cdp_host`。

---

## 目录结构

```
server/packages/cursor-cdp/
├── src/
│   ├── index.ts          # MCP Server 入口（stdio / HTTP 双模式）
│   ├── connection.ts     # CDP 连接管理（重连、健康检查、端口互斥）
│   ├── completion.ts       # 完成检测（DOM + 状态标志 + 超时）
│   ├── tools/              # MCP Tools 实现
│   └── ...
├── cursor-cdp.config.json  # 默认配置
├── mcp-config.example.json # MCP 注册示例
└── README.md
```

## 故障排查

| 现象 | 排查 |
|------|------|
| `connected: false` | 确认 Cursor 以 `--remote-debugging-port=12678` 启动，`curl http://127.0.0.1:12678/json` 可达 |
| MCP 未连接 | 检查 `mcp.json` 中 `args`/`cwd` 路径、`npm run build` 是否已执行 |
| `run_skill` 超时 | 增大 `timeout`（最大 1800）；检查 Cursor 是否弹出 AskQuestion（返回 `blocked`） |
| 切项目失败 | 调用 `list_windows` 确认 `project` 名称与窗口标题一致 |
| 端口占用 | 多实例各用独立端口；完全退出旧 Cursor 进程后重启 |

日志位置：`~/.cursor-cdp/logs/cursor-cdp-YYYY-MM-DD.log`
