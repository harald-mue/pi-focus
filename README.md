# Pi Focus

Pi Focus is a Pi coding-agent extension that adds a fixed conversation viewport, a right-hand status dashboard, token-usage commands, session bulk deletion, and a matching theme.

## Features

- transcript-only keyboard scrolling in Pi's fullscreen TUI
- fixed input area, footer, and responsive 48-column dashboard
- provider quota, Git, session, and tool-activity information
- session-safe `/resume`, `/new`, and `/reload` behavior on Pi 0.84
- session titles derived from the explicit name or first user message
- reliable native terminal right-click context menu and paste
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

- Pi coding agent 0.84.1 or a compatible newer release
- Bash and Python 3
- `tuiMode: "fullscreen"` (set by the installer)

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
| Shift+Enter (Ghostty and compatible terminals) or Ctrl+J (KGX fallback) | Insert a new line |
| Ctrl+Shift+↑/↓ | Scroll history by three rows |
| Right-click in input box | Open the terminal context menu (including Paste) |
| F2, Alt+M, or `/focus` | Hide or show the dashboard |
| Ctrl+Z | Suspend Pi |

Modified-key support is terminal-dependent: Ghostty reports Shift+Enter distinctly, while KGX/VTE sends it as plain Enter. Use Ctrl+J for a newline in KGX.

## Documentation

- `docs/CURRENT_STATE.md` — supported behavior and constraints
- `docs/ARCHITECTURE.md` — layout and lifecycle design
- `docs/TESTING.md` — regression checklist
- `docs/AGENT.md` — maintainer instructions
- `docs/BACKUPS.md` — backup and restore procedure
- `docs/FINDINGS_AND_PLAN.md` — design rationale and remaining work
- `docs/CHANGELOG.md` — concise release notes
