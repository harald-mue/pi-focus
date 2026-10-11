# Release notes

Pi Focus currently targets Pi 1.1.0.

## Current baseline

- Dashboard wrapped around Pi's native fullscreen chat viewport (no seven-container rebuild).
- Session-safe `/resume`, `/new`, and reload lifecycle; native layout restored on shutdown.
- Explicit session names or first-message titles in the dashboard.
- Ctrl+V uses Pi clipboard paste (text, files, images). Linux right-click paste wraps Pi's Windows-only handler.
- Pi transcript keys kept: PageUp/PageDown, Ctrl+Home/End, Ctrl+Shift+↑/↓ prompt jump.
- Provider quota, Git state, request activity (`durationMs`, aborted runs), token commands, and bulk session deletion.
- Cursor quota prefers Pi OAuth / `CURSOR_ACCESS_TOKEN` and `GetCurrentPeriodUsage` (Included/Auto/API). Desktop DB and Team Admin spend are fallbacks.
- Width-safe rendering and long-session input latency below the 25 ms target in the recorded benchmark.

Detailed implementation history is intentionally not maintained here. Current behavior, design constraints, and verification steps live in `CURRENT_STATE.md`, `ARCHITECTURE.md`, and `TESTING.md`.
