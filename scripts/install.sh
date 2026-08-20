#!/usr/bin/env bash
set -euo pipefail

readonly GREEN=$'\033[32m'
readonly RED=$'\033[31m'
readonly YELLOW=$'\033[33m'
readonly CYAN=$'\033[36m'
readonly DIM=$'\033[2m'
readonly RESET=$'\033[0m'

usage() {
	printf 'Usage: %s [--enable-pi-focus-theme] [--dry-run]\n' "${0##*/}"
}

enable_theme=false
dry_run=false
for arg in "$@"; do
	case "$arg" in
		--enable-pi-focus-theme) enable_theme=true ;;
		--dry-run) dry_run=true ;;
		-h|--help) usage; exit 0 ;;
		*) printf '%s✘ Unknown option: %s%s\n' "$RED" "$arg" "$RESET" >&2; usage >&2; exit 2 ;;
	esac
done

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
target="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
timestamp=$(date +%Y%m%d-%H%M%S)
backup="$target/customization-backups/pi-focus-$timestamp"

copy_item() {
	local source=$1 destination=$2 backup_rel=$3
	if [[ -e "$destination" || -L "$destination" ]]; then
		if [[ "$dry_run" == true ]]; then
			printf '  %s➜ would back up%s %s\n' "$YELLOW" "$RESET" "$destination"
		else
			mkdir -p "$(dirname -- "$backup/$backup_rel")"
			cp -a -- "$destination" "$backup/$backup_rel"
			printf '  %s✔ backed up%s %s\n' "$GREEN" "$RESET" "$destination"
		fi
	fi
	if [[ "$dry_run" == true ]]; then
		printf '  %s➜ would install%s %s\n' "$YELLOW" "$RESET" "$destination"
	else
		mkdir -p "$(dirname -- "$destination")"
		rm -rf -- "$destination"
		cp -a -- "$source" "$destination"
		printf '  %s✔ installed%s %s\n' "$GREEN" "$RESET" "$destination"
	fi
}

printf '%s╭─ 📦 Pi Focus installer ───────────────────────────╮%s\n' "$CYAN" "$RESET"
printf '│ %sSource:%s %-45s │\n' "$DIM" "$RESET" "$project_dir"
printf '│ %sTarget:%s %-45s │\n' "$DIM" "$RESET" "$target"
printf '│ %sMode:%s   %-45s │\n' "$DIM" "$RESET" "$([[ "$dry_run" == true ]] && printf 'dry run' || printf 'install')"
printf '╰────────────────────────────────────────────────────╯\n'

copy_item "$project_dir/extensions/pi-focus" "$target/extensions/pi-focus" "extensions/pi-focus"

# Remove legacy standalone extensions superseded by pi-focus.
for legacy in session-bulk-delete token-usage.ts; do
	legacy_path="$target/extensions/$legacy"
	if [[ -e "$legacy_path" || -L "$legacy_path" ]]; then
		if [[ "$dry_run" == true ]]; then
			printf '  %s➜ would remove%s %s\n' "$YELLOW" "$RESET" "$legacy_path"
		else
			mkdir -p "$(dirname -- "$backup/extensions")"
			cp -a -- "$legacy_path" "$backup/extensions/$legacy"
			rm -rf -- "$legacy_path"
			printf '  %s✔ removed%s %s\n' "$GREEN" "$RESET" "$legacy_path"
		fi
	fi
done
copy_item "$project_dir/extensions/pi-focus/theme/pi-focus.json" "$target/themes/pi-focus.json" "themes/pi-focus.json"
copy_item "$project_dir/extensions/pi-focus/skills/last-request-tokens" "$target/skills/last-request-tokens" "skills/last-request-tokens"

settings="$target/settings.json"
if [[ "$dry_run" == true ]]; then
	printf '  %s➜ would set%s tuiMode=fullscreen in %s\n' "$YELLOW" "$RESET" "$settings"
	if [[ "$enable_theme" == true ]]; then
		printf '  %s➜ would set%s theme=pi-focus in %s\n' "$YELLOW" "$RESET" "$settings"
	fi
else
	if [[ -e "$settings" ]]; then
		mkdir -p "$(dirname -- "$backup/settings.json")"
		cp -a -- "$settings" "$backup/settings.json"
	fi
	python3 - "$settings" "$enable_theme" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
data["tuiMode"] = "fullscreen"
if sys.argv[2] == "true":
    data["theme"] = "pi-focus"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
PY
	printf '  %s✔ enabled%s fullscreen TUI mode\n' "$GREEN" "$RESET"
	if [[ "$enable_theme" == true ]]; then
		printf '  %s✔ enabled%s pi-focus theme\n' "$GREEN" "$RESET"
	fi
fi

printf '───\n'
if [[ "$dry_run" == true ]]; then
	printf '%s⚠️  Dry run complete; no files were changed.%s\n' "$YELLOW" "$RESET"
else
	printf '%s🎉 Installation complete.%s Run %s/reload%s in Pi, or restart Pi.\n' "$GREEN" "$RESET" "$CYAN" "$RESET"
	printf '%sBackups:%s %s\n' "$DIM" "$RESET" "$backup"
fi
