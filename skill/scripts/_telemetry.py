"""遥测、审计与管理台 API 通信。"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

from _state import now

API_BASE = os.environ.get("PIPELINE_API_BASE", "http://localhost:18000/api").rstrip("/")


def append_telemetry(session_dir: str, payload: dict) -> None:
    """追加 JSONL 遥测；失败不阻塞主流程。"""
    path = Path(session_dir) / "telemetry.jsonl"
    rec = {"ts_iso": now(), **payload}
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def notify_event(session_dir, event_type, task_id=None, data=None):
    """向管理台上报事件，失败时静默。同时写本地审计日志。"""
    session_id = os.path.basename(session_dir)

    audit_data = dict(data) if data else {}
    if task_id:
        audit_data["task_id"] = task_id
    audit_write(session_dir, session_id, event_type, audit_data or None)

    url = f"{API_BASE}/events"
    payload = {
        "session_id": session_id,
        "event_type": event_type,
        "timestamp": now(),
    }
    if task_id:
        payload["task_id"] = task_id
    if data:
        payload["data"] = data
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


def audit_write(session_dir: str, session_id: str, event: str, data: dict | None = None) -> None:
    """追加写 session 级审计日志 $DIR/audit.jsonl。"""
    path = Path(session_dir) / "audit.jsonl"
    rec = {"ts": now(), "session_id": session_id, "event": event}
    if data:
        rec["data"] = data
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"WARN: audit write failed: {e}", file=sys.stderr)


def api_get(path: str):
    """调用管理台 GET API，返回 dat 字段。失败返回 None。"""
    url = f"{API_BASE}{path}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("dat", data)
    except Exception as e:
        print(f"WARN: API {url} failed: {e}", file=sys.stderr)
        return None
