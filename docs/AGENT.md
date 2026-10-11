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

- Wrap Pi's native fullscreen layout root; do not rebuild the seven-container tree or replace `tui.render`.
- Restore the native layout root on session shutdown.
- Keep the dashboard, input area, widgets, and footer as Pi dock siblings plus the dashboard column.
- Auto-hide the custom header after ten seconds.
- Do not unbind Pi transcript actions (`PageUp`/`PageDown`, `Ctrl+Home`/`Ctrl+End`, prompt jump, search).
- Keep Alt+M, `/focus`, and `/wheel-scroll` synchronized with UI help and documentation. Do not bind Ctrl+Shift+M because Ctrl+M can be encoded as Enter.
- Leave Shift+Enter and Ctrl+J to Pi (`tui.input.newLine`). Leave Ctrl+V to Pi (`app.clipboard.pasteImage`).
- Keep fullscreen mouse reporting enabled. Wrap Pi's right-click-paste handler on Linux.
- Never dereference a captured `ExtensionContext` during rendering after session replacement or reload.
- For unnamed sessions, use the first user message as the dashboard title.

## Compatibility

Pi Focus currently targets Pi 1.1.0 and requires fullscreen TUI. Layout attachment finds the primary transcript `ScrollView` on Pi's `layoutRoot` and places the dashboard beside it. If this contract changes, show a compatibility warning rather than attaching an overlapping or partial layout.

Pi invalidates extension contexts during `/resume`, `/new`, forks, and `/reload`. Components that may render during teardown must use only safe plain snapshots.

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
