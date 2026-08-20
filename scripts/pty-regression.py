#!/usr/bin/env python3
"""Small PTY regression harness for Pi Focus.

The script runs Pi with the repository extension inside a real pseudo-terminal.
It currently covers extension loading in PTY conditions and fails on common
extension diagnostics/stack traces. It is intentionally dependency-free so it
can be used as a base for future interactive /resume and clipboard scenarios.
"""

from __future__ import annotations

import os
import pty
import select
import signal
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CMD = [
    "pi",
    "--offline",
    "--no-extensions",
    "-e",
    str(ROOT / "extensions/pi-focus/index.ts"),
    "--list-models",
    "__no_such_model__",
]
FAIL_PATTERNS = [
    "Error loading extension",
    "Rendered line",
    "TypeError:",
    "ReferenceError:",
    "SyntaxError:",
    "ctx is stale",
    "stack trace",
]


def run_pty(cmd: list[str], timeout: float = 20.0) -> tuple[int, str]:
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execvp(cmd[0], cmd)

    output = bytearray()
    deadline = time.monotonic() + timeout
    status: int | None = None
    try:
        while time.monotonic() < deadline:
            try:
                finished, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if finished:
                break

            ready, _, _ = select.select([fd], [], [], 0.1)
            if fd in ready:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    continue
                output.extend(chunk)
        else:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise TimeoutError(f"PTY command timed out after {timeout:.0f}s")
    finally:
        os.close(fd)

    if status is None:
        _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    return code, output.decode("utf-8", errors="replace")


def main() -> int:
    cmd = sys.argv[1:] or DEFAULT_CMD
    code, output = run_pty(cmd)
    sys.stdout.write(output)
    failed = [pattern for pattern in FAIL_PATTERNS if pattern in output]
    if code != 0:
        print(f"PTY regression failed: exit code {code}", file=sys.stderr)
        return code or 1
    if failed:
        print(f"PTY regression failed: matched diagnostics: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("PTY regression passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
