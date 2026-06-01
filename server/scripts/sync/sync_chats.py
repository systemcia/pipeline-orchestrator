#!/usr/bin/env python3
"""
Cursor 聊天记录同步工具

功能：
1. 从 ~/.cursor/chats/ (store.db) 和 agent-transcripts (JSONL) 读取聊天记录
2. 过滤非日常开发记录后写入 pipeline.db rag_knowledge_chunks
3. 从所有记录中筛选高质量提示词写入 prompt_gems
4. 滚动清理超过 retention 天数的旧数据

用法：
    python3 sync_chats.py              # 增量同步
    python3 sync_chats.py --full       # 全量重建 (清空后重导)
    python3 sync_chats.py --dry-run    # 只分析不写入
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from config import (
    CATEGORY_RULES, CHATS_DIR, CONSTRAINT_MARKERS,
    EXCLUDE_CHUNK_KEYWORDS, EXCLUDE_CONTENT_KEYWORDS,
    EXCLUDE_PROJECTS, EXCLUDE_PROJECTS_PARTIAL,
    GLOBAL_STORAGE_VSCDB_PATHS,
    GOAL_VERBS, LOG_FILE, PIPELINE_DB, PROJECTS_DIR, PROMPT_MIN_SCORE,
    PROMPT_SCORE_WEIGHTS, RETENTION_DAYS, SOURCE_RULES,
    WORKSPACE_STORAGE_DIRS,
)

# ─── 日志 ───

LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("sync_chats")


# ─── 数据结构 ───

@dataclass
class Message:
    role: str         # user / assistant / system / tool
    text: str
    timestamp: int    # ms

@dataclass
class Session:
    session_id: str
    project_name: str       # agent-transcripts 目录名 或 "unknown"
    workspace_id: str
    messages: List[Message] = field(default_factory=list)
    source_path: str = ""   # store.db 或 jsonl 路径

    @property
    def created_at(self) -> int:
        ts = [m.timestamp for m in self.messages if m.timestamp > 0]
        return min(ts) if ts else 0

    @property
    def first_user_text(self) -> str:
        for m in self.messages:
            if m.role == "user" and m.text.strip():
                return m.text
        return ""


# ─── 数据读取 ───

def extract_text_from_content(content) -> str:
    """从 Cursor 消息的 content 字段提取纯文本"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif item.get("type") == "tool-result":
                    pass  # 跳过工具结果
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content) if content else ""


def strip_thinking(text: str) -> str:
    """剥离模型思考/推理块，只保留最终输出"""
    if not text:
        return ""
    for tag in ("antml:thinking", "thinking", "antThinking"):
        pattern = rf"<{tag}>.*?</{tag}>"
        text = re.sub(pattern, "", text, flags=re.DOTALL)
    return text.strip()


