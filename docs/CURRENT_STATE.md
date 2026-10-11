# Current state

- Updated: 2026-10-10
- Validated with Pi: 1.1.0

## Layout

Pi Focus wraps Pi's native fullscreen chat viewport (`createChatViewport` inside Pi):

- transcript `ScrollView` and input dock stay Pi-owned
- a 48-column dashboard is placed in an `HStack` beside that viewport
- the dashboard appears at 110×28 or larger and can be toggled with Alt+M or `/focus`

Pi Focus does not rebuild the seven-container tree or replace the transcript `ScrollView`.

## Controls

- Shift+Enter / Ctrl+J: Pi newline (`tui.input.newLine`)
- Ctrl+V: Pi clipboard paste (`app.clipboard.pasteImage` — text, files, images)
- PageUp / PageDown: Pi transcript scroll
- Ctrl+Home / Ctrl+End: transcript top / follow latest
- Ctrl+Shift+↑/↓: Pi prompt jump (not remapped)
- Right-click paste: enabled on Linux by wrapping Pi's handler (Pi itself gates that path to Windows)
- Alt+M or `/focus`: toggle dashboard
- `/wheel-scroll`: optional arrow/page-key transcript scrolling while the editor is empty (default off)
- Ctrl+Z: suspend Pi

## Dashboard

The dashboard reports session/project identity, provider and model, supported quota/rate data (including Cursor Included/Auto/API period usage from `/login cursor` or `CURSOR_ACCESS_TOKEN`, with the desktop DB and Team Admin spend as fallbacks), Git status, request timing, and tool activity. **OpenAI (Sign in with ChatGPT)** does not expose the Codex `wham/usage` API to the SIWC access token; Pi Focus shows a **Manage usage** hint and `/chatgpt-usage` opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage?tab=overview). Live 5h/weekly meters appear when **OpenAI Codex (legacy)** is logged in, or when `CHATGPT_USAGE_SESSION_TOKEN` is set to a browser session cookie (advanced). Named sessions use their explicit name; unnamed resumed sessions use their first user message instead of `new session`. Aborted runs are labeled from `agent_settled.aborted`. Nested tool calls (`parentToolCallId`) are omitted from activity.

## Session behavior

`/resume` and other session replacements install fresh chrome. Footer and dashboard rendering use plain runtime snapshots instead of captured extension contexts. On shutdown the native layout root is restored so a later load does not nest dashboards.

## Additional commands

- `/provider-usage` — refresh supported provider quota information
- `/chatgpt-usage` — open ChatGPT Settings → Usage in the browser
- `/last-request` — concise usage summary
- `/last-request-dump [path]` — detailed request dump
- `/delete-sessions` — bulk session deletion

## Constraints

- Fullscreen TUI is required. Layout attachment finds Pi's primary transcript `ScrollView` on the native `layoutRoot`.
- Clipboard paste depends on Pi's bundled native clipboard package and desktop clipboard availability.
- Shift+Enter depends on terminal modifier reporting. It works in Ghostty; KGX/VTE often sends plain Enter, so use Ctrl+J there.
- Restart Pi after changing layout or session-lifecycle code.
