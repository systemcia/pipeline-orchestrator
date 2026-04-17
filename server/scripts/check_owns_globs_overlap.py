#!/usr/bin/env python3
"""静态检查 state.json 中并行 task 的 owns_globs 是否可能重叠（启发式）。

用法:
  python3 scripts/check_owns_globs_overlap.py <path/to/state.json>

退出码: 0 无告警，1 发现可能重叠或格式错误。

说明: 仅比较路径前缀启发式，非完整 glob 语义；见 references/snapshot-ops.md。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _root(g: str) -> str:
    g = g.strip()
    for sep in ("**", "*"):
        if sep in g:
            g = g.split(sep, 1)[0]
    return g.rstrip("/")


def _may_overlap(a: str, b: str) -> bool:
    ra, rb = _root(a), _root(b)
    if not ra or not rb:
        return True
    return ra.startswith(rb) or rb.startswith(ra)


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python3 check_owns_globs_overlap.py <state.json>", file=sys.stderr)
        return 1
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"ERROR: 文件不存在: {path}", file=sys.stderr)
        return 1
    state = json.loads(path.read_text(encoding="utf-8"))
    tasks = state.get("tasks") or []
    entries = []
    for t in tasks:
        tid = t.get("id", "?")
        globs = t.get("owns_globs") or []
        if isinstance(globs, list) and globs:
            entries.append((tid, globs))

    bad = False
    for i, (id_a, ga) in enumerate(entries):
        for id_b, gb in entries[i + 1 :]:
            for a in ga:
                for b in gb:
                    if not isinstance(a, str) or not isinstance(b, str):
                        print(f"ERROR: owns_globs 须为字符串列表 (task {id_a}/{id_b})", file=sys.stderr)
                        bad = True
                        continue
                    if _may_overlap(a, b):
                        print(
                            f"WARN: 可能路径重叠 task {id_a!r} glob {a!r} vs task {id_b!r} glob {b!r}",
                            file=sys.stderr,
                        )
                        bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