def strip_system_tags(text: str) -> str:
    """去掉 Cursor 注入的系统标签，保留用户实际输入"""
    # 先提取 user_query（如果有），在删除标签之前
    m = re.search(r"<user_query>\s*(.*?)\s*</user_query>", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # 没有 user_query 标签，逐个删除系统标签
    for tag in ("user_info", "system_reminder",
                "attached_files", "open_and_recently_viewed_files",
                "git_status", "agent_transcripts", "rules",
                "manually_attached_skills", "agent_skills",
                "task_notification", "image_files",
                "mcp_instructions"):
        text = re.sub(rf"<{tag}[^>]*>.*?</{tag}>", "", text, flags=re.DOTALL)
    return text.strip()


def read_store_db(db_path: Path, workspace_id: str) -> Optional[Session]:
    """从 store.db 读取一个会话"""
    session_id = db_path.parent.name
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        rows = conn.execute(
            "SELECT data FROM blobs WHERE hex(substr(data,1,1))='7B'"
        ).fetchall()
        conn.close()
    except Exception as e:
        log.warning("读取 %s 失败: %s", db_path, e)
        return None

    messages = []
    for (raw,) in rows:
        try:
            d = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        role = d.get("role", "")
        if role not in ("user", "assistant"):
            continue
        text = extract_text_from_content(d.get("content", ""))
        if not text.strip():
            continue
        messages.append(Message(role=role, text=text, timestamp=0))

    if not messages:
        return None

    # store.db 没有时间戳，用文件 mtime 近似
    mtime_ms = int(db_path.stat().st_mtime * 1000)
    for msg in messages:
        msg.timestamp = mtime_ms

    return Session(
        session_id=session_id,
        project_name="unknown",
        workspace_id=workspace_id,
        messages=messages,
        source_path=str(db_path),
    )


def read_jsonl(jsonl_path: Path, project_name: str) -> Optional[Session]:
    """从 agent-transcript JSONL 读取一个会话"""
    session_id = jsonl_path.parent.name
    messages = []
    try:
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                role = d.get("role", "")
                if role not in ("user", "assistant"):
                    continue
                raw_msg = d.get("message", "")
                if isinstance(raw_msg, str):
                    try:
                        parsed = ast.literal_eval(raw_msg) if raw_msg.startswith(("{", "[")) else None
                    except (ValueError, SyntaxError):
                        parsed = None
                    if parsed and isinstance(parsed, dict):
                        text = extract_text_from_content(parsed.get("content", raw_msg))
                    elif parsed and isinstance(parsed, list):
                        text = extract_text_from_content(parsed)
                    else:
                        text = raw_msg
                elif isinstance(raw_msg, dict):
                    text = extract_text_from_content(raw_msg.get("content", ""))
                else:
                    text = str(raw_msg)
                if not text.strip():
                    continue
                messages.append(Message(role=role, text=text, timestamp=0))
    except Exception as e:
        log.warning("读取 %s 失败: %s", jsonl_path, e)
        return None

    if not messages:
        return None

    mtime_ms = int(jsonl_path.stat().st_mtime * 1000)
    for msg in messages:
        msg.timestamp = mtime_ms

    workspace_id = ""
    # 尝试从 projects 路径推导
    parts = str(jsonl_path).split("/projects/")
    if len(parts) > 1:
        workspace_id = parts[1].split("/")[0]

    return Session(
        session_id=session_id,
        project_name=project_name,
        workspace_id=workspace_id,
        messages=messages,
        source_path=str(jsonl_path),
    )


def load_all_sessions() -> List[Session]:
    """加载所有数据源，去重合并"""
    sessions: Dict[str, Session] = {}

    # 1. agent-transcripts（有项目名，优先）
    if PROJECTS_DIR.exists():
        for proj_dir in sorted(PROJECTS_DIR.iterdir()):
            if not proj_dir.is_dir():
                continue
            project_name = proj_dir.name
            transcripts_dir = proj_dir / "agent-transcripts"
            if not transcripts_dir.exists():
                continue
            for session_dir in sorted(transcripts_dir.iterdir()):
                if not session_dir.is_dir():
                    continue
                jsonl_file = session_dir / f"{session_dir.name}.jsonl"
                if not jsonl_file.exists():
                    continue
                sess = read_jsonl(jsonl_file, project_name)
                if sess:
                    sessions[sess.session_id] = sess

    # 2. store.db（补充 JSONL 没有的会话）
    if CHATS_DIR.exists():
        for ws_dir in sorted(CHATS_DIR.iterdir()):
            if not ws_dir.is_dir():
                continue
            workspace_id = ws_dir.name
            for session_dir in sorted(ws_dir.iterdir()):
                if not session_dir.is_dir():
                    continue
                store_db = session_dir / "store.db"
                if not store_db.exists():
                    continue
                sid = session_dir.name
                if sid in sessions:
                    continue  # JSONL 已有，跳过
                sess = read_store_db(store_db, workspace_id)
                if sess:
                    # 尝试从 agent-transcripts 反查项目名
                    for proj_dir in PROJECTS_DIR.iterdir():
                        t_dir = proj_dir / "agent-transcripts" / sid
                        if t_dir.exists():
                            sess.project_name = proj_dir.name
                            break
                    sessions[sess.session_id] = sess

    log.info("加载完成: %d 个独立会话", len(sessions))
    return list(sessions.values())


def _estimate_tokens_from_messages(sess: Session) -> int:
    """按设计 D2：用拼接消息文本长度 / 4 近似 token 数（管理台趋势用）。"""
    joined = "".join(m.text for m in sess.messages)
    return len(joined) // 4


def build_session_token_map(sessions: List[Session]) -> Dict[str, int]:
    """session_id -> token 估算，供 workspace composer 关联。"""
    return {s.session_id: _estimate_tokens_from_messages(s) for s in sessions}


def _find_agent_transcript_jsonl(session_id: str) -> Optional[Path]:
    """在 PROJECTS_DIR 下查找 agent-transcripts/<session_id>/<session_id>.jsonl。"""
    if not PROJECTS_DIR.exists():
        return None
    try:
        for proj_dir in PROJECTS_DIR.iterdir():
            if not proj_dir.is_dir():
                continue
            p = proj_dir / "agent-transcripts" / session_id / f"{session_id}.jsonl"
            if p.is_file():
                return p
    except OSError as e:
        log.warning("列举 agent-transcripts 失败: %s", e)
    return None


def _find_chats_store_db(session_id: str) -> Optional[Path]:
    """在 CHATS_DIR 下查找任意 workspace 下的 <session_id>/store.db。"""
    if not CHATS_DIR.exists():
        return None
    try:
        for ws_dir in CHATS_DIR.iterdir():
            if not ws_dir.is_dir():
                continue
            p = ws_dir / session_id / "store.db"
            if p.is_file():
                return p
    except OSError as e:
        log.warning("列举 chats store.db 失败: %s", e)
    return None


def resolve_composer_token_count(
    composer_id: str, session_token_map: Dict[str, int]
) -> int:
    """composer_id 与 session_id 对齐：优先已加载会话，其次 JSONL，再 store.db。"""
    if composer_id in session_token_map:
        return session_token_map[composer_id]
    jsonl_path = _find_agent_transcript_jsonl(composer_id)
    if jsonl_path is not None:
        project_name = jsonl_path.parent.parent.parent.name
        sess = read_jsonl(jsonl_path, project_name)
        if sess is not None:
            return _estimate_tokens_from_messages(sess)
    store_path = _find_chats_store_db(composer_id)
    if store_path is not None:
        workspace_id = store_path.parent.parent.name
        sess = read_store_db(store_path, workspace_id)
        if sess is not None:
            return _estimate_tokens_from_messages(sess)
    return 0


# ─── 过滤判定 ───

def is_excluded(session: Session) -> bool:
    """判断会话是否应排除出 rag_knowledge_chunks"""
    proj = session.project_name
    if proj in EXCLUDE_PROJECTS:
        return True
    for partial in EXCLUDE_PROJECTS_PARTIAL:
        if partial in proj:
            return True

    clean_text = strip_system_tags(session.first_user_text).lower()
    for kw in EXCLUDE_CONTENT_KEYWORDS:
        if kw.lower() in clean_text:
            return True
    return False


def classify_source(session: Session) -> str:
    """给提示词分类来源（按项目名优先匹配，关键词在清理后的文本中查找）"""
    proj = session.project_name
    for source_name, proj_set, _ in SOURCE_RULES:
        if proj in proj_set:
            return source_name

    clean_text = strip_system_tags(session.first_user_text).lower()
    for source_name, _, keywords in SOURCE_RULES:
        for kw in keywords:
            if kw.lower() in clean_text:
                return source_name
    return "development"


def classify_category(text: str) -> str:
    """给提示词分类用途"""
    t = text.lower()
    for cat, keywords in CATEGORY_RULES:
        for kw in keywords:
            if kw.lower() in t:
                return cat
    return "other"


def _extract_main_topic(text: str) -> str:
    """从用户问题中提取主题（GOAL_VERBS + 宾语短语，截取前 50 字符）"""
    for verb in GOAL_VERBS:
        idx = text.find(verb)
        if idx >= 0:
            topic = text[idx:idx + 50].strip()
            return topic if topic else verb
    return classify_category(text)


def _extract_tags(clean_query: str, ai_text: str) -> str:
    """从 query 和 AI 回复中检测语言/框架标签，返回 JSON 数组字符串"""
    combined = (clean_query + " " + ai_text).lower()
    tags: List[str] = []

    language_rules = [
        ("python", ["python", "pip ", "django", "flask", "fastapi"]),
        ("go", ["golang", r"\bgo\b", "gin ", ".go "]),
        ("typescript", ["typescript", "tsx", ".ts "]),
        ("javascript", ["javascript", "react", "vue", "node"]),
        ("sql", ["sql", "mysql", "postgres", "sqlite"]),
        ("shell", ["bash", "shell", " sh ", "zsh"]),
    ]
    for lang, keywords in language_rules:
        matched = False
        for kw in keywords:
            if kw.startswith(r"\b"):
                if re.search(kw, combined):
                    matched = True
                    break
            elif kw in combined:
                matched = True
                break
        if matched:
            tags.append(lang)

    framework_rules = [
        ("react", ["react"]),
        ("fastify", ["fastify"]),
        ("gin", ["gin"]),
        ("django", ["django"]),
        ("express", ["express"]),
        ("antd", ["antd", "ant design"]),
    ]
    for fw, keywords in framework_rules:
        if any(kw in combined for kw in keywords) and fw not in tags:
            tags.append(fw)

    return json.dumps(tags, ensure_ascii=False)


def _extract_tools_used(ai_text: str) -> str:
    """从 AI 回复中检测工具调用模式，返回 JSON 数组字符串"""
    if not ai_text:
        return json.dumps([], ensure_ascii=False)

    tools: List[str] = []
    tl = ai_text.lower()

    if any(p in tl for p in ("read file", "read(", "读取文件")):
        tools.append("read")
    if any(p in tl for p in ("shell", "执行命令")):
        tools.append("shell")
    if any(p in tl for p in ("grep", "搜索", "rg ")):
        tools.append("grep")
    if any(p in tl for p in ("write(", "写入文件")) or "Write" in ai_text:
        tools.append("write")
    if "strreplace" in tl or "替换" in ai_text:
        tools.append("str_replace")
    if any(p in tl for p in ("task", "subagent", "spawn")):
        tools.append("task")

    return json.dumps(tools, ensure_ascii=False)


# ─── 提示词质量评分 ───

def score_prompt(text: str) -> Tuple[float, List[str]]:
    """规则引擎评分，返回 (0-100 分值, 质量标签列表)"""
    tags = []
    scores = {}

    clean = strip_system_tags(text)
    if len(clean) < 10:
        return 0.0, []

    # 目标清晰度
    has_verb = any(v in clean for v in GOAL_VERBS)
    goal_score = 0
    if has_verb and len(clean) > 20:
        goal_score = 100
        tags.append("clear_goal")
    elif has_verb:
        goal_score = 60
    elif len(clean) > 30:
        goal_score = 40
    scores["goal_clarity"] = goal_score

    # 上下文充分度
    ctx_score = 0
    ctx_signals = [
        (r"[/\\][\w\-./]+\.\w+", "has_filepath"),
        (r"```", "has_code"),
        (r"(error|err|panic|failed|报错|异常)", "has_error_info"),
        (r"(因为|背景|目前|现在|之前)", "has_background"),
    ]
    for pattern, tag in ctx_signals:
        if re.search(pattern, clean, re.IGNORECASE):
            ctx_score += 25
            tags.append(tag)
    scores["context_richness"] = min(ctx_score, 100)

    # 约束明确性
    constraint_count = sum(1 for m in CONSTRAINT_MARKERS if m in clean)
    if constraint_count >= 3:
        cons_score = 100
        tags.append("rich_constraints")
    elif constraint_count >= 1:
        cons_score = 60
        tags.append("has_constraints")
    else:
        cons_score = 0
    scores["constraint_clarity"] = cons_score

    # 结构化程度
    struct_score = 0
    if re.search(r"^\s*\d+[.、)）]", clean, re.MULTILINE):
        struct_score += 40
        tags.append("numbered_list")
    if re.search(r"^#+\s", clean, re.MULTILINE):
        struct_score += 30
        tags.append("has_headers")
    if re.search(r"^[-*]\s", clean, re.MULTILINE):
        struct_score += 30
        tags.append("has_bullets")
    scores["structure"] = min(struct_score, 100)

    # 复杂度
    if len(clean) > 200 and not re.match(r"^.{200,}$", clean):  # 长且多行
        comp_score = 100
        tags.append("complex")
    elif len(clean) > 100:
        comp_score = 60
    else:
        comp_score = 20
    scores["complexity"] = comp_score

    total = sum(scores[k] * PROMPT_SCORE_WEIGHTS[k] for k in PROMPT_SCORE_WEIGHTS)
    return round(total, 1), tags


# ─── 数据库写入 ───

def ensure_prompt_gems_table(conn: sqlite3.Connection):
    """创建 prompt_gems 表（如不存在）"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prompt_gems (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            project_name TEXT,
            source TEXT NOT NULL,
            user_prompt TEXT NOT NULL,
            ai_response_summary TEXT,
            quality_score REAL,
            quality_tags TEXT,
            category TEXT,
            timestamp INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, timestamp)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_prompt_gems_score
        ON prompt_gems(quality_score DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_prompt_gems_source
        ON prompt_gems(source)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_prompt_gems_category
        ON prompt_gems(category)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_prompt_gems_timestamp
        ON prompt_gems(timestamp)
    """)


