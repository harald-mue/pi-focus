# Design findings and next steps

## Findings that shape the implementation

### Native fullscreen layout is the stable path

The former custom viewport intercepted `tui.render`, managed alternate-screen modes, and maintained its own selection coordinates. That approach was sensitive to frame geometry and Pi renderer changes. Pi's native fullscreen `ScrollView` now owns viewport sizing and terminal lifecycle. Pi Focus disables mouse reporting afterward to preserve the terminal's native context menu.

### Full-history processing hurts editor latency

The original viewport applied ANSI-aware width truncation to every history row on every keystroke. On the recorded long session this produced a 195.5 ms median response. Restricting expensive clipping to visible output reduced the median to 18.4 ms and P95 to 21.8 ms. Future rendering changes must preserve that property.

### Session replacement invalidates contexts before all rendering stops

Pi 0.84 can render the outgoing layout once after invalidating its extension context. Any component that dereferences a captured `ctx` during `render()` can crash `/resume`. Render components must receive stable values and callbacks that do not touch stale contexts.

### Unnamed sessions still need useful identity

`SessionManager.getSessionName()` returns `undefined` unless `/name` was used. Pi's selector identifies such sessions by their first user message, so the dashboard follows the same fallback.

### Right-click paste should stay native

A previous Linux-only viewport wrapper emulated clipboard paste from right-click mouse events. In practice this was less reliable than the terminal context menu and could suppress paste entirely. Merely removing the wrapper is insufficient because fullscreen mouse reporting still prevents VTE/KGX from receiving right-click. Pi Focus therefore disables mouse reporting after fullscreen startup and does not intercept right-click paste.

## Current acceptance targets

- no rendered line wider than the terminal, including 343 columns
- median long-session input response below 25 ms
- transcript keyboard scrolling affects only the transcript layout region
- `/resume`, `/new`, and `/reload` do not use stale contexts
- unnamed resumed sessions show their first prompt
- right-click paste behavior matches plain Pi/the terminal
- terminal modes and temporary input patches are restored on shutdown

## Next steps

1. Add an automated PTY regression for session replacement and dashboard title fallback.
2. Add a manual/PTY regression that verifies right-click is not consumed by Pi Focus.
3. Revalidate the seven-root-container assumption after each Pi upgrade.
4. ~~Remove the retained legacy `FixedViewport` implementation once no rollback path depends on it.~~ **Done** — class and all references removed.
5. Keep documentation focused on current behavior rather than chronological implementation notes.
