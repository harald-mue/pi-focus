# Architecture

## Fullscreen layout

Pi Focus builds on Pi's native fullscreen renderer. The layout root is an `HStack` with a flexible workspace and an optional fixed-width dashboard:

```text
┌──────────────────────── left workspace ────────────────────────┬─ dashboard ─┐
│ optional auto-hiding header                                    │             │
│ ┌──────────────── transcript ScrollView ─────────────────────┐ │ session     │
│ │ loaded resources and conversation                         │ │ provider    │
│ │                                                          │ │ repository  │
│ └────────────────────────────────────────────────────────────┘ │ activity    │
│ pending/status/widgets/editor/footer dock                      │             │
└────────────────────────────────────────────────────────────────┴─────────────┘
```

The workspace is a `VStack` containing the header, a growing transcript `ScrollView`, and an intrinsic-height bottom dock. A wrapped editor or autocomplete menu grows upward and reduces only the transcript height.

The dashboard is 48 columns wide with a two-column gap. It is visible only at 110×28 or larger and can be toggled with F2, Alt+M, Ctrl+Shift+M, or `/focus`.

## Scrolling and selection

The transcript is the primary `ScrollView`, follows the latest output by default, and uses contained overscroll. Ctrl+Shift+↑/↓ calls `scrollBy()` directly in three-row steps while editor focus remains unchanged. Mouse-wheel routing is intentionally unavailable while native terminal context-menu mode disables mouse reporting.

Pi's fullscreen renderer owns alternate-screen lifecycle and terminal cleanup. Pi Focus disables its mouse-reporting modes after startup so the terminal can own right-click context menus; it does not patch `tui.render` or enter a second alternate screen.

## Input and clipboard

`FocusEditor` extends Pi's `CustomEditor`, preserving app-level actions and autocomplete while applying Pi Focus styling. Normal terminal bracketed paste and Pi's Ctrl+V clipboard action continue through `CustomEditor`.

Pi Focus does not intercept or emulate right-click paste. Fullscreen mouse reporting would still prevent VTE/KGX from seeing the click, so Pi Focus explicitly disables terminal mouse-reporting modes after fullscreen startup. This restores the native terminal context menu at the cost of fullscreen mouse-wheel scrolling and application-owned drag selection.

## Session lifecycle

Pi invalidates an extension context before replacing a session. The previous layout may render once during that transition, so fixed chrome must not access a captured context or session manager. The footer and `ControlCenter` render only from plain snapshots captured by active lifecycle handlers, plus TUI-owned footer data.

The dashboard title is resolved as follows:

1. explicit session name from `/name`
2. first user message on the active branch
3. `new session`

Each replacement `session_start` installs fresh chrome for the new runtime. Shutdown restores temporary input wrapping and extension styling before the old runtime becomes stale.

## Dashboard data

The dashboard shows:

- session title, project, and current phase
- provider/model plus supported quota and rate-limit information
- Git branch, tracking, latest commit, stash, and working-tree state
- current request, active tools, and recent tool durations

Provider quota refreshes are generation-guarded so late responses from an old provider or session cannot overwrite current state.

## Compatibility boundary

The extension currently targets Pi 0.84.1. It requires a viewport-capable fullscreen TUI and Pi's seven expected root containers. If either condition is missing, Pi Focus reports a warning and does not attach the custom fixed layout.