def ensure_workspace_sessions_table(conn: sqlite3.Connection) -> None:
    """创建 workspace_sessions 表（如不存在），对应 state.vscdb composer 元数据。"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS workspace_sessions (
            composer_id TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER,
            last_updated_at INTEGER,
            unified_mode TEXT,
            subtitle TEXT,
            total_lines_added INTEGER,
            total_lines_removed INTEGER,
            files_changed_count INTEGER,
            context_usage_percent REAL,
            is_archived INTEGER,
            created_on_branch TEXT,
            token_count INTEGER NOT NULL DEFAULT 0,
            workspace_id TEXT,
            cached_at INTEGER,
            panel_id TEXT
        )
    """)


def ensure_session_file_index_table(conn: sqlite3.Connection) -> None:
    """创建 session_file_index 表（如不存在），供后续同步填充 session → 文件路径。"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS session_file_index (
            session_id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            source_type TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)


def _decode_item_table_value(raw) -> str:
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return raw if isinstance(raw, str) else str(raw)


def _int_or_none(val) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _float_or_none(val) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _bool_to_sql_int(val) -> Optional[int]:
    if val is None:
        return None
    return 1 if val else 0


def _scan_one_state_vscdb(
    conn: sqlite3.Connection,
    vscdb_path: Path,
    workspace_id: str,
    cached_at_ms: int,
    dry_run: bool,
    session_token_map: Dict[str, int],
) -> int:
    """读取单个 state.vscdb，将 composer.composerData 写入 workspace_sessions。失败时抛异常由上层捕获。"""
    uri = "file:" + vscdb_path.resolve().as_posix() + "?mode=ro"
    vconn = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        row = vconn.execute(
            "SELECT value FROM ItemTable WHERE key = ?",
            ("composer.composerData",),
        ).fetchone()
    finally:
        vconn.close()

    if not row:
        return 0

    text = _decode_item_table_value(row[0])
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("composer.composerData JSON 无效: %s", vscdb_path)
        return 0

    if isinstance(data, dict):
        composers = data.get("allComposers")
        if not isinstance(composers, list):
            log.warning("composer.composerData 无 allComposers 数组，跳过: %s", vscdb_path)
            return 0
        data = composers
    elif not isinstance(data, list):
        log.warning("composer.composerData 格式未知，跳过: %s", vscdb_path)
        return 0

    written = 0
    sql = """
        INSERT OR REPLACE INTO workspace_sessions (
            composer_id, name, created_at, last_updated_at, unified_mode,
            subtitle, total_lines_added, total_lines_removed, files_changed_count,
            context_usage_percent, is_archived, created_on_branch, token_count,
            workspace_id, cached_at, panel_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """
    for item in data:
        if not isinstance(item, dict):
            continue
        composer_id = item.get("composerId")
        if not composer_id:
            continue
        token_count = resolve_composer_token_count(
            composer_id, session_token_map
        )
        params = (
            composer_id,
            item.get("name"),
            _int_or_none(item.get("createdAt")),
            _int_or_none(item.get("lastUpdatedAt")),
            item.get("unifiedMode"),
            item.get("subtitle"),
            _int_or_none(item.get("totalLinesAdded")),
            _int_or_none(item.get("totalLinesRemoved")),
            _int_or_none(item.get("filesChangedCount")),
            _float_or_none(item.get("contextUsagePercent")),
            _bool_to_sql_int(item.get("isArchived")),
            item.get("createdOnBranch"),
            token_count,
            workspace_id,
            cached_at_ms,
            item.get("panelId"),
        )
        if not dry_run:
            conn.execute(sql, params)
        written += 1
    return written


def _safe_copy_vscdb(src: Path) -> Optional[Path]:
    """WSL 跨文件系统直接读 state.vscdb 可能 I/O 出错，先拷贝到 /tmp。"""
    if not str(src).startswith("/mnt/"):
        return None  # 不需要拷贝
    import shutil
    tmp = Path("/tmp") / f"_sync_{src.name}_{hash(str(src)) & 0xFFFF:04x}"
    try:
        shutil.copy2(src, tmp)
        wal = src.parent / (src.name + "-wal")
        if wal.is_file():
            shutil.copy2(wal, tmp.parent / (tmp.name + "-wal"))
        return tmp
    except OSError as e:
        log.warning("拷贝 %s 失败: %s", src, e)
        return None


def _scan_global_composer_headers(
    conn: sqlite3.Connection,
    vscdb_path: Path,
    cached_at_ms: int,
    dry_run: bool,
    session_token_map: Dict[str, int],
) -> int:
    """从 globalStorage/state.vscdb 的 composer.composerHeaders 读取 composer 元数据。
    Cursor 1.0+ 将 allComposers 从各 workspace 的 composerData 迁移到此处。
    """
    copied = _safe_copy_vscdb(vscdb_path)
    read_path = copied or vscdb_path
    try:
        uri = "file:" + read_path.resolve().as_posix() + "?mode=ro"
        vconn = sqlite3.connect(uri, uri=True, timeout=30)
        try:
            row = vconn.execute(
                "SELECT value FROM ItemTable WHERE key = ?",
                ("composer.composerHeaders",),
            ).fetchone()
        finally:
            vconn.close()
    except Exception as e:
        log.warning("读取 globalStorage %s 失败: %s", vscdb_path, e)
        return 0
    finally:
        if copied and copied.exists():
            copied.unlink(missing_ok=True)
            wal = copied.parent / (copied.name + "-wal")
            wal.unlink(missing_ok=True)

    if not row:
        return 0

    text = _decode_item_table_value(row[0])
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("composer.composerHeaders JSON 无效: %s", vscdb_path)
        return 0

    composers = data.get("allComposers") if isinstance(data, dict) else None
    if not isinstance(composers, list):
        log.warning("composer.composerHeaders 无 allComposers: %s", vscdb_path)
        return 0

    written = 0
    sql = """
        INSERT OR REPLACE INTO workspace_sessions (
            composer_id, name, created_at, last_updated_at, unified_mode,
            subtitle, total_lines_added, total_lines_removed, files_changed_count,
            context_usage_percent, is_archived, created_on_branch, token_count,
            workspace_id, cached_at, panel_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """
    for item in composers:
        if not isinstance(item, dict):
            continue
        composer_id = item.get("composerId")
        if not composer_id:
            continue
        # 从 workspaceIdentifier 提取 workspace_id
        ws_ident = item.get("workspaceIdentifier") or {}
        workspace_id = ws_ident.get("id", "")
        # activeBranch 作为 created_on_branch
        active_branch = item.get("activeBranch") or {}
        branch_name = active_branch.get("branchName")

        token_count = resolve_composer_token_count(composer_id, session_token_map)
        params = (
            composer_id,
            item.get("name"),
            _int_or_none(item.get("createdAt")),
            _int_or_none(item.get("lastUpdatedAt")),
            item.get("unifiedMode"),
            item.get("subtitle"),
            _int_or_none(item.get("totalLinesAdded")),
            _int_or_none(item.get("totalLinesRemoved")),
            _int_or_none(item.get("filesChangedCount")),
            _float_or_none(item.get("contextUsagePercent")),
            _bool_to_sql_int(item.get("isArchived")),
            branch_name,
            token_count,
            workspace_id,
            cached_at_ms,
            item.get("panelId"),
        )
        if not dry_run:
            conn.execute(sql, params)
        written += 1
    return written


def scan_workspace_sessions(
    conn: sqlite3.Connection,
    session_token_map: Dict[str, int],
    dry_run: bool = False,
) -> int:
    """扫描 composer 元数据写入 workspace_sessions。

    数据来源（按优先级）：
    1. globalStorage/state.vscdb → composer.composerHeaders（Cursor 1.0+ 新格式）
    2. workspaceStorage/*/state.vscdb → composer.composerData（旧格式回退）

    session_token_map: load_all_sessions 得到的 session_id -> token 粗估，缺失时再查 JSONL/store.db。
    单个文件失败仅 WARNING，不阻断；返回成功写入（或 dry_run 下将写入）的条数。
    """
    cached_at_ms = int(time.time() * 1000)
    total = 0

    # 优先：globalStorage 的 composerHeaders（新版 Cursor）
    for gs_path in GLOBAL_STORAGE_VSCDB_PATHS:
        try:
            n = _scan_global_composer_headers(
                conn, gs_path, cached_at_ms, dry_run, session_token_map,
            )
            total += n
            if n:
                log.info(
                    "globalStorage composerHeaders: %s %d 条 (%s)",
                    "将写入" if dry_run else "已写入", n, gs_path,
                )
        except Exception as e:
            log.warning("扫描 globalStorage 失败 %s: %s", gs_path, e)

    # 回退：各 workspace 的 composerData（旧版 Cursor）
    for base in WORKSPACE_STORAGE_DIRS:
        if not base.is_dir():
            continue
        try:
            ws_dirs = sorted(base.iterdir(), key=lambda p: p.name)
        except OSError as e:
            log.warning("列举 workspaceStorage 失败 %s: %s", base, e)
            continue
        for ws_dir in ws_dirs:
            if not ws_dir.is_dir():
                continue
            vscdb_path = ws_dir / "state.vscdb"
            if not vscdb_path.is_file():
                continue
            try:
                n = _scan_one_state_vscdb(
                    conn,
                    vscdb_path,
                    ws_dir.name,
                    cached_at_ms,
                    dry_run,
                    session_token_map,
                )
                total += n
            except Exception as e:
                log.warning("扫描 state.vscdb 失败 %s: %s", vscdb_path, e)
    if total:
        log.info(
            "workspace_sessions: %s %d 条 (合计)",
            "将写入" if dry_run else "已写入",
            total,
        )
    return total


def make_chunk_id(session_id: str, chunk_index: int) -> str:
    raw = f"{session_id}:{chunk_index}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def make_gem_id(session_id: str, timestamp: int) -> str:
    raw = f"gem:{session_id}:{timestamp}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def extract_user_query(text: str) -> str:
    """提取 <user_query> 标签内的内容，没有则返回清理后的文本"""
    m = re.search(r"<user_query>\s*(.*?)\s*</user_query>", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return strip_system_tags(text)


def sync(full: bool = False, dry_run: bool = False):
    """主同步逻辑"""
    log.info("开始同步 (full=%s, dry_run=%s)", full, dry_run)

    sessions = load_all_sessions()
    session_token_map = build_session_token_map(sessions)
    if not sessions:
        log.info("无会话数据")
        return

    PIPELINE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(PIPELINE_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rag_knowledge_chunks (
            id TEXT PRIMARY KEY, session_id TEXT, chunk_index INTEGER,
            project_id TEXT, project_name TEXT, workspace_id TEXT,
            user_query TEXT, ai_response_core TEXT, vector_text TEXT,
            has_code INTEGER, timestamp INTEGER, content_hash TEXT,
            file_path TEXT, indexed_at INTEGER,
            main_topic TEXT, tags TEXT, tools_used TEXT,
            code_languages TEXT, enrichment_status TEXT,
            source TEXT DEFAULT 'chat',
            is_starred INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0
        )
    """)
    # 幂等迁移：已有表补字段
    for col, ddl in [
        ("source", "TEXT DEFAULT 'chat'"),
        ("is_starred", "INTEGER DEFAULT 0"),
        ("is_deleted", "INTEGER DEFAULT 0"),
    ]:
        try:
            conn.execute(f"ALTER TABLE rag_knowledge_chunks ADD COLUMN {col} {ddl}")
        except sqlite3.OperationalError:
            pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_summaries (
            id TEXT PRIMARY KEY, date TEXT, summary TEXT, language TEXT,
            work_categories TEXT, total_sessions INTEGER,
            projects TEXT, created_at INTEGER, updated_at INTEGER
        )
    """)
    ensure_prompt_gems_table(conn)
    ensure_workspace_sessions_table(conn)
    ensure_session_file_index_table(conn)

    if full and not dry_run:
        log.info("全量模式: 清空 rag_knowledge_chunks、prompt_gems、daily_summaries、workspace_sessions、session_file_index")
        conn.execute("DELETE FROM rag_knowledge_chunks")
        conn.execute("DELETE FROM prompt_gems")
        conn.execute("DELETE FROM daily_summaries")
        conn.execute("DELETE FROM workspace_sessions")
        conn.execute("DELETE FROM session_file_index")
        conn.commit()

    scan_workspace_sessions(conn, session_token_map, dry_run=dry_run)

    # 获取已有 session_id 集合（增量模式跳过）
    # 当天的 session 不跳过，防止凌晨同步时读到不完整的进行中会话
    existing_chunks: Set[str] = set()
    existing_gems: Set[str] = set()
    if not full:
        today_start_ms = int(
            (time.time() // 86400) * 86400 - 8 * 3600  # UTC 当天 00:00 (CST-8)
        ) * 1000
        rows = conn.execute(
            "SELECT DISTINCT session_id FROM rag_knowledge_chunks WHERE timestamp < ?",
            (today_start_ms,)
        ).fetchall()
        existing_chunks = {r[0] for r in rows}
        rows = conn.execute(
            "SELECT DISTINCT session_id FROM prompt_gems WHERE timestamp < ?",
            (today_start_ms,)
        ).fetchall()
        existing_gems = {r[0] for r in rows}

    stats = {
        "total": len(sessions), "excluded": 0,
        "chunks_written": 0, "chunks_skipped": 0,
        "gems_written": 0, "gems_skipped": 0,
    }

    for sess in sessions:
        excluded = is_excluded(sess)
        source = classify_source(sess)
        pairs = _pair_messages(sess)

        if excluded:
            stats["excluded"] += 1

        # ── session_file_index: 维护 session → 文件路径映射 ──
        if not dry_run and sess.source_path:
            source_type = "jsonl" if sess.source_path.endswith(".jsonl") else "storedb"
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO session_file_index (session_id, file_path, source_type, updated_at) VALUES (?,?,?,?)",
                    (sess.session_id, sess.source_path, source_type, int(time.time() * 1000)),
                )
            except sqlite3.IntegrityError:
                pass

        # ── rag_knowledge_chunks: 只写开发相关的 ──
        if not excluded and sess.session_id not in existing_chunks:
            for idx, (user_text, ai_text) in enumerate(pairs):
                clean_query = extract_user_query(user_text)
                if len(clean_query) < 5:
                    continue
                # chunk 级别二次过滤
                query_lower = clean_query.lower()
                if any(kw.lower() in query_lower for kw in EXCLUDE_CHUNK_KEYWORDS):
                    continue
                ai_core = strip_thinking(ai_text) if ai_text else ""
                chunk_id = make_chunk_id(sess.session_id, idx)
                content_hash = hashlib.md5(
                    (clean_query + ai_core).encode()
                ).hexdigest()

                if not dry_run:
                    try:
                        conn.execute("""
                            INSERT OR IGNORE INTO rag_knowledge_chunks
                            (id, session_id, chunk_index, project_id, project_name,
                             workspace_id, user_query, ai_response_core, vector_text,
                             has_code, timestamp, content_hash, file_path, indexed_at,
                             source, main_topic, tags, tools_used)
                            VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?)
                        """, (
                            chunk_id, sess.session_id, idx,
                            sess.project_name, _short_name(sess.project_name),
                            sess.workspace_id,
                            clean_query, ai_core,
                            clean_query + "\n" + ai_core,
                            1 if "```" in ai_text else 0,
                            sess.created_at, content_hash,
                            sess.source_path,
                            int(time.time() * 1000),
                            "chat",
                            _extract_main_topic(clean_query),
                            _extract_tags(clean_query, ai_core),
                            _extract_tools_used(ai_core),
                        ))
                        stats["chunks_written"] += 1
                    except sqlite3.IntegrityError:
                        stats["chunks_skipped"] += 1
                else:
                    stats["chunks_written"] += 1
        elif not excluded:
            stats["chunks_skipped"] += 1

        # ── prompt_gems: 所有会话都评估 ──
        if sess.session_id not in existing_gems:
            for pair_idx, (user_text, ai_text) in enumerate(pairs):
                clean_query = extract_user_query(user_text)
                if len(clean_query) < 10:
                    continue
                score, tags = score_prompt(user_text)
                if score < PROMPT_MIN_SCORE:
                    continue
                gem_id = make_gem_id(sess.session_id, pair_idx)
                category = classify_category(clean_query)
                ai_summary = strip_thinking(ai_text) if ai_text else ""
                gem_ts = sess.created_at + pair_idx

                if not dry_run:
                    try:
                        conn.execute("""
                            INSERT OR IGNORE INTO prompt_gems
                            (id, session_id, project_name, source,
                             user_prompt, ai_response_summary,
                             quality_score, quality_tags, category,
                             timestamp, created_at)
                            VALUES (?,?,?,?, ?,?, ?,?,?, ?,?)
                        """, (
                            gem_id, sess.session_id,
                            _short_name(sess.project_name), source,
                            clean_query, ai_summary,
                            score, json.dumps(tags, ensure_ascii=False),
                            category,
                            gem_ts,
                            int(time.time()),
                        ))
                        stats["gems_written"] += 1
                    except sqlite3.IntegrityError:
                        stats["gems_skipped"] += 1
                else:
                    stats["gems_written"] += 1
        else:
            stats["gems_skipped"] += 1

    # ── 聚合生成 daily_summaries ──
    if not dry_run:
        ds_count = _generate_daily_summaries(conn)
        stats["daily_summaries"] = ds_count

    # ── 经验回灌 ──
    reviews_count = _sync_session_reviews(conn, dry_run=dry_run)
    stats["reviews_written"] = reviews_count

    # ── 滚动清理 ──
    cutoff_ms = int((time.time() - RETENTION_DAYS * 86400) * 1000)
    cutoff_date = time.strftime(
        "%Y-%m-%d", time.localtime(time.time() - RETENTION_DAYS * 86400)
    )
    if not dry_run:
        for table in ("rag_knowledge_chunks", "prompt_gems"):
            deleted = conn.execute(
                f"DELETE FROM {table} WHERE timestamp < ? AND timestamp > 0",
                (cutoff_ms,)
            ).rowcount
            if deleted:
                log.info("滚动清理 %s: 删除 %d 条过期记录", table, deleted)
        # workspace_sessions 按 cached_at 清理
        deleted = conn.execute(
            "DELETE FROM workspace_sessions WHERE cached_at < ? AND cached_at > 0",
            (cutoff_ms,),
        ).rowcount
        if deleted:
            log.info("滚动清理 workspace_sessions: 删除 %d 条过期记录", deleted)
        # daily_summaries 按 date 字段清理（避免秒/毫秒单位混淆）
        deleted = conn.execute(
            "DELETE FROM daily_summaries WHERE date < ?", (cutoff_date,)
        ).rowcount
        if deleted:
            log.info("滚动清理 daily_summaries: 删除 %d 条过期记录", deleted)

    if not dry_run:
        conn.commit()
    conn.close()

    log.info(
        "同步完成: 总会话=%d, 排除=%d, "
        "chunks写入=%d/跳过=%d, gems写入=%d/跳过=%d, daily_summaries=%d, reviews_written=%d",
        stats["total"], stats["excluded"],
        stats["chunks_written"], stats["chunks_skipped"],
        stats["gems_written"], stats["gems_skipped"],
        stats.get("daily_summaries", 0),
        stats.get("reviews_written", 0),
    )


def _generate_daily_summaries(conn: sqlite3.Connection) -> int:
    """从 rag_knowledge_chunks 聚合生成 daily_summaries"""
    rows = conn.execute("""
        SELECT
            date(timestamp/1000, 'unixepoch', '+8 hours') as day,
            count(*) as chunk_count,
            count(DISTINCT session_id) as session_count,
            group_concat(DISTINCT project_name) as projects_csv
        FROM rag_knowledge_chunks
        WHERE timestamp > 0
        GROUP BY day
        ORDER BY day
    """).fetchall()

    existing = {}
    for r in conn.execute(
        "SELECT date, total_sessions FROM daily_summaries"
    ).fetchall():
        existing[r[0]] = r[1]

    written = 0
    now_s = int(time.time())

    for day, chunk_count, session_count, projects_csv in rows:
        old_sessions = existing.get(day)
        if old_sessions is not None and old_sessions == session_count:
            continue  # 数据无变化，跳过
        if old_sessions is not None:
            conn.execute("DELETE FROM daily_summaries WHERE date = ?", (day,))

        proj_names = [p.strip() for p in projects_csv.split(",") if p.strip()]

        # 获取当天的 work items 概要
        work_rows = conn.execute("""
            SELECT project_name, user_query FROM rag_knowledge_chunks
            WHERE date(timestamp/1000, 'unixepoch', '+8 hours') = ?
            AND length(user_query) > 10
            ORDER BY timestamp
        """, (day,)).fetchall()

        # 按项目分组并分类
        proj_items = {}  # type: Dict[str, List[Dict]]
        categories = {
            "requirements_discussion": 0, "coding": 0, "problem_solving": 0,
            "refactoring": 0, "code_review": 0, "documentation": 0,
            "testing": 0, "other": 0,
        }
        for proj, query in work_rows:
            cat = classify_category(query)
            cat_key = _map_category_to_daily(cat)
            categories[cat_key] = categories.get(cat_key, 0) + 1

            items = proj_items.setdefault(proj, [])
            if len(items) < 5:  # 每项目最多 5 条
                items.append({
                    "category": cat_key,
                    "description": query[:120],
                    "session_id": "",
                })

        # 构建 projects JSON
        projects_json = []
        for proj in proj_names:
            p_chunks = conn.execute("""
                SELECT count(DISTINCT session_id) FROM rag_knowledge_chunks
                WHERE project_name = ?
                AND date(timestamp/1000, 'unixepoch', '+8 hours') = ?
            """, (proj, day)).fetchone()[0]

            projects_json.append({
                "project_name": proj,
                "project_path": "",
                "workspace_id": "",
                "work_items": proj_items.get(proj, []),
                "sessions": [],
                "session_count": p_chunks,
            })

        # 构建 summary 文本
        summary_lines = [f"# {day} 工作总结", "", "## 概览"]
        summary_lines.append(
            f"当日共 {session_count} 个会话，{chunk_count} 条对话记录，"
            f"涉及 {len(proj_names)} 个项目。"
        )
        summary_lines.extend(["", "## 项目详情"])
        for proj in proj_names:
            summary_lines.append(f"\n### {proj}")
            for item in proj_items.get(proj, []):
                summary_lines.append(f"- [{item['category']}] {item['description']}")

        summary_text = "\n".join(summary_lines)
        summary_id = hashlib.md5(f"daily:{day}".encode()).hexdigest()

        conn.execute("""
            INSERT OR IGNORE INTO daily_summaries
            (id, date, summary, language, work_categories,
             total_sessions, projects, created_at, updated_at)
            VALUES (?,?,?,?,?, ?,?,?,?)
        """, (
            summary_id, day, summary_text, "zh",
            json.dumps(categories, ensure_ascii=False),
            session_count,
            json.dumps(projects_json, ensure_ascii=False),
            now_s, now_s,
        ))
        written += 1

    if written:
        log.info("生成 daily_summaries: %d 天", written)
    return written


def _sync_session_reviews(conn: sqlite3.Connection, dry_run: bool = False) -> int:
    """扫描编排 session 的 lessons/improvements/session-analysis 文件，回灌知识库"""
    sessions_dir = Path(os.environ.get("PIPELINE_SESSIONS_DIR", "/opt/pipeline-orchestrator/sessions"))
    if not sessions_dir.exists():
        return 0

    written = 0
    review_files = ["lessons.md", "improvements.md", "session-analysis.md"]
    patterns = []
    for f in review_files:
        patterns.append(f"pipe-*/{f}")
        patterns.append(f"*/pipe-*/{f}")

    for pattern in patterns:
        for fpath in sessions_dir.glob(pattern):
            try:
                content = fpath.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if not content or len(content) < 20:
                continue

            session_dir = fpath.parent
            session_id = session_dir.name
            file_type = fpath.stem  # lessons / improvements / session-analysis

            # 从 state.json 读 project_id
            project_id = "_default"
            state_path = session_dir / "state.json"
            if state_path.exists():
                try:
                    state = json.loads(state_path.read_text(encoding="utf-8"))
                    project_id = state.get("project_id", "_default")
                except (json.JSONDecodeError, OSError):
                    pass

            # 按 ## 拆分
            sections = re.split(r'\n(?=## )', content)
            for idx, section in enumerate(sections):
                section = section.strip()
                if len(section) < 10:
                    continue
                content_hash = hashlib.md5(section.encode()).hexdigest()
                chunk_id = hashlib.sha256(f"review:{session_id}:{file_type}:{idx}".encode()).hexdigest()[:32]

                title_match = re.match(r'^##?\s+(.+)', section)
                topic = title_match.group(1)[:50] if title_match else file_type

                tags = json.dumps(["review", file_type], ensure_ascii=False)
                if "improvement" in file_type:
                    tags = json.dumps(["review", "improvement"], ensure_ascii=False)

                if not dry_run:
                    try:
                        conn.execute("""
                            INSERT OR IGNORE INTO rag_knowledge_chunks
                            (id, session_id, chunk_index, project_id, project_name,
                             user_query, ai_response_core, vector_text,
                             has_code, timestamp, content_hash, source, main_topic, tags)
                            VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?)
                        """, (
                            chunk_id, session_id, idx,
                            project_id, project_id,
                            topic, section[:2000], topic + "\n" + section[:2000],
                            0, int(fpath.stat().st_mtime * 1000),
                            content_hash, "review", topic, tags,
                        ))
                        written += 1
                    except sqlite3.IntegrityError:
                        pass
                else:
                    written += 1

    if written:
        log.info("session reviews 回灌: %s %d 条", "将写入" if dry_run else "已写入", written)
    return written


def _map_category_to_daily(cat: str) -> str:
    """将 prompt category 映射到 daily_summaries 的 work_categories 键"""
    mapping = {
        "debug": "problem_solving",
        "feature": "coding",
        "refactor": "refactoring",
        "architecture": "requirements_discussion",
        "devops": "other",
        "analysis": "requirements_discussion",
        "documentation": "documentation",
        "other": "other",
    }
    return mapping.get(cat, "other")


def _pair_messages(sess: Session) -> List[Tuple[str, str]]:
    """将消息按 user→assistant 配对"""
    pairs = []
    i = 0
    msgs = sess.messages
    while i < len(msgs):
        if msgs[i].role == "user":
            user_text = msgs[i].text
            ai_text = ""
            if i + 1 < len(msgs) and msgs[i + 1].role == "assistant":
                ai_text = msgs[i + 1].text
                i += 2
            else:
                i += 1
            pairs.append((user_text, ai_text))
        else:
            i += 1
    return pairs


def _short_name(project_name: str) -> str:
    """home-go-src-github-com-org-myproject -> org-myproject"""
    if not project_name or project_name == "unknown":
        return project_name
    parts = project_name.split("-")
    meaningful = [p for p in parts if p not in ("home", "go", "src", "github", "com", "gitlab")]
    if len(meaningful) >= 2:
        return "-".join(meaningful[-2:])
    return meaningful[-1] if meaningful else project_name


# ─── CLI ───

def main():
    parser = argparse.ArgumentParser(description="Cursor 聊天记录同步工具")
    parser.add_argument("--full", action="store_true", help="全量重建（清空后重导）")
    parser.add_argument("--dry-run", action="store_true", help="只分析不写入")
    args = parser.parse_args()

    try:
        sync(full=args.full, dry_run=args.dry_run)
    except Exception:
        log.exception("同步失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
