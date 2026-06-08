"""State management: read/write state.json with file locking."""

from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

try:
    import fcntl
except ImportError:
    if __import__("os").name == "nt":
        print("ERROR: Windows 原生不支持 fcntl 文件锁，请使用 WSL2", file=sys.stderr)
        sys.exit(1)
    raise


def now() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def state_path(session_dir: str) -> Path:
    return Path(session_dir) / "state.json"


def lock_path(session_dir: str) -> Path:
    p = state_path(session_dir).with_suffix(".lock")
    p.touch(exist_ok=True)
    return p


class StateLock:
    """session state 的排他锁上下文管理器，保证 read-modify-write 原子性。"""

    def __init__(self, session_dir: str):
        self._dir = session_dir
        self._lf = None

    def __enter__(self):
        self._lf = open(lock_path(self._dir))
        fcntl.flock(self._lf, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self._lf, fcntl.LOCK_UN)
        self._lf.close()
        self._lf = None


def read_state(session_dir: str) -> dict:
    p = state_path(session_dir)
    if not p.exists():
        print(f"ERROR: {p} 不存在", file=sys.stderr)
        sys.exit(1)
    with open(p) as f:
        return json.load(f)


def write_state(session_dir: str, state: dict):
    state["updated_at"] = now()
    p = state_path(session_dir)
    tmp = p.with_suffix(".tmp")
    try:
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
        tmp.rename(p)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def find_task(state: dict, tid: str) -> dict:
    for t in state["tasks"]:
        if t["id"] == tid:
            return t
    print(f"ERROR: task {tid} not found", file=sys.stderr)
    sys.exit(1)


def duration_ms_since(started_at: str | None) -> int | None:
    if not started_at:
        return None
    try:
        t0 = datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        t1 = datetime.datetime.now().astimezone()
        if t0.tzinfo is None:
            t0 = t0.replace(tzinfo=t1.tzinfo)
        return max(0, int((t1 - t0).total_seconds() * 1000))
    except (ValueError, TypeError):
        return None


def duration_ms_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        t0 = datetime.datetime.fromisoformat(start.replace("Z", "+00:00"))
        t1 = datetime.datetime.fromisoformat(end.replace("Z", "+00:00"))
        ref = datetime.datetime.now().astimezone()
        if t0.tzinfo is None:
            t0 = t0.replace(tzinfo=ref.tzinfo)
        if t1.tzinfo is None:
            t1 = t1.replace(tzinfo=ref.tzinfo)
        return max(0, int((t1 - t0).total_seconds() * 1000))
    except (ValueError, TypeError):
        return None


def next_log_seq(session_dir: str) -> str:
    logs_dir = Path(session_dir) / "logs"
    max_seq = 0
    if logs_dir.is_dir():
        for f in logs_dir.iterdir():
            prefix = f.name[:3]
            if f.suffix == ".md" and len(prefix) == 3 and prefix.isdigit():
                max_seq = max(max_seq, int(prefix))
    return f"{max_seq + 1:03d}"


def write_log(session_dir: str, tid: str, suffix: str = "") -> str:
    """从 stdin 读取日志内容写入文件，返回相对路径。"""
    if sys.stdin.isatty():
        print("ERROR: 需要通过 stdin 传入日志内容", file=sys.stderr)
        sys.exit(1)
    log_seq = next_log_seq(session_dir)
    log_name = f"{log_seq}-{tid}{suffix}.md"
    log_path = Path(session_dir) / "logs" / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as f:
        f.write(sys.stdin.read())
    return f"logs/{log_name}"
