/**
 * Bulk-delete pi sessions with multi-select checkboxes and confirmation.
 *
 * Command: /delete-sessions
 * Keys: Space toggle · a select all · Enter confirm · Tab scope · Esc cancel
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

type Scope = "current" | "all";
type Mode = "list" | "confirm";

interface BulkDeleteResult {
	deleted: number;
	failed: number;
}

function shortenPath(path: string): string {
	const home = os.homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function formatSessionDate(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string): string {
	try {
		return path.replace(/\/+/g, "/");
	} catch {
		return path;
	}
}

function padToWidth(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "…");
	const padding = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(padding);
}

function borderRow(theme: Theme, content: string, totalWidth: number, selected = false): string {
	const innerW = totalWidth - 2;
	let inner = padToWidth(content, innerW);
	if (selected) inner = theme.bg("selectedBg", inner);
	return theme.fg("accent", "│") + inner + theme.fg("accent", "│");
}

function borderTop(theme: Theme, totalWidth: number): string {
	return theme.fg("accent", `╭${"─".repeat(totalWidth - 2)}╮`);
}

function borderDivider(theme: Theme, totalWidth: number): string {
	return theme.fg("accent", `│${"─".repeat(totalWidth - 2)}│`);
}

function borderBottom(theme: Theme, totalWidth: number): string {
	return theme.fg("accent", `╰${"─".repeat(totalWidth - 2)}╯`);
}

async function deleteSessionFile(sessionPath: string): Promise<{ ok: boolean; method?: "trash" | "unlink"; error?: string }> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const stderr = trashResult.stderr?.trim();
		const trashHint = stderr ? `trash: ${stderr.split("\n")[0]}` : trashResult.error?.message;
		return { ok: false, error: trashHint ? `${unlinkError} (${trashHint})` : unlinkError };
	}
}

class BulkDeleteSessionsComponent {
	private mode: Mode = "list";
	private scope: Scope = "current";
	private sessions: SessionInfo[] = [];
	private filteredSessions: SessionInfo[] = [];
	private selectedPaths = new Set<string>();
	private selectedIndex = 0;
	private loading = true;
	private loadProgress: { loaded: number; total: number } | null = null;
	private statusMessage: string | null = null;
	private deleting = false;
	private readonly maxVisible = 12;
	private readonly currentSessionPath: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly done: (result: BulkDeleteResult | null) => void,
	) {
		this.currentSessionPath = ctx.sessionManager.getSessionFile?.();
		void this.loadSessions();
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private isCurrentSession(path: string): boolean {
		if (!this.currentSessionPath) return false;
		return canonicalizePath(path) === canonicalizePath(this.currentSessionPath);
	}

	private async loadSessions(): Promise<void> {
		this.loading = true;
		this.loadProgress = null;
		this.statusMessage = null;
		this.refresh();
		const onProgress = (loaded: number, total: number) => {
			this.loadProgress = { loaded, total };
			this.refresh();
		};
		try {
			this.sessions =
				this.scope === "current"
					? await SessionManager.list(this.ctx.cwd, undefined, onProgress)
					: await SessionManager.listAll(onProgress);
			this.sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			this.filteredSessions = [...this.sessions];
			this.selectedIndex = this.filteredSessions.length === 0
				? 0
				: Math.max(0, Math.min(this.selectedIndex, this.filteredSessions.length - 1));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.statusMessage = `Failed to load sessions: ${message}`;
			this.sessions = [];
			this.filteredSessions = [];
		} finally {
			this.loading = false;
			this.refresh();
		}
	}

	private toggleScope(): void {
		if (this.loading || this.deleting) return;
		this.scope = this.scope === "current" ? "all" : "current";
		this.selectedIndex = 0;
		void this.loadSessions();
	}

	private toggleSelected(path: string): void {
		if (this.isCurrentSession(path)) {
			this.statusMessage = "Cannot delete the active session";
			this.refresh();
			return;
		}
		if (this.selectedPaths.has(path)) {
			this.selectedPaths.delete(path);
		} else {
			this.selectedPaths.add(path);
		}
		this.statusMessage = null;
		this.refresh();
	}

	private selectAll(): void {
		for (const session of this.filteredSessions) {
			if (!this.isCurrentSession(session.path)) {
				this.selectedPaths.add(session.path);
			}
		}
		this.statusMessage = null;
		this.refresh();
	}

	private clearSelection(): void {
		this.selectedPaths.clear();
		this.statusMessage = null;
		this.refresh();
	}

	private enterConfirm(): void {
		if (this.selectedPaths.size === 0) {
			this.statusMessage = "No sessions selected";
			this.refresh();
			return;
		}
		this.mode = "confirm";
		this.statusMessage = null;
		this.refresh();
	}

	private async executeDelete(): Promise<void> {
		const paths = [...this.selectedPaths];
		if (paths.length === 0) {
			this.done(null);
			return;
		}
		this.deleting = true;
		let deleted = 0;
		let failed = 0;
		for (const path of paths) {
			const result = await deleteSessionFile(path);
			if (result.ok) {
				deleted++;
				this.selectedPaths.delete(path);
			} else {
				failed++;
			}
		}
		this.deleting = false;
		this.done({ deleted, failed });
	}

	handleInput(data: string): void {
		if (this.deleting) return;

		if (this.mode === "confirm") {
			if (matchesKey(data, Key.escape)) {
				this.mode = "list";
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
				void this.executeDelete();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.toggleScope();
			return;
		}
		if (data === "a" || data === "A") {
			this.selectAll();
			return;
		}
		if (data === "c" || data === "C") {
			this.clearSelection();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.enterConfirm();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.filteredSessions.length > 0) {
				this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
			}
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.space)) {
			const session = this.filteredSessions[this.selectedIndex];
			if (session) this.toggleSelected(session.path);
		}
	}

	private renderHeader(width: number): string[] {
		const theme = this.theme;
		const title =
			this.mode === "confirm"
				? theme.bold("Delete Sessions – Confirm")
				: theme.bold("Delete Sessions – Multi-select");
		const scopeLabel =
			this.scope === "current"
				? theme.fg("accent", "◉ Current folder")
				: theme.fg("accent", "◉ All");
		const otherScope = theme.fg("muted", this.scope === "current" ? "○ All" : "○ Current folder");
		const right = this.loading
			? theme.fg("muted", this.loadProgress ? `Loading ${this.loadProgress.loaded}/${this.loadProgress.total}` : "Loading…")
			: `${otherScope} | ${scopeLabel}`;
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		const lines = [`${title}${" ".repeat(spacing)}${right}`];

		if (this.mode === "confirm") {
			lines.push(
				theme.fg(
					"error",
					truncateToWidth(
						`Delete ${this.selectedPaths.size} session(s)? Enter/Y confirm · Esc cancel`,
						width,
						"…",
					),
				),
			);
			return lines;
		}

		const hint = theme.fg(
			"muted",
			truncateToWidth(
				`↑↓ navigate · Space toggle · a select all · c clear · Enter delete · Tab scope · Esc cancel`,
				width,
				"…",
			),
		);
		lines.push(hint);
		if (this.selectedPaths.size > 0) {
			lines.push(theme.fg("accent", truncateToWidth(`${this.selectedPaths.size} selected`, width, "…")));
		}
		if (this.statusMessage) {
			lines.push(theme.fg("warning", truncateToWidth(this.statusMessage, width, "…")));
		}
		return lines;
	}

	private renderSessionLine(session: SessionInfo, innerWidth: number, isFocused: boolean): string {
		const theme = this.theme;
		const checked = this.selectedPaths.has(session.path);
		const isCurrent = this.isCurrentSession(session.path);
		const checkbox = isCurrent
			? theme.fg("dim", "[—]")
			: checked
				? theme.fg("accent", "[✓]")
				: theme.fg("muted", "[ ]");
		const displayText = (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f]/g, " ").trim();
		const age = formatSessionDate(session.modified);
		const cwdHint =
			this.scope === "all" && session.cwd ? `${shortenPath(session.cwd)} ` : "";
		const rightPart = theme.fg("dim", `${cwdHint}${session.messageCount} · ${age}`);
		const cursor = isFocused ? theme.fg("accent", "› ") : "  ";
		const left = `${cursor}${checkbox} `;
		const rightWidth = visibleWidth(rightPart);
		const available = innerWidth - visibleWidth(left) - rightWidth - 1;
		let label = truncateToWidth(displayText, Math.max(8, available), "…");
		if (isCurrent) label = theme.fg("accent", label);
		else if (session.name) label = theme.fg("warning", label);
		if (isFocused) label = theme.bold(label);
		const leftPart = left + label;
		const spacing = Math.max(1, innerWidth - visibleWidth(leftPart) - rightWidth);
		return leftPart + " ".repeat(spacing) + rightPart;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const renderWidth = Math.max(1, width);
		const boxWidth = Math.max(4, Math.min(renderWidth, 100));
		const innerWidth = boxWidth - 2;
		const lines: string[] = [];

		lines.push("");
		lines.push(borderTop(theme, boxWidth));
		for (const headerLine of this.renderHeader(innerWidth)) {
			lines.push(borderRow(theme, headerLine, boxWidth));
		}
		lines.push(borderDivider(theme, boxWidth));

		if (this.loading) {
			lines.push(borderRow(theme, theme.fg("muted", "  Loading sessions…"), boxWidth));
		} else if (this.mode === "confirm") {
			for (const path of [...this.selectedPaths].slice(0, this.maxVisible)) {
				const session = this.sessions.find((s) => s.path === path);
				const label = session ? (session.name ?? session.firstMessage).slice(0, 60) : shortenPath(path);
				lines.push(borderRow(theme, theme.fg("error", `  × ${label}`), boxWidth));
			}
			if (this.selectedPaths.size > this.maxVisible) {
				lines.push(
					borderRow(
						theme,
						theme.fg("dim", `  … and ${this.selectedPaths.size - this.maxVisible} more`),
						boxWidth,
					),
				);
			}
		} else if (this.filteredSessions.length === 0) {
			lines.push(borderRow(theme, theme.fg("muted", "  No sessions found"), boxWidth));
		} else {
			const start = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(this.maxVisible / 2),
					this.filteredSessions.length - this.maxVisible,
				),
			);
			const end = Math.min(start + this.maxVisible, this.filteredSessions.length);
			for (let i = start; i < end; i++) {
				const line = this.renderSessionLine(this.filteredSessions[i]!, innerWidth, i === this.selectedIndex);
				lines.push(borderRow(theme, line, boxWidth, i === this.selectedIndex));
			}
			if (this.filteredSessions.length > this.maxVisible) {
				lines.push(
					borderRow(theme, theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`), boxWidth),
				);
			}
		}

		lines.push(borderBottom(theme, boxWidth));
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}

	invalidate(): void {}
}

export function registerSessionBulkDelete(pi: ExtensionAPI) {
	pi.registerCommand("delete-sessions", {
		description: "List, select, and bulk-delete old sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Only available in interactive TUI mode", "error");
				return;
			}

			const result = await ctx.ui.custom<BulkDeleteResult | null>(
				(tui, theme, _keybindings, done) => new BulkDeleteSessionsComponent(tui, theme, ctx, done),
				{ overlay: true },
			);

			if (!result) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (result.deleted > 0 && result.failed === 0) {
				ctx.ui.notify(`Deleted ${result.deleted} session(s)`, "info");
			} else if (result.deleted > 0) {
				ctx.ui.notify(`Deleted ${result.deleted}, ${result.failed} failed`, "warning");
			} else {
				ctx.ui.notify(`Delete failed (${result.failed})`, "error");
			}
		},
	});
}
