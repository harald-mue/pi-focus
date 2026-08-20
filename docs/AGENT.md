# Pi Focus maintainer instructions

## Source of truth

The repository is the source of truth:

- extension: `extensions/pi-focus/`
- theme: `extensions/pi-focus/theme/pi-focus.json`
- skill: `extensions/pi-focus/skills/last-request-tokens/`
- installer: `scripts/install.sh`
- documentation: `README.md` and `docs/`

Installed copies under `~/.pi/agent/` are deployment targets, not development sources. Use `./scripts/install.sh` to synchronize them. Do not change Ghostty or desktop keybindings to work around extension defects unless explicitly requested.

## Required behavior

- Use Pi's native fullscreen layout; do not replace `tui.render`.
- Only the transcript `ScrollView` scrolls.
- Keep the header, dashboard, input area, widgets, and footer fixed.
- Auto-hide the header after ten seconds.
- Keep Ctrl+Shift+↑/↓ transcript scrolling; native context-menu mode intentionally disables mouse-wheel reporting.
- Keep F2, Alt+M, Ctrl+Shift+M, and `/focus` synchronized with UI help and documentation.
- Do not intercept right-click paste; disable fullscreen mouse reporting and leave right-button handling to the terminal.
- Document that native context-menu mode disables application-owned wheel scrolling and drag selection.
- Preserve width safety, the completed-tool accent, and normal-weight tool surfaces.
- Never dereference a captured `ExtensionContext` during rendering after session replacement or reload.
- For unnamed sessions, use the first user message as the dashboard title.

## Compatibility

Pi Focus currently targets Pi 0.84.1 and requires `tuiMode=fullscreen`. Layout attachment expects Pi's seven root components in this order: document, pending messages, status, above-editor widgets, editor, below-editor widgets, footer. If this contract changes, show a compatibility warning rather than attaching an overlapping or partial layout.

Pi invalidates extension contexts during `/resume`, `/new`, forks, and `/reload`. Components that may render during teardown must use only safe plain snapshots; captured contexts and session-manager references can be stale. New-session work must use the replacement context supplied by Pi.

Pi Focus intentionally does not wrap right-click paste handling. A previous Linux clipboard-emulation wrapper was unreliable and could suppress paste. Because Pi fullscreen otherwise enables global mouse reporting, Pi Focus disables those reporting modes after startup so VTE/KGX receives the click and opens its native context menu.

## Performance

Do not width-process the complete transcript on every keystroke. Measure and clip only visible rows and fixed chrome. The long-session acceptance target is a median input response below 25 ms.

## Workflow

1. Read all affected source and documentation.
2. Make changes in the repository.
3. Run `./scripts/pty-regression.py`, the extension-load test, and relevant checks from `docs/TESTING.md`.
4. Run `./scripts/install.sh` only when the installed copy should be updated.
5. Restart Pi for layout or lifecycle changes.
6. Confirm the installed extension matches the repository when claiming deployment is complete.

Do not commit or push unless explicitly requested. Never add co-author trailers.
