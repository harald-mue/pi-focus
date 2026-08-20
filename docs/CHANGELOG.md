# Release notes

Pi Focus currently targets Pi 0.84.1.

## Current baseline

- Native fullscreen transcript layout with fixed input/footer and responsive dashboard.
- Session-safe `/resume`, `/new`, and reload lifecycle.
- Explicit session names or first-message titles in the dashboard.
- Fullscreen mouse reporting is disabled so native terminal right-click context-menu paste remains reliable.
- Transcript-only Ctrl+Shift+↑/↓ scrolling; mouse-wheel reporting remains disabled for native context menus.
- Provider quota, Git state, request activity, token commands, and bulk session deletion.
- Width-safe rendering and long-session input latency below the 25 ms target in the recorded benchmark.

Detailed implementation history is intentionally not maintained here. Current behavior, design constraints, and verification steps live in `CURRENT_STATE.md`, `ARCHITECTURE.md`, and `TESTING.md`.
