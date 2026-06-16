# cursor-cdp WSL + Windows 部署配置记录

> 最后验证时间：2026-06-06  
> 环境：Windows 10/11 + WSL2 Ubuntu-20.04 + Cursor 3.0.12 (Electron 39.8.1 / Chrome 142)

---

## 架构概览

```
┌─────────────────────────────────────────────────┐
│  Windows                                        │
│  ┌────────────┐     CDP (localhost:12678)       │
│  │  Cursor IDE│◄────────────────────────────┐   │
│  └────────────┘                             │   │
│                                             │   │
│  ┌────────────────────────────┐             │   │
│  │  Windows Node.js (node.exe)│             │   │
│  │  cursor-cdp MCP Server     │─────────────┘   │
│  │  via \\wsl$ UNC path       │                 │
│  └────────────────────────────┘                 │
│       ▲ stdio (MCP协议)                         │
│       │                                         │
│  Cursor MCP Subprocess                          │
└─────────────────────────────────────────────────┘
```

关键设计决策：
- **MCP 服务器运行在 Windows Node.js 上**（而非 WSL Node），避免 WSL2 NAT 网络隔离问题
- **代码文件通过 `\\wsl$` UNC 路径访问**，无需在 Windows 侧复制代码
- **CDP 调试端口通过 `ELECTRON_EXTRA_LAUNCH_ARGS` 环境变量启用**，重启/更新不丢失

---

## 配置清单

### 1. Windows 用户环境变量

**作用**：让 Cursor (Electron) 启动时开启 CDP 调试端口

```
变量名：ELECTRON_EXTRA_LAUNCH_ARGS
变量值：--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0
存储位置：HKCU\Environment（用户级注册表）
```

**设置命令**（PowerShell）：
```powershell
[System.Environment]::SetEnvironmentVariable(
    'ELECTRON_EXTRA_LAUNCH_ARGS',
    '--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0',
    'User'
)
```

**验证命令**：
```powershell
[System.Environment]::GetEnvironmentVariable('ELECTRON_EXTRA_LAUNCH_ARGS', 'User')
# 期望输出：--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0
```

**注意**：设置后需广播 WM_SETTINGCHANGE 或注销重新登录，Explorer 才能感知新环境变量。

<details>
<summary>广播 WM_SETTINGCHANGE 的 PowerShell 脚本</summary>

```powershell
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinEnvBroadcast {
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@
$r = [UIntPtr]::Zero
[WinEnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$r)
```
</details>

---

### 2. Windows Cursor mcp.json

**路径**：`C:\Users\WPS\.cursor\mcp.json`（即 `%USERPROFILE%\.cursor\mcp.json`）

**cursor-cdp 条目**：
```json
{
  "mcpServers": {
    "cursor-cdp": {
      "command": "node",
      "args": [
        "\\\\wsl$\\Ubuntu-20.04\\home\\go\\src\\pipeline-orchestrator\\server\\packages\\cursor-cdp\\dist\\index.js"
      ]
    }
  }
}
```

**说明**：
- `command` 使用 Windows 侧的 `node.exe`（D:\Program Files\nodejs\node.exe）
- `args` 通过 `\\wsl$\Ubuntu-20.04\...` UNC 路径访问 WSL 中的代码
- 不使用 `wsl.exe` 桥接，避免 WSL2 NAT 网络隔离导致 CDP 连不上
- 依赖项全部是纯 JS（无 native 模块），跨平台兼容无问题

---

### 3. WSL 侧 mcp.json（OpenClaw/本地 Cursor）

**路径**：`/home/systemcia/.cursor/mcp.json`

**cursor-cdp 条目**：
```json
{
  "mcpServers": {
    "cursor-cdp": {
      "command": "/mnt/d/Program Files/nodejs/node.exe",
      "args": [
        "\\\\wsl$\\Ubuntu-20.04\\home\\go\\src\\pipeline-orchestrator\\server\\packages\\cursor-cdp\\dist\\index.js"
      ]
    }
  }
}
```

**说明**：
- 同样使用 **Windows Node.exe**（通过 `/mnt/d/...` 路径从 WSL 调用），避免 WSL2 NAT 网络隔离
- 代码文件通过 `\\wsl$` UNC 路径访问
- 与 Windows Cursor 的 mcp.json 配置原理一致，只是 command 路径格式不同（WSL 路径 vs Windows 路径）

---

### 4. 任务栏快捷方式（辅助）

**路径**：`%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Cursor.lnk`

**参数**：`--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0`

**设置命令**（PowerShell）：
```powershell
$lnkPath = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Cursor.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.Arguments = "--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0"
$shortcut.Save()
```

**注意**：Cursor 更新可能重建快捷方式导致参数丢失，环境变量是主力兜底。

---

### 5. argv.json（不要改）

