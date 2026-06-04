"""Cursor 聊天记录同步配置"""
import os
from pathlib import Path
from typing import List

# ─── 路径配置 ───

HOME = Path(os.path.expanduser("~"))
CURSOR_DIR = HOME / ".cursor"

_SYNC_SCRIPT_DIR = Path(__file__).resolve().parent


def _resolve_pipeline_db() -> Path:
    """D1: PIPELINE_DATA_DB > $PIPELINE_SESSIONS_DIR/pipeline.db > 默认路径。"""
    env_db = os.environ.get("PIPELINE_DATA_DB")
    if env_db:
        return Path(env_db).expanduser()

    sessions_dir = os.environ.get("PIPELINE_SESSIONS_DIR")
    if sessions_dir:
        return Path(sessions_dir).expanduser() / "pipeline.db"

    return Path("/opt/pipeline-orchestrator/sessions/pipeline.db")


PIPELINE_DB = _resolve_pipeline_db()

# 数据源
CHATS_DIR = CURSOR_DIR / "chats"
PROJECTS_DIR = CURSOR_DIR / "projects"


def _resolve_log_file() -> Path:
    """PIPELINE_ORCHESTRATOR_HOME 下 sync/sync.log，否则为与本文件同级的 sync.log。"""
    home = os.environ.get("PIPELINE_ORCHESTRATOR_HOME")
    if home:
        return Path(home).expanduser().resolve() / "sync" / "sync.log"
    return _SYNC_SCRIPT_DIR / "sync.log"


LOG_FILE = _resolve_log_file()


def _collect_workspace_storage_dirs() -> List[Path]:
    """D3: 跨平台 workspaceStorage，按 WSL2 / Linux / macOS 顺序探测，存在的全部收集。"""
    dirs: List[Path] = []
    seen = set()

    def add(p: Path) -> None:
        try:
            resolved = p.resolve()
        except OSError:
            resolved = p
        key = str(resolved)
        if key not in seen and p.is_dir():
            seen.add(key)
            dirs.append(p)

    # WSL2：Windows 用户目录下各用户的 Cursor workspaceStorage
    wsl_users_base = Path("/mnt/c/Users")
    if wsl_users_base.is_dir():
        try:
            for user_dir in wsl_users_base.iterdir():
                if not user_dir.is_dir():
                    continue
                candidate = (
                    user_dir
                    / "AppData"
                    / "Roaming"
                    / "Cursor"
                    / "User"
                    / "workspaceStorage"
                )
                add(candidate)
        except OSError:
            pass

    # Linux
    add(HOME / ".config" / "Cursor" / "User" / "workspaceStorage")

    # macOS
    add(
        HOME
        / "Library"
        / "Application Support"
        / "Cursor"
        / "User"
        / "workspaceStorage"
    )

    return dirs


WORKSPACE_STORAGE_DIRS: List[Path] = _collect_workspace_storage_dirs()


