# Design findings and next steps

## Findings that shape the implementation

### Wrap Pi's viewport instead of rebuilding it

Pi 1.1.0 creates a chat viewport (`createChatViewport`) and installs it with `setLayoutRoot` before extensions run. Rebuilding seven root children produced a second `ScrollView`, pinned the header, and broke overscroll, jump-to-latest, and scrollbar theming. Pi Focus now finds the native layout root and primary `ScrollView` and only adds the dashboard `HStack`.

`createChatViewport` is not a public package export. Do not import it from Pi internals.

### Full-history processing hurts editor latency

The original viewport applied ANSI-aware width truncation to every history row on every keystroke. On the recorded long session this produced a 195.5 ms median response. Restricting expensive clipping to visible output reduced the median to 18.4 ms and P95 to 21.8 ms. Future rendering changes must preserve that property.

### Session replacement invalidates contexts before all rendering stops

Pi can render the outgoing layout once after invalidating its extension context. Any component that dereferences a captured `ctx` during `render()` can crash `/resume`. Render components must receive stable values and callbacks that do not touch stale contexts. Restore the native layout root on shutdown so the next runtime does not nest wrappers.

### Unnamed sessions still need useful identity

`SessionManager.getSessionName()` returns `undefined` unless `/name` was used. Pi's selector identifies such sessions by their first user message, so the dashboard follows the same fallback.

### Clipboard: Ctrl+V is Pi's; right-click paste is Windows-only in Pi

`CustomEditor` maps Ctrl+V to `app.clipboard.pasteImage`, which Pi copies onto a custom editor. Intercepting Ctrl+V or Shift+Enter in `FocusEditor` broke paste and transcript search. Right-click paste is implemented in `TuiAltScreen` only on Windows; Linux needs the existing handler wrap.

### Modified Enter keys depend on terminal reporting

Ghostty reports Shift+Enter distinctly. KGX/VTE emits Shift+Enter as plain Enter; Ctrl+J is the newline fallback. Ctrl+Shift+M must remain unbound because Ctrl+M can alias Enter in legacy input.

## Current acceptance targets

- no rendered line wider than the terminal, including 343 columns
- median long-session input response below 25 ms
- Pi owns transcript keyboard scrolling; the dashboard does not steal those bindings
- `/resume`, `/new`, and `/reload` do not use stale contexts or nested layout roots
- unnamed resumed sessions show their first prompt
- Ctrl+V paste matches plain Pi
- terminal modes and temporary input patches are restored on shutdown

## Next steps

1. Revalidate native `layoutRoot` + primary `ScrollView` discovery after each Pi upgrade.
2. Keep documentation focused on current behavior rather than chronological implementation notes.
3. Add a dedicated `session_before_compact` / `session_tree` / fork lifecycle test to the PTY regression.
