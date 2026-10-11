# Pi Focus

Pi Focus is a Pi coding-agent extension that adds a right-hand status dashboard, token-usage commands, session bulk deletion, and a matching theme on top of Pi's native fullscreen TUI.

## Features

- wraps Pi 1.1.0's native chat viewport instead of rebuilding the layout tree
- responsive 48-column dashboard (session, provider quota including Cursor period usage, Git, tool activity)
- session-safe `/resume`, `/new`, and `/reload` behavior
- session titles derived from the explicit name or first user message
- Ctrl+V clipboard paste (text, files, images) via Pi's `app.clipboard.pasteImage`
- Linux right-click paste (Pi enables that handler on Windows only)
- `/last-request`, `/last-request-dump`, and `/delete-sessions`

## Project layout

```text
extensions/pi-focus/
  index.ts                         UI, layout, commands, and event hooks
  token-usage.ts                   Token debugging commands
  session-bulk-delete.ts           Session cleanup command
  provider-usage.ts                Provider quota and rate-limit helpers
  theme/pi-focus.json              Bundled theme
  skills/last-request-tokens/      Token-debugging skill
scripts/install.sh                 Installer
scripts/pty-regression.py          Dependency-free PTY smoke regression
docs/                              Design and maintenance documentation
```

## Requirements

- Pi coding agent 1.1.0 or a compatible newer release
- Bash and Python 3
- Fullscreen TUI (Pi's default; the installer also sets `tuiMode: "fullscreen"`)

## Install

```bash
./scripts/install.sh
```

Optional commands:

```bash
./scripts/install.sh --enable-pi-focus-theme
./scripts/install.sh --dry-run
```

The installer writes to `${PI_CODING_AGENT_DIR:-~/.pi/agent}` and backs up replaced files under `~/.pi/agent/customization-backups/`. Restart Pi after installation; restarting is safer than `/reload` after layout or session-lifecycle changes.

## Controls

| Input | Action |
|---|---|
| Shift+Enter or Ctrl+J | Insert a new line (Pi `tui.input.newLine`; Ghostty reports Shift+Enter, KGX/VTE may send plain Enter) |
| Ctrl+V | Paste clipboard text, files, or images |
| PageUp / PageDown | Scroll the transcript |
| Ctrl+Home / Ctrl+End | Transcript top / jump to latest |
| Ctrl+Shift+↑/↓ | Jump to previous/next marked prompt (Pi default) |
| Right-click in input | Paste from clipboard on Linux (Focus) and Windows (Pi) |
| Alt+M or `/focus` | Hide or show the dashboard |
| `/wheel-scroll` | Optional: arrow keys scroll the transcript while the editor is empty |
| Ctrl+Z | Suspend Pi |

Do not bind Ctrl+Shift+M: Ctrl+M can alias Enter in legacy terminal input.

## Documentation

- `docs/CURRENT_STATE.md` — supported behavior and constraints
- `docs/ARCHITECTURE.md` — layout and lifecycle design
- `docs/TESTING.md` — regression checklist
- `docs/AGENT.md` — maintainer instructions
- `docs/BACKUPS.md` — backup and restore procedure
- `docs/FINDINGS_AND_PLAN.md` — design rationale and remaining work
- `docs/CHANGELOG.md` — concise release notes
