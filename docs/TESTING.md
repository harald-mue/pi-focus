# Testing

## Automated smoke regression

```bash
./scripts/pty-regression.py
```

Expected: exit code 0, `PTY regression passed.`, and no extension diagnostic, stack trace, rendered-width error, stale-context warning, or Pi Focus layout incompatibility warning. The script runs Pi with the repository extension inside a real pseudo-terminal.

## Extension load

```bash
pi --offline --no-extensions \
  -e ./extensions/pi-focus/index.ts \
  --list-models '__no_such_model__'
```

Expected: exit code 0 with no extension diagnostic or stack trace.

## Installation consistency

After `./scripts/install.sh`:

```bash
cmp extensions/pi-focus/index.ts ~/.pi/agent/extensions/pi-focus/index.ts
```

Also compare the bundled theme and skill when they changed.

## Fullscreen layout

1. Confirm `~/.pi/agent/settings.json` contains `"tuiMode": "fullscreen"` (Pi 1.1.0 defaults to fullscreen even without this).
2. Start Pi at 110×28 or larger.
3. Verify the dashboard is a fixed right column and never overlaps transcript text.
4. Verify editor and footer remain fixed at the bottom (Pi dock).
5. Confirm the startup header still lives in the scrolling transcript, not a second pinned header row from a rebuilt tree.
6. Wrap the editor and open autocomplete; growth must reduce transcript height upward.
7. Toggle the dashboard twice with Alt+M and `/focus`.
8. In Ghostty, verify Shift+Enter inserts a new line and plain Enter submits exactly once.
9. In KGX/VTE, verify Shift+Enter is indistinguishable from plain Enter and Ctrl+J inserts a new line.
10. Resize through 10, 20, 40, 80, 110, 160, 200, and 343 columns.
11. Open `/delete-sessions` at 10, 20, and 40 columns and exercise list and confirmation modes.

There must be no `Rendered line ... exceeds terminal width` error, `fullscreen layout is incompatible` warning, or new crash log.

## Session lifecycle

1. Open `/resume` and select another current-project session.
2. Verify Pi remains running and shows `Resumed session`.
3. Confirm the dashboard shows the explicit session name or first user prompt, not `new session`.
4. Run `/new`, then resume the original session.
5. Run `/reload` once. The dashboard must not nest (no double-width sidebar).
6. Check stderr for absence of `ctx is stale after session replacement or reload`.

## Scrolling

1. Resume a session long enough to fill the viewport.
2. Verify PageUp/PageDown and Ctrl+Home/Ctrl+End move only the transcript.
3. Verify Ctrl+Shift+↑/↓ jumps between marked prompts (Pi default).
4. Verify mouse-wheel scrolling works in the transcript.
5. With `/wheel-scroll` enabled, verify ↑↓ scroll the transcript when the editor is empty. With it disabled (default), verify they navigate editor prompt history.

## Clipboard paste

1. Test ordinary terminal bracketed paste into the editor.
2. Press Ctrl+V with text in the system clipboard; it must insert at the cursor.
3. Ctrl+V with an image should insert a temp file path (Pi behavior).
4. Right-click once in the input box; on Linux, Pi Focus wraps Pi's handler so paste inserts into the editor.
5. Right-click transcript, dashboard, and footer; Pi Focus must not crash or show its own dialog.
6. Test multiline text and content above Pi's paste-marker threshold.
7. Repeat after `/resume` and `/reload`.

## Performance

Use a copied long session in a 200-column PTY. Send characters individually after startup settles and measure input-write to first-output-byte latency.

Recorded baseline:

| Variant | Median | P95 |
|---|---:|---:|
| Full-history clipping | 195.5 ms | 202.3 ms |
| Visible-output clipping | 18.4 ms | 21.8 ms |

Acceptance target: median below 25 ms.

## Cleanup

After normal exit, suspend/resume, session replacement, and reload, verify:

- alternate screen is left correctly
- mouse reporting, bracketed paste, canonical input mode, and echo are restored
- no lingering terminal modes remain set
- crash-log modification time is unchanged
