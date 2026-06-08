"""Session.md 操作：section 更新、context.md 重建、压缩与归档。"""

from __future__ import annotations

import sys
from pathlib import Path


def count_section_entries(text: str, section: str) -> int:
    """统计 section 中以 '### ' 开头的条目数。"""
    marker = f"## {section}"
    if marker not in text:
        return 0
    idx = text.index(marker) + len(marker)
    next_sec = text.find("\n## ", idx)
    block = text[idx:next_sec] if next_sec != -1 else text[idx:]
    return block.count("\n### ")


def archive_oldest_entry(session_dir: str, text: str, section: str) -> str:
    """将 section 中最早的 '### ' 条目移到 archive-session.md，返回更新后的 text。"""
    marker = f"## {section}"
    idx = text.index(marker) + len(marker)
    next_sec = text.find("\n## ", idx)
    block = text[idx:next_sec] if next_sec != -1 else text[idx:]

    first_entry = block.find("\n### ")
    if first_entry == -1:
        return text
    second_entry = block.find("\n### ", first_entry + 1)
    if second_entry == -1:
        return text

    entry_text = block[first_entry:second_entry]
    archive_path = Path(session_dir) / "archive-session.md"
    is_new = not archive_path.exists()
    with open(archive_path, "a") as f:
        if is_new:
            f.write("# Archived Session Details\n")
        f.write(entry_text + "\n")

    new_block = block[:first_entry] + block[second_entry:]
    after = text[next_sec:] if next_sec != -1 else ""
    return text[:idx] + new_block + after


def split_stage_detail_task_entries(block: str) -> tuple[str, list[str]]:
    """解析「当前阶段详情」正文：preamble + ### Task 条目列表。"""
    lines = block.split("\n")
    preamble: list[str] = []
    entries: list[str] = []
    current: list[str] | None = None
    for line in lines:
        if line.startswith("### Task"):
            if current is not None:
                entries.append("\n".join(current))
            current = [line]
        else:
            if current is None:
                preamble.append(line)
            else:
                current.append(line)
    if current is not None:
        entries.append("\n".join(current))
    preamble_text = "\n".join(preamble)
    return preamble_text, entries


def compact_session_md_current_stage(session_dir: str) -> tuple[int, int] | None:
    """session.md > 300 行时压缩「当前阶段详情」，保留最近 3 个 task 条目。"""
    sm = Path(session_dir) / "session.md"
    text = sm.read_text(encoding="utf-8", errors="replace")
    old_lines = text.count("\n") + 1
    if old_lines <= 300:
        return None
    marker = "## 当前阶段详情"
    if marker not in text:
        return None
    i0 = text.index(marker)
    start_body = i0 + len(marker)
    next_sec = text.find("\n## ", start_body)
    before = text[:i0]
    after = text[next_sec:] if next_sec != -1 else ""
    block = text[start_body:next_sec] if next_sec != -1 else text[start_body:]
    preamble, entries = split_stage_detail_task_entries(block)
    if len(entries) <= 3:
        return None

    to_archive = entries[:-3]
    kept = entries[-3:]
    archive_path = Path(session_dir) / "archive-session.md"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    is_new = not archive_path.exists()
    with open(archive_path, "a", encoding="utf-8") as f:
        if is_new:
            f.write("# Archived Session Details\n\n")
        for piece in to_archive:
            f.write(piece.strip() + "\n\n")

    if preamble:
        new_block = preamble + "\n" + "\n\n".join(kept)
    else:
        new_block = "\n\n".join(kept)
    if block.startswith("\n") and not new_block.startswith("\n"):
        new_block = "\n" + new_block
    new_text = before + marker + new_block + after
    sm.write_text(new_text, encoding="utf-8")
    new_lines = new_text.count("\n") + 1
    return (old_lines, new_lines)


