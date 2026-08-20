# Current state

- Updated: 2026-08-12
- Validated with Pi: 0.84.1

## Layout

Pi Focus uses Pi's native fullscreen `HStack`, `VStack`, and `ScrollView` primitives:

- auto-hiding header
- transcript-only scrolling region
- fixed bottom dock for pending messages, status, widgets, editor, and footer
- responsive 48-column dashboard on the right

The dashboard appears at 110×28 or larger. A growing input area remains anchored to the bottom and reduces transcript height upward.

## Controls

- Shift+Enter in Ghostty and other terminals with modified-key reporting: insert a new line
- Ctrl+J in KGX/VTE or any terminal that sends Shift+Enter as plain Enter: insert a new line
- Ctrl+Shift+↑/↓: scroll transcript by three rows
- Right-click on the input row: open the native terminal context menu
- Ctrl+V: Pi clipboard paste action
- F2, Alt+M, or `/focus`: toggle dashboard
- Ctrl+Z: suspend Pi

## Dashboard

The dashboard reports session/project identity, provider and model, supported quota/rate data, Git status, request timing, and tool activity. Named sessions use their explicit name; unnamed resumed sessions use their first user message instead of `new session`.

## Session behavior

`/resume` and other session replacements are supported on Pi 0.84.1. Footer and dashboard rendering use plain runtime snapshots instead of captured extension contexts or session managers, and fresh chrome is installed for the replacement runtime.

## Additional commands

- `/provider-usage` — refresh supported provider quota information
- `/last-request` — concise usage summary
- `/last-request-dump [path]` — detailed request dump
- `/delete-sessions` — bulk session deletion

## Constraints

- `tuiMode` must be `fullscreen`; the installer enforces it.
- Layout attachment depends on Pi's current seven-container root structure.
- Clipboard access depends on Pi's bundled native clipboard package and desktop clipboard availability.
- Shift+Enter depends on terminal modifier reporting. It works in Ghostty; KGX/VTE sends plain Enter instead, so use Ctrl+J there.
- Pi Focus disables fullscreen mouse reporting after startup so VTE/KGX can open its native right-click context menu. Consequently, mouse-wheel transcript scrolling and application-owned drag selection are unavailable; use keyboard scrolling and the terminal context menu instead.
- Restart Pi after changing layout or session-lifecycle code.
