#!/usr/bin/env python3
"""PTY regression harness for Pi Focus.

Runs Pi with the repository extension inside a real pseudo-terminal.
Tests extension loading and basic interactive startup.
Dependency-free so it can serve as a base for future interactive scenarios.
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
FAIL_PATTERNS = [
    "Error loading extension",
    "Rendered line",
    "TypeError:",
    "ReferenceError:",
    "SyntaxError:",
    "ctx is stale",
    "stack trace",
]
EXTENSION_PATH = str(ROOT / "extensions/pi-focus/index.ts")
LOAD_TIMEOUT = 30.0


def drain_fd(fd: int, timeout: float = 1.0) -> bytes:
    """Read remaining data from a PTY fd until it's empty or timeout elapses."""
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if fd not in ready:
            break
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
    return bytes(output)


def run_pty(cmd: list[str], timeout: float = LOAD_TIMEOUT) -> tuple[int, str]:
    """Fork a PTY, run *cmd*, capture output until EOF or timeout."""
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
                # Process exited — drain remaining PTY output before closing.
                output.extend(drain_fd(fd, 0.5))
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
            time.sleep(0.3)
            output.extend(drain_fd(fd, 0.3))
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise TimeoutError(f"PTY command timed out after {timeout:.0f}s")
    finally:
        os.close(fd)

    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    code = os.waitstatus_to_exitcode(status)
    return code, output.decode("utf-8", errors="replace")


def test_extension_load() -> int:
    """Test that the extension loads without diagnostics in a --list-models run."""
    cmd = [
        "pi",
        "--offline",
        "--no-extensions",
        "-e", EXTENSION_PATH,
        "--list-models",
        "__no_such_model__",
    ]
    code, output = run_pty(cmd)
    sys.stdout.write(output)
    failed = [p for p in FAIL_PATTERNS if p in output]
    if code != 0:
        print(f"[FAIL] exit code {code}", file=sys.stderr)
        return code or 1
    if failed:
        print(f"[FAIL] matched diagnostics: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("[PASS] extension load")
    return 0


def test_interactive_startup() -> int:
    """Test that Pi starts interactively with the extension, loads fully, and
    exits cleanly via Ctrl+C without errors in the output stream."""
    cmd = [
        "pi",
        "--offline",
        "--no-extensions",
        "-e", EXTENSION_PATH,
    ]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execvp(cmd[0], cmd)

    output = bytearray()
    deadline = time.monotonic() + LOAD_TIMEOUT
    status: int | None = None
    started = False
    try:
        while time.monotonic() < deadline:
            try:
                finished, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if finished:
                output.extend(drain_fd(fd, 0.5))
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
                text = output.decode("utf-8", errors="replace")

                # Wait until pi's fullscreen TUI has started, then send Ctrl+C.
                if not started and ("v" in text or b"\x1b[" in output):
                    started = True
                    os.write(fd, b"\x03")  # Ctrl+C
        else:
            # Timed out — send Ctrl+C and drain.
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.write(fd, b"\x03")
            time.sleep(0.3)
            output.extend(drain_fd(fd, 0.3))
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if not started:
                raise TimeoutError("Interactive startup did not produce output within timeout")
    finally:
        os.close(fd)

    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    text = output.decode("utf-8", errors="replace")
    sys.stdout.write(text)
    failed = [p for p in FAIL_PATTERNS if p in text]
    if failed:
        print(f"[FAIL] matched diagnostics in interactive output: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("[PASS] interactive startup")
    return 0


def main() -> int:
    failures = 0
    failures += test_extension_load()
    failures += test_interactive_startup()

    if failures == 0:
        print("PTY regression passed.")
        return 0
    print(f"PTY regression: {failures} test(s) failed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())