def compress_rag_section(text: str) -> str:
    """压缩「历史经验」section，仅保留最近 2 次 RAG 查询。"""
    marker = "## 历史经验"
    if marker not in text:
        return text
    idx = text.index(marker) + len(marker)
    next_sec = text.find("\n## ", idx)
    block = text[idx:next_sec] if next_sec != -1 else text[idx:]

    entries = block.split("\n### ")
    if len(entries) <= 3:
        return text

    kept = "\n### ".join(entries[-2:])
    new_block = "\n### " + kept if kept else ""
    after = text[next_sec:] if next_sec != -1 else ""
    return text[:idx] + new_block + after


def update_session_section(session_dir: str, section: str, content: str,
                           mode: str = "append"):
    """更新 session.md 指定 section，含膨胀保护。"""
    sm = Path(session_dir) / "session.md"
    if not sm.exists():
        print(f"ERROR: {sm} 不存在", file=sys.stderr)
        sys.exit(1)

    text = sm.read_text()
    marker = f"## {section}"

    if marker not in text:
        text += f"\n{marker}\n{content}\n"
    else:
        idx = text.index(marker) + len(marker)
        next_sec = text.find("\n## ", idx)
        if mode == "replace":
            before = text[:idx]
            after = text[next_sec:] if next_sec != -1 else ""
            text = before + f"\n{content}\n" + after
        else:
            insert_at = next_sec if next_sec != -1 else len(text)
            text = text[:insert_at].rstrip() + f"\n{content}\n" + text[insert_at:]

    if section == "当前阶段详情":
        max_archive_rounds = 10
        while count_section_entries(text, section) > 5 and max_archive_rounds > 0:
            prev = text
            text = archive_oldest_entry(session_dir, text, section)
            max_archive_rounds -= 1
            if text == prev:
                break

    total_lines = text.count("\n") + 1
    if total_lines > 200:
        text = compress_rag_section(text)

    sm.write_text(text)


def rebuild_context_md(session_dir: str) -> int:
    """从 session.md 精简生成 context.md（≤ 3000 字符），返回字符数。"""
    sm = Path(session_dir) / "session.md"
    if not sm.exists():
        return 0
    text = sm.read_text(encoding="utf-8", errors="replace")

    def _extract_section(t: str, name: str) -> str:
        marker = f"## {name}"
        if marker not in t:
            return ""
        idx = t.index(marker) + len(marker)
        nxt = t.find("\n## ", idx)
        return t[idx:nxt].strip() if nxt != -1 else t[idx:].strip()

    budget = 3000
    parts: list[str] = ["# Context (auto-generated)\n"]

    requirement = _extract_section(text, "用户原始需求")
    if len(requirement) > 800:
        requirement = requirement[:797] + "..."
    if requirement:
        parts.append(f"## 需求摘要\n{requirement}\n")

    constraints = _extract_section(text, "关键约束和决策")
    if constraints:
        lines = [l for l in constraints.split("\n") if l.strip()]
        parts.append("## 关键约束\n" + "\n".join(lines[:5]) + "\n")

    stage = _extract_section(text, "当前阶段详情")
    if stage:
        entries = stage.split("\n### ")
        recent = entries[-3:] if len(entries) > 3 else entries
        trimmed = "\n### ".join(recent)
        if not trimmed.startswith("### ") and len(recent) > 0 and entries[0] != recent[0]:
            trimmed = "### " + trimmed
        parts.append(f"## 最近产出\n{trimmed}\n")

    rag = _extract_section(text, "历史经验")
    if rag:
        rag_entries = rag.split("\n### ")
        if len(rag_entries) > 1:
            latest = rag_entries[-1]
            parts.append(f"## 历史经验\n### {latest}\n")

    result = "\n".join(parts)
    if len(result) > budget:
        result = result[:budget - 3] + "..."

    ctx_path = Path(session_dir) / "context.md"
    ctx_path.write_text(result, encoding="utf-8")
    chars = len(result)
    if chars >= budget:
        print(
            f"WARN: context.md ({chars} chars) hit budget ceiling ({budget}), "
            "SubAgent 上下文可能被截断",
            file=sys.stderr,
        )
    return chars