def _collect_global_storage_vscdb_paths() -> List[Path]:
    """收集 Cursor globalStorage/state.vscdb 路径（新版 composer 元数据存储在这里）。"""
    paths: List[Path] = []
    seen = set()

    def add(p: Path) -> None:
        try:
            resolved = p.resolve()
        except OSError:
            resolved = p
        key = str(resolved)
        if key not in seen and p.is_file():
            seen.add(key)
            paths.append(p)

    # WSL2
    wsl_users_base = Path("/mnt/c/Users")
    if wsl_users_base.is_dir():
        try:
            for user_dir in wsl_users_base.iterdir():
                if not user_dir.is_dir():
                    continue
                add(user_dir / "AppData" / "Roaming" / "Cursor" / "User" / "globalStorage" / "state.vscdb")
        except OSError:
            pass

    # Linux
    add(HOME / ".config" / "Cursor" / "User" / "globalStorage" / "state.vscdb")

    # macOS
    add(HOME / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage" / "state.vscdb")

    return paths


GLOBAL_STORAGE_VSCDB_PATHS: List[Path] = _collect_global_storage_vscdb_paths()

# ─── 滚动清理 ───

RETENTION_DAYS = 365

# ─── 过滤规则（排除出 rag_knowledge_chunks，但保留给 prompt_gems 评分）───

EXCLUDE_PROJECTS = {
    "home-go-src-github-com-my-skills",
    "home-go-src-github-com-market-mcp",
    "home-market",
    "openclaw-workspace",
    "openclaw-workspace-skills-market-analysis",
}

EXCLUDE_PROJECTS_PARTIAL = [
    "openclaw",
    "market-mcp",
    "market_mcp",
    "my-skills",
]

EXCLUDE_CONTENT_KEYWORDS = [
    "投研伙伴", "纯分析师", "回测分析师", "回测专家",
    "openclaw", "market_mcp", "market-mcp", "market_mcp_wrapper",
    ".openclaw/workspace/skills/mark",
    "portfolio.md",
    "绩效", "绩效自评", "绩效考核",
    "简历", "resume", "个人简历",
]

# chunk 级别过滤（每条消息都检查，比 session 级别更严格）
EXCLUDE_CHUNK_KEYWORDS = [
    "投研", "回测", "纯分析师", "回测分析师", "回测专家",
    "顶级投研", "金融投资专家", "金融市场", "金融分析", "金融专家",
    "雷公指标", "雷公乖离率", "市场宽度",
    "openclaw", "market_mcp", "market mcp", "market-analysis",
    "home\\market\\", "home/market/",
    "portfolio.md", "portfolio",
    "绩效自评", "绩效考核", "绩效材料", "绩效记录", "评级材料",
    "个人简历", "简历", "resume", "resume-builder",
]

# ─── 提示词质量评分 ───

PROMPT_MIN_SCORE = 60

PROMPT_SCORE_WEIGHTS = {
    "goal_clarity": 0.30,
    "context_richness": 0.25,
    "constraint_clarity": 0.20,
    "structure": 0.15,
    "complexity": 0.10,
}

GOAL_VERBS = [
    "实现", "修复", "优化", "分析", "重构", "添加", "删除", "替换",
    "部署", "配置", "迁移", "排查", "调试", "设计", "创建", "升级",
    "implement", "fix", "optimize", "refactor", "add", "remove",
    "deploy", "configure", "migrate", "debug", "design", "create",
]

CONSTRAINT_MARKERS = [
    "不要", "不能", "只需", "保持", "限制", "必须", "禁止",
    "不可以", "确保", "注意", "避免", "仅",
    "don't", "must", "only", "keep", "avoid", "ensure",
]

# ─── 提示词来源分类 ───

SOURCE_RULES = [
    ("market",   EXCLUDE_PROJECTS | {"home-market"}, ["投研伙伴", "回测分析师", "回测专家", "纯分析师", "market_mcp", "portfolio.md"]),
    ("skills",   {"home-go-src-github-com-my-skills"}, ["my-skills", "SKILL.md", "cursor-skills"]),
    ("personal", set(), ["绩效自评", "绩效考核", "个人简历", "resume"]),
]

# ─── 提示词 category 分类关键词 ───
# 规则按优先级从高到低排列，首次命中即返回

CATEGORY_RULES = [
    ("debug",         ["排查", "报错", "error", "bug", "修复", "fix", "panic", "异常", "failed",
                       "故障", "crash", "timeout", "超时", "不生效", "挂了", "500", "404",
                       "失败了", "不工作"]),
    ("feature",       ["实现", "添加", "新增", "开发", "implement", "add", "create", "feature",
                       "新功能", "帮我写", "写一个", "接入", "对接", "支持"]),
    ("refactor",      ["重构", "优化", "refactor", "optimize", "改进", "简化",
                       "整理", "清理", "拆分", "合并", "抽取", "封装"]),
    ("architecture",  ["架构", "设计", "方案", "architecture", "design", "技术选型", "评估方案"]),
    ("devops",        ["部署", "deploy", "k8s", "docker", "ci/cd", "kae", "运维",
                       "上线", "发布", "回滚", "灰度", "构建", "build", "编译",
                       "systemd", "crontab", "定时任务", "常驻", "安装"]),
    ("documentation", ["文档", "readme", "注释", "comment", "doc", "说明", "手册"]),
    ("testing",       ["测试", "test", "单测", "e2e", "mock", "playwright", "集成测试",
                       "用例", "覆盖率", "assert"]),
    ("monitoring",    ["监控", "告警", "alert", "metric", "prometheus", "grafana",
                       "指标", "巡检", "dashboard", "看板", "exporter", "采集",
                       "label", "规则"]),
    ("data",          ["数据", "统计", "report", "sync", "同步", "导入", "导出",
                       "迁移", "migrate", "对账", "reconcili", "备份", "backup",
                       "sql", "查询", "mysql", "redis", "clickhouse", "etcd",
                       "表结构", "字段"]),
    ("ai_workflow",   ["skill", "mcp", "agent", "prompt", "编排", "orchestrat",
                       "openspec", "cursor", "llm", "模型", "知识库", "rag"]),
    ("config",        ["配置", "config", "env", "yaml", "设置", "参数", "环境变量",
                       "template", "模板"]),
]
