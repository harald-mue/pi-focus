# Architecture

## Fullscreen layout

Pi 1.1.0 already builds a chat viewport: a primary transcript `ScrollView` plus a fixed bottom dock (pending, status, widgets, editor, footer). Pi Focus leaves that tree intact and wraps it:

```text
┌── Pi native viewport ───────────────────────────────────────────┬─ dashboard ─┐
│ transcript ScrollView (header + resources + chat)     │            │
│ dock: pending / status / widgets / editor / footer     │            │
└──────────────────────────────────────────────────────┴────────────┘
```

The dashboard is 48 columns wide with a two-column gap. It is visible only at 110×28 or larger and can be toggled with Alt+M or `/focus`.

If the TUI is not viewport-capable or no primary `ScrollView` is found on the native layout root, Pi Focus reports a warning and does not attach the dashboard.

On `session_shutdown` the previous native layout root is restored so `/reload` and session replacement do not nest `HStack` wrappers.

## Scrolling and selection

Pi owns transcript keyboard scrolling (`PageUp`/`PageDown`, `Ctrl+Home`/`Ctrl+End`, prompt jump, search, jump-to-latest). Pi Focus does not unbind those actions. `/wheel-scroll` is an optional extra that routes arrow/page keys to the transcript while the editor is empty.

Pi's fullscreen renderer owns alternate-screen lifecycle, mouse reporting, wheel acceleration, and selection.

## Input and clipboard

`FocusEditor` extends Pi's `CustomEditor` with `embedWorkingStatus: true`. App actions, autocomplete, Shift+Enter/Ctrl+J newlines, and Ctrl+V clipboard paste go through `super.handleInput()`.

Ctrl+V is Pi's `app.clipboard.pasteImage` action: files (macOS), images via a temp file, then plain text. Bracketed paste continues through the editor.

Pi wires right-click paste only on Windows. On Linux, Pi Focus wraps `handleRightClickPaste` so button-2 still calls Pi's clipboard paste into the focused editor.

## Session lifecycle

Pi invalidates an extension context before replacing a session. Fixed chrome must not access a captured context or session manager during `render()`. The footer and `ControlCenter` render only from plain snapshots.

The dashboard title is resolved as follows:

1. explicit session name from `/name`
2. first user message on the active branch
3. `new session`

Each replacement `session_start` installs fresh chrome for the new runtime.

## Dashboard data

The dashboard shows:

- session title, project, and current phase
- provider/model plus supported quota and rate-limit information (Copilot, Codex, and Cursor period usage)
- Git branch, tracking, latest commit, stash, and working-tree state
- current request, active tools, and recent tool durations (`tool_execution_end.durationMs`)
- aborted runs from `agent_settled.aborted`

Provider quota refreshes are generation-guarded so late responses from an old provider or session cannot overwrite current state.

## Compatibility boundary

The extension currently targets Pi 1.1.0. It requires a viewport-capable fullscreen TUI and a primary transcript `ScrollView` on Pi's layout root.
