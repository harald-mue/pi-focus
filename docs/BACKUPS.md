# Backups and restore

## Backup locations

The installer creates timestamped snapshots under:

```text
~/.pi/agent/customization-backups/pi-focus-YYYYMMDD-HHMMSS/
```

Manual baselines, when needed, belong under:

```text
~/pi-backup/pi-focus-YYYYMMDD-HHMMSS/
```

Do not place backups inside `~/pi-focus`; it is the active source tree.

## Installer snapshots

Before replacement, `scripts/install.sh` backs up installed extension, theme, skill, and relevant settings files. Snapshot contents vary because only paths that already exist are copied.

A typical snapshot contains:

```text
extensions/pi-focus/
themes/pi-focus.json
skills/last-request-tokens/
settings.json
```

## Manual baseline

For a portable manual baseline, include:

```text
extensions/pi-focus/
settings.json
SHA256SUMS
```

Create it with `cp -a`, generate checksums, and verify immediately. Do not include credentials or unrelated `~/.pi/agent` data.

Example verification:

```bash
cd ~/pi-backup/pi-focus-YYYYMMDD-HHMMSS
sha256sum -c SHA256SUMS
```

Installer snapshots may not contain `SHA256SUMS`; inspect them with `find` and compare paths with `diff -qr`.

## Restore procedure

1. Exit Pi completely.
2. Inspect the selected snapshot and confirm its expected files.
3. To restore development source, copy `extensions/pi-focus/` into `~/pi-focus/extensions/pi-focus/` with `cp -a`.
4. To restore only the installed version, copy the snapshot paths into `~/.pi/agent/`.
5. When the repository is authoritative, prefer running `./scripts/install.sh` instead of direct deployment copies.
6. Restart Pi and execute the relevant checks in `docs/TESTING.md`.

Restore settings selectively. Do not overwrite authentication, packages, trust decisions, or unrelated extensions.

## Historical snapshots

Older snapshots may contain retired standalone extensions, an overlay dashboard, or direct `tui.render` interception. Treat them as recovery material, not as current architecture. Do not restore `model-shortcuts.ts`, standalone token/session helpers, or obsolete settings unless explicitly requested.