**路径**：`C:\Users\WPS\.cursor\argv.json`

Cursor 3.0.12 的 argv.json 只支持有限参数子集，`remote-debugging-port` 不在其中。**保持原样，不做修改**。

---

## 已知问题与修复

### Target.enable() 不可用

Cursor 3.0.12 (Chrome 142) 的 CDP 实现中 `Target` 域在 page-level 连接时不暴露 `enable` 方法。

**修复位置**：`src/connection.ts`（两处）

```typescript
// 修复前（会抛错导致连接失败）
await Promise.all([client.Runtime.enable(), client.Target.enable()]);

// 修复后（Target.enable 可选）
await client.Runtime.enable();
try { await client.Target.enable(); } catch { /* Target domain optional */ }
```

### WSL2 NAT 网络隔离

WSL2 默认 NAT 模式下，WSL 内无法访问 Windows 的 `127.0.0.1`。即使 CDP 绑定 `0.0.0.0`，Electron/Cursor 也会忽略 `--remote-debugging-address` 强制回退到 `127.0.0.1`。

**解决方案**：MCP 服务器运行在 Windows Node.js 上，直接连 localhost，彻底规避网络隔离。

---

## 一键恢复脚本

从 WSL 执行以下命令可恢复全部配置：

```bash
#!/bin/bash
# cursor-cdp-restore.sh — 从 WSL 一键恢复 Windows Cursor CDP 配置

echo "=== 1. 设置环境变量 ==="
powershell.exe -NoProfile -Command '
[System.Environment]::SetEnvironmentVariable(
    "ELECTRON_EXTRA_LAUNCH_ARGS",
    "--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0",
    "User"
)
Write-Output "ENV SET: $([System.Environment]::GetEnvironmentVariable(\"ELECTRON_EXTRA_LAUNCH_ARGS\", \"User\"))"
'

echo ""
echo "=== 2. 广播环境变量刷新 ==="
powershell.exe -NoProfile -Command '
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class WE { [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r); }
"@
$r=[UIntPtr]::Zero; [WE]::SendMessageTimeout([IntPtr]0xffff,0x001A,[UIntPtr]::Zero,"Environment",0x0002,5000,[ref]$r)
Write-Output "Broadcast done"
'

echo ""
echo "=== 3. 更新任务栏快捷方式 ==="
powershell.exe -NoProfile -Command '
$p = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Cursor.lnk"
if (Test-Path $p) {
    $s = (New-Object -COM WScript.Shell).CreateShortcut($p)
    $s.Arguments = "--remote-debugging-port=12678 --remote-debugging-address=0.0.0.0"
    $s.Save()
    Write-Output "Shortcut updated: $($s.Arguments)"
} else {
    Write-Output "Shortcut not found, skip"
}
'

echo ""
echo "=== 4. 确认 mcp.json (cursor-cdp 条目) ==="
MCPJSON="/mnt/c/Users/WPS/.cursor/mcp.json"
if [ -f "$MCPJSON" ]; then
    python3 -c "
import json, sys
with open('$MCPJSON') as f: cfg = json.load(f)
cdp = cfg.get('mcpServers',{}).get('cursor-cdp',{})
expected_args = ['\\\\\\\\wsl\$\\\\Ubuntu-20.04\\\\home\\\\go\\\\src\\\\pipeline-orchestrator\\\\server\\\\packages\\\\cursor-cdp\\\\dist\\\\index.js']
if cdp.get('command') == 'node' and cdp.get('args') == expected_args:
    print('mcp.json cursor-cdp: OK')
else:
    print('mcp.json cursor-cdp: MISMATCH, current:', json.dumps(cdp, indent=2))
    print('Please update manually')
"
else
    echo "mcp.json not found at $MCPJSON"
fi

echo ""
echo "=== 5. 构建 cursor-cdp ==="
cd /home/go/src/pipeline-orchestrator/server/packages/cursor-cdp
npm run build 2>&1 && echo "Build OK" || echo "Build FAILED"

echo ""
echo "=== 完成 ==="
echo "请完全关闭 Cursor 后重新打开，CDP 调试端口和 MCP 工具将自动生效。"
```

---

## 验证命令

```bash
# 1. 检查 CDP 端口是否监听
powershell.exe -NoProfile -Command 'Get-NetTCPConnection -LocalPort 12678 -ErrorAction SilentlyContinue | Format-Table LocalAddress,LocalPort,State'

# 2. 检查 CDP 是否可达（从 Windows 侧）
cmd.exe /c "curl.exe -s http://127.0.0.1:12678/json/version"

# 3. MCP 端到端测试
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n' | timeout 8 powershell.exe -NoProfile -Command '& "node.exe" "\\wsl$\Ubuntu-20.04\home\go\src\pipeline-orchestrator\server\packages\cursor-cdp\dist\index.js"'
```
