# Testing

## Automated smoke regression

```bash
./scripts/pty-regression.py
```

Expected: exit code 0, `PTY regression passed.`, and no extension diagnostic, stack trace, rendered-width error, or stale-context warning. The script runs Pi with the repository extension inside a real pseudo-terminal and is the baseline for future automated `/resume` and clipboard scenarios.

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

1. Confirm `~/.pi/agent/settings.json` contains `"tuiMode": "fullscreen"`.
2. Start Pi at 110×28 or larger.
3. Verify the dashboard is a fixed right column and never overlaps transcript text.
4. Verify editor and footer remain fixed at the bottom.
5. Wrap the editor and open autocomplete; growth must reduce transcript height upward.
6. Toggle the dashboard twice with F2, Alt+M, and `/focus` (Ctrl+Shift+M may work only in terminals that report it distinctly).
7. Resize through 10, 20, 40, 80, 110, 160, 200, and 343 columns.
8. Open `/delete-sessions` at 10, 20, and 40 columns and exercise list and confirmation modes.

There must be no `Rendered line ... exceeds terminal width` error or new crash log.

## Session lifecycle

1. Open `/resume` and select another current-project session.
2. Verify Pi remains running and shows `Resumed session`.
3. Confirm the dashboard shows the explicit session name or first user prompt, not `new session`.
4. Run `/new`, then resume the original session.
5. Run `/reload` once.
6. Check stderr for absence of `ctx is stale after session replacement or reload`.

## Scrolling

1. Resume a session long enough to fill the viewport.
2. Verify Ctrl+Shift+↑/↓ moves history by three rows without moving editor focus.
3. Verify mouse-wheel and application-owned drag selection are inactive while native context-menu mode is enabled.

## Clipboard paste


1. Test ordinary terminal bracketed paste into the editor.
2. Press Ctrl+V with text in the system clipboard.
3. In VTE/KGX, right-click once in the input box and verify the native terminal context menu opens; choose Paste and verify insertion.
4. Right-click transcript, dashboard, and footer; Pi Focus must not consume the click or perform extension-emulated paste.
5. Test multiline text and content above Pi's paste-marker threshold.
6. Repeat after `/resume` and `/reload`.

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
- mouse reporting remains disabled while Pi Focus is active and terminal modes are restored on exit
- bracketed paste, canonical input mode, and echo are restored
- no viewport-input wrapper is installed
- crash-log modification time is unchanged
