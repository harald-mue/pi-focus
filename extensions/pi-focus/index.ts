import { existsSync, readFileSync, statfsSync } from "node:fs";
import { freemem, networkInterfaces, platform, release, totalmem } from "node:os";
import { basename } from "node:path";
import {
	CustomEditor,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	CURSOR_MARKER,
	HStack,
	isViewportTUI,
	Key,
	matchesKey,
	ScrollView,
	truncateToWidth,
	visibleWidth,
	VStack,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	fetchCopilotQuota,
	fetchOpenAICodexQuota,
	rateLimitMetrics,
	titleCase,
	type ProviderMetric,
} from "./provider-usage.ts";
import { registerSessionBulkDelete } from "./session-bulk-delete.ts";
import { registerTokenUsage } from "./token-usage.ts";

const UI_STATUS_ID = "pi-focus";
const CONTROL_WIDTH = 48;
const DASHBOARD_GAP = 2;
const DASHBOARD_MIN_WIDTH = 110;
const DASHBOARD_MIN_HEIGHT = 28;
const EDITOR_MARGIN_X = 1;
const EDITOR_MARGIN_TOP = 1;
const EDITOR_PADDING_BOTTOM = 1;
const EDITOR_PADDING_X = 2;
const EDITOR_PADDING_TOP = 1;
const FIELD_LABEL_WIDTH = 11;
const STATUS_PADDING_TOP = 1;
const SIDEBAR_PADDING_X = 2;
const PROVIDER_USAGE_TTL_MS = 5 * 60 * 1000;
const HISTORY_WHEEL_STEP = 3;
const HEADER_AUTO_HIDE_MS = 10_000;
const RESET_TERMINAL_MODES = [
	"\x1b[?1000l", // Mouse clicks
	"\x1b[?1002l", // Mouse button motion
	"\x1b[?1003l", // All mouse motion
	"\x1b[?1004l", // Focus reporting
	"\x1b[?1006l", // SGR mouse protocol
	"\x1b[?1015l", // urxvt mouse protocol
	"\x1b[?2004l", // Bracketed paste
	"\x1b[<u",     // Pop Kitty keyboard protocol
	"\x1b[>4;0m",  // Disable modifyOtherKeys
	"\x1b[?1l",    // Normal cursor keys
	"\x1b>",       // Normal keypad
	"\x1b[?1049l", // Leave alternate screen
	"\x1b[0m",     // Reset character attributes
	"\x1b[?25h",   // Show cursor
].join("");
/** Keep in sync with pi-focus.json `neutral` / `export.pageBg` */
const CANVAS_BG_HEX = "#0a0a0a";
const TERMINAL_BG_RESTORE_HEX = "#282c34";

function canvasBgAnsi(): string {
	const r = Number.parseInt(CANVAS_BG_HEX.slice(1, 3), 16);
	const g = Number.parseInt(CANVAS_BG_HEX.slice(3, 5), 16);
	const b = Number.parseInt(CANVAS_BG_HEX.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function fillCanvas(width: number): string {
	const safeWidth = Math.max(0, width);
	return `${canvasBgAnsi()}${" ".repeat(safeWidth)}\x1b[49m`;
}

function applyTerminalBackground(hex: string): void {
	try {
		process.stdout.write(`\x1b]11;${hex}\x07`);
	} catch {
		// The terminal may already be unavailable during signal-driven exits.
	}
}

function resetTerminalModes(): void {
	try {
		process.stdout.write(RESET_TERMINAL_MODES);
	} catch {
		// The terminal may already be unavailable during signal-driven exits.
	}
	try {
		if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
	} catch {
		// Raw mode may already have been restored by Pi's ProcessTerminal.
	}
}

const THEME_GLOBAL_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function activeTheme(): Theme | undefined {
	return (globalThis as Record<symbol, Theme | undefined>)[THEME_GLOBAL_KEY];
}

const TOOL_SUCCESS_BG_PATCH_KEY = Symbol.for("pi-focus:tool-success-bg-patch");

/** Left accent bar on completed tool blocks — mirrors the input box blue stripe. */
function patchToolSuccessStripe(): void {
	const theme = activeTheme();
	if (!theme) return;

	const themeState = theme as Theme & Record<symbol, unknown>;
	const installedPatch = themeState[TOOL_SUCCESS_BG_PATCH_KEY];
	if (typeof installedPatch === "function" && theme.bg === installedPatch) return;

	// Always start from Theme.prototype.bg. This also replaces the legacy Pi
	// Focus patch after /reload instead of wrapping it and accumulating width.
	const originalBg = Theme.prototype.bg.bind(theme);
	const patchedBg = ((color, text) => {
		const isToolSurface = color === "toolPendingBg" || color === "toolSuccessBg" || color === "toolErrorBg";
		// Pi's built-in tool renderers bold command/title text. Keep Pi Focus tool
		// blocks at normal weight without affecting Markdown or other UI labels.
		const surfaceText = isToolSurface ? text.replace(/\x1b\[1m/g, "\x1b[22m") : text;
		const rendered = originalBg(color, surfaceText);
		if (color !== "toolSuccessBg") return rendered;

		const renderedWidth = visibleWidth(rendered);
		if (renderedWidth === 0) return rendered;

		// Match the input box: one canvas column, then the accent stripe, then
		// the block surface. Clip only right-side padding so the allocated width
		// remains unchanged.
		const marginWidth = Math.min(EDITOR_MARGIN_X, Math.max(0, renderedWidth - 1));
		const bodyWidth = Math.max(0, renderedWidth - marginWidth - 1);
		const stripe = theme.fg("warning", "│");
		return fillCanvas(marginWidth) + stripe + truncateToWidth(rendered, bodyWidth, "");
	}) as Theme["bg"];
	theme.bg = patchedBg;
	themeState[TOOL_SUCCESS_BG_PATCH_KEY] = patchedBg;
}

/** Pi binds Ctrl+Shift+↑/↓ to prompt jump; reclaim them for transcript scrolling. */
function configureTranscriptScrollKeybindings(keybindings: KeybindingsManager): void {
	keybindings.setUserBindings({
		...keybindings.getUserBindings(),
		"tui.altScreen.previousPrompt": [],
		"tui.altScreen.nextPrompt": [],
	});
}

function scrollTranscriptByKeyboard(
	data: string,
	transcriptScrollView: ScrollView | undefined,
	step = HISTORY_WHEEL_STEP,
): boolean {
	if (!transcriptScrollView) return false;
	if (matchesKey(data, Key.ctrlShift("up"))) {
		transcriptScrollView.scrollBy(-step);
		return true;
	}
	if (matchesKey(data, Key.ctrlShift("down"))) {
		transcriptScrollView.scrollBy(step);
		return true;
	}
	return false;
}

function scrollTranscriptByWheelFallback(
	data: string,
	transcriptScrollView: ScrollView | undefined,
	step = HISTORY_WHEEL_STEP,
): boolean {
	if (!transcriptScrollView) return false;
	if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
		transcriptScrollView.scrollBy(-step);
		return true;
	}
	if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
		transcriptScrollView.scrollBy(step);
		return true;
	}
	return false;
}

function isWheelFallbackScrollKey(data: string): boolean {
	return matchesKey(data, Key.up)
		|| matchesKey(data, Key.down)
		|| matchesKey(data, Key.pageUp)
		|| matchesKey(data, Key.pageDown);
}

interface SgrMouseEvent {
	button: number;
	release: boolean;
}

interface AltScreenTuiWithPaste {
	onRightClickPaste?: () => void;
	handleRightClickPaste(event: SgrMouseEvent): boolean;
}

/** Pi's alt-screen TUI only wires right-click paste on Windows; enable it on Linux too. */
function enableLinuxRightClickPaste(tui: TUI): void {
	if (process.platform !== "linux") return;
	const alt = tui as unknown as AltScreenTuiWithPaste;
	if (!alt.onRightClickPaste) return;
	const original = alt.handleRightClickPaste.bind(alt);
	alt.handleRightClickPaste = (event) => {
		if (!event.release && event.button === 2) {
			alt.onRightClickPaste?.();
			return true;
		}
		return original(event);
	};
}

function restoreToolSuccessStripe(): void {
	const theme = activeTheme();
	if (!theme) return;

	const themeState = theme as Theme & Record<symbol, unknown>;
	const installedPatch = themeState[TOOL_SUCCESS_BG_PATCH_KEY];
	if (typeof installedPatch === "function" && theme.bg === installedPatch) {
		theme.bg = Theme.prototype.bg.bind(theme);
	}
	delete themeState[TOOL_SUCCESS_BG_PATCH_KEY];
}

type Phase = "Ready" | "Thinking" | "Exploring" | "Implementing" | "Testing" | "Running command" | "Responding";

interface GitFile {
	code: string;
	path: string;
}

interface GitState {
	isRepo: boolean;
	changed: number;
	files: GitFile[];
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
	ahead: number;
	behind: number;
	upstream?: string;
	additions: number;
	deletions: number;
	commitHash?: string;
	commitTimestamp?: number;
	commitSubject?: string;
	stashes: number;
}

interface Activity {
	tool: string;
	detail: string;
	startedAt: number;
	durationMs?: number;
	error?: boolean;
}

interface ProviderState {
	id: string;
	name: string;
	model: string;
	quotaStatus: "loading" | "available" | "unsupported" | "error";
	quotaMessage?: string;
	quotaMetrics: ProviderMetric[];
	rateMetrics: ProviderMetric[];
	updatedAt?: number;
}

interface RequestActivity {
	startedAt?: number;
	durationMs?: number;
	calls: number;
	errors: number;
	tools: Map<string, number>;
}

interface FooterSnapshot {
	usage?: ContextUsage;
	model: string;
	thinking: string;
}

interface FocusState {
	phase: Phase;
	sessionTitle: string;
	branch: string | null;
	footer: FooterSnapshot;
	git: GitState;
	active: Map<string, Activity>;
	recent: Activity[];
	requestActivity: RequestActivity;
	provider: ProviderState;
}

interface SystemInfo {
	os: string;
	network: string;
	disk: string;
	memory: string;
}

function formatStorage(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	const gib = bytes / 1024 ** 3;
	return `${gib >= 100 ? Math.round(gib) : gib.toFixed(1)} GiB`;
}

function operatingSystemName(): string {
	try {
		const fields = new Map(
			readFileSync("/etc/os-release", "utf8")
				.split("\n")
				.map((line) => line.split("=", 2))
				.filter((entry): entry is [string, string] => entry.length === 2)
				.map(([key, value]) => [key, value.replace(/^['"]|['"]$/g, "")]),
		);
		const name = fields.get("PRETTY_NAME");
		if (name) return name;
	} catch {
		// Fall back to Node's portable OS information.
	}
	return `${platform()} ${release()}`;
}

function defaultNetworkInterface(): string | undefined {
	try {
		for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields[1] === "00000000" && (Number.parseInt(fields[3] ?? "0", 16) & 2) !== 0) {
				return fields[0];
			}
		}
	} catch {
		// Non-Linux systems do not expose /proc/net/route.
	}
	return undefined;
}

function networkSummary(): string {
	const interfaces = networkInterfaces();
	const preferred = defaultNetworkInterface();
	const candidates = preferred ? [preferred, ...Object.keys(interfaces)] : Object.keys(interfaces);
	for (const name of [...new Set(candidates)]) {
		const address = interfaces[name]?.find((entry) => entry.family === "IPv4" && !entry.internal);
		if (!address) continue;
		const kind = existsSync(`/sys/class/net/${name}/wireless`) || /^wl/i.test(name)
			? "Wi-Fi"
			: /^(wg|tun|tap|ppp)/i.test(name)
				? "VPN"
				: /^(en|eth)/i.test(name)
					? "Ethernet"
					: "Network";
		return `${kind} · ${name} · ${address.address}`;
	}
	return "offline";
}

function collectSystemInfo(cwd: string): SystemInfo {
	let disk = "unavailable";
	try {
		const stats = statfsSync(cwd);
		disk = `${formatStorage(stats.bavail * stats.bsize)} free / ${formatStorage(stats.blocks * stats.bsize)}`;
	} catch {
		// Keep the header usable if the current filesystem cannot be queried.
	}
	return {
		os: operatingSystemName(),
		network: networkSummary(),
		disk,
		memory: `${formatStorage(freemem())} free / ${formatStorage(totalmem())}`,
	};
}

function compactNumber(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function oneLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function firstUserMessageLabel(entries: unknown[]): string | undefined {
	for (const value of entries) {
		const entry = asRecord(value);
		const message = asRecord(entry?.message);
		if (entry?.type !== "message" || message?.role !== "user") continue;
		const content = message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content
					.map((part) => asRecord(part))
					.filter((part) => part?.type === "text" && typeof part.text === "string")
					.map((part) => part!.text as string)
					.join("")
				: "";
		const label = oneLine(text);
		if (label) return label;
	}
	return undefined;
}

function toolDetail(tool: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const input = args as Record<string, unknown>;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return oneLine(input.command);
	if (typeof input.pattern === "string") return input.pattern;
	if (typeof input.query === "string") return input.query;
	return "";
}

function phaseForTool(tool: string, args: unknown): Phase {
	if (["read", "grep", "find", "ls"].includes(tool)) return "Exploring";
	if (["edit", "write"].includes(tool)) return "Implementing";
	if (tool === "bash") {
		const command = toolDetail(tool, args).toLowerCase();
		if (/\b(test|pytest|vitest|jest|cargo test|go test|lint|check)\b/.test(command)) return "Testing";
		return "Running command";
	}
	return "Thinking";
}

function formatDuration(ms?: number): string {
	if (ms === undefined) return "running";
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function formatRelativeAge(timestamp?: number): string {
	if (!timestamp) return "unknown";
	const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
	return `${Math.floor(seconds / 604_800)}w ago`;
}

function align(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 2 <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const room = Math.max(0, width - rightWidth - 2);
	if (room < 8) return truncateToWidth(left, width, "…");
	return truncateToWidth(left, room, "…") + "  " + truncateToWidth(right, width - room - 2, "");
}

function contextMeter(usage: ContextUsage | undefined, theme: Theme, cells = 10, showPrefix = true): string {
	if (!usage || usage.percent === null) return showPrefix ? theme.fg("dim", "ctx ?") : theme.fg("dim", "?");
	const percent = Math.max(0, Math.min(100, usage.percent));
	const filled = Math.round((percent / 100) * cells);
	const color = percent >= 90 ? "error" : percent >= 72 ? "warning" : "accent";
	return (
		(showPrefix ? theme.fg("dim", "ctx ") : "") +
		theme.fg(color, "━".repeat(filled)) +
		theme.fg("borderMuted", "─".repeat(cells - filled)) +
		theme.fg(color, ` ${Math.round(percent)}%`)
	);
}

class FocusEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly appTheme: Theme,
		private readonly usesManagedLayout: () => boolean,
		private readonly onViewportInput: (data: string) => boolean,
		private readonly onWheelFallbackInput: (data: string) => boolean,
		private readonly onToggleDashboard: () => void,
	) {
		super(tui, theme, keybindings, { paddingX: 1, autocompleteMaxVisible: 8 });
	}

	paste(text: string): void {
		if (!text) return;
		const safeText = text.replace(/\x1b\[(?:200|201)~/g, "");
		super.handleInput(`\x1b[200~${safeText}\x1b[201~`);
	}

	override handleInput(data: string): void {
		// Handle Shift+Enter before CustomEditor dispatches extension shortcuts.
		// Ctrl+Shift+M is intentionally not a dashboard shortcut: terminals can
		// encode Ctrl+M as Enter, which made newline input submit the prompt.
		if (matchesKey(data, Key.shift("enter"))) {
			super.handleInput("\n");
			return;
		}
		if (matchesKey(data, Key.alt("m")) || matchesKey(data, Key.f2)) {
			this.onToggleDashboard();
			return;
		}
		// When mouse reporting is unavailable, some terminals emulate the wheel as
		// arrow/page keys. Route those to the transcript while the prompt is empty
		// so they do not browse editor history instead of scrolling the conversation.
		if (
			this.usesManagedLayout()
			&& !this.isShowingAutocomplete()
			&& this.isEditorEmpty()
			&& isWheelFallbackScrollKey(data)
		) {
			if (this.onWheelFallbackInput(data)) return;
		}
		if (!this.onViewportInput(data)) super.handleInput(data);
	}

	private pinnedTopPadding(width: number, editorHeight: number): number {
		if (this.usesManagedLayout()) return 0;
		const editorHost = this.tui.children.find(
			(child) => child instanceof Container && child.children.includes(this),
		);
		if (!editorHost) return 0;

		let occupiedHeight = 0;
		for (const child of this.tui.children) {
			if (child !== editorHost) occupiedHeight += child.render(width).length;
		}
		return Math.max(0, this.tui.terminal.rows - occupiedHeight - editorHeight);
	}

	override render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const panelWidth = Math.max(1, availableWidth - EDITOR_MARGIN_X * 2);
		const surfaceWidth = Math.max(1, panelWidth - 1);
		const inheritedPadding = Math.max(0, EDITOR_PADDING_X - 1);
		const baseWidth = Math.max(1, surfaceWidth - inheritedPadding);
		const lines = super.render(baseWidth);
		if (lines.length < 2 || panelWidth < 4) return lines.map((line) => truncateToWidth(line, panelWidth, ""));

		const canvasMargin = fillCanvas(EDITOR_MARGIN_X);
		const contentIndent = " ".repeat(EDITOR_PADDING_X);
		const inheritedIndent = " ".repeat(inheritedPadding);
		const surface = (content: string) => {
			const clipped = truncateToWidth(content, surfaceWidth, "…");
			const padded = clipped + " ".repeat(Math.max(0, surfaceWidth - visibleWidth(clipped)));
			const background = this.appTheme.getBgAnsi("userMessageBg");
			const backgroundSafe = padded.replace(
				/\x1b\[(?:0|49)?m/g,
				(reset) => `${reset}${background}`,
			);
			return `${background}${backgroundSafe}\x1b[49m`;
		};
		const row = (content = "") =>
			canvasMargin + this.appTheme.fg("mdLinkUrl", "│") + surface(content);
		const isBorderLine = (line: string) => {
			const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			return /^─+(?: [↑↓] \d+ more )?─*$/.test(plain);
		};
		const bottomBorder = lines.findIndex((line, index) => index > 0 && isBorderLine(line));
		const bodyEnd = bottomBorder === -1 ? lines.length : bottomBorder;
		const inputRows = this.getText().length === 0
			? [row(`${contentIndent}${this.appTheme.fg(
				"dim",
				this.focused
					? `${CURSOR_MARKER}\x1b[7mA\x1b[27msk anything…  “Fix a TODO in the codebase”`
					: "Ask anything…  “Fix a TODO in the codebase”",
			)}`)]
			: lines.slice(1, bodyEnd).map((line) => row(`${inheritedIndent}${line}`));
		const autocompleteRows = lines.slice(bodyEnd + 1).map((line) => row(`${inheritedIndent}${line}`));
		const editorRows = [
			...autocompleteRows,
			...Array.from({ length: EDITOR_MARGIN_TOP }, () => fillCanvas(availableWidth)),
			...Array.from({ length: EDITOR_PADDING_TOP }, () => row()),
			...inputRows,
			...Array.from({ length: EDITOR_PADDING_BOTTOM }, () => row()),
		];
		const topPaddingRows = this.pinnedTopPadding(width, editorRows.length);
		const output = [
			...Array.from({ length: topPaddingRows }, () => fillCanvas(availableWidth)),
			...editorRows,
		];
		return output.map((line) => truncateToWidth(line, availableWidth, ""));
	}
}

class ControlCenter {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly state: FocusState,
	) { }

	render(width: number): string[] {
		const theme = this.theme;
		const w = Math.max(1, Math.min(width, CONTROL_WIDTH));
		const paddingX = Math.min(SIDEBAR_PADDING_X, Math.floor((w - 1) / 2));
		const contentWidth = Math.max(1, w - paddingX * 2);
		const targetHeight = Math.max(1, this.tui.terminal.rows);
		const row = (content = "") => {
			const clipped = truncateToWidth(content, contentWidth, "…");
			const paddedContent = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			const horizontalPadding = " ".repeat(paddingX);
			const background = theme.getBgAnsi("toolPendingBg");
			const surface = `${horizontalPadding}${paddedContent}${horizontalPadding}`.replace(
				/\x1b\[(?:0|49)?m/g,
				(reset) => `${reset}${background}`,
			);
			return background + surface + "\x1b[49m";
		};
		const fieldValueWidth = Math.max(1, contentWidth - FIELD_LABEL_WIDTH);
		const field = (label: string, value: string) =>
			row(`${theme.fg("muted", label.padEnd(FIELD_LABEL_WIDTH))}${truncateToWidth(value, fieldValueWidth, "…")}`);
		const lines: string[] = [];
		const section = (label: string) => {
			lines.push(row());
			lines.push(row(theme.fg("text", theme.bold(label))));
		};
		const branch = this.state.branch;
		const session = this.state.sessionTitle;
		const sessionLabel = truncateToWidth(session, contentWidth, "…");
		const cwdLabel = truncateToWidth(basename(this.cwd), contentWidth, "…");
		lines.push(row());
		lines.push(row(theme.fg("text", theme.bold(sessionLabel))));
		if (sessionLabel !== cwdLabel) {
			lines.push(row(theme.fg("muted", cwdLabel)));
		}

		section("Provider");
		lines.push(field("Name", theme.fg("text", this.state.provider.name)));
		lines.push(field("Model", theme.fg("text", this.state.provider.model)));
		if (this.state.provider.quotaStatus === "loading") {
			lines.push(field("Quota", theme.fg("dim", "Loading…")));
		} else if (this.state.provider.quotaStatus === "unsupported") {
			lines.push(field("Quota", theme.fg("dim", this.state.provider.quotaMessage ?? "Not exposed")));
		} else if (this.state.provider.quotaStatus === "error") {
			lines.push(field("Quota", theme.fg("warning", this.state.provider.quotaMessage ?? "Unavailable")));
		}
		for (const metric of [...this.state.provider.quotaMetrics, ...this.state.provider.rateMetrics]) {
			lines.push(field(metric.label, theme.fg(metric.tone ?? "muted", metric.value)));
		}

		section("Repository");
		if (!this.state.git.isRepo) {
			lines.push(field("Status", theme.fg("dim", "Not a Git repository")));
		} else {
			const sync = [
				this.state.git.ahead > 0 ? theme.fg("success", `↑${this.state.git.ahead}`) : "",
				this.state.git.behind > 0 ? theme.fg("warning", `↓${this.state.git.behind}`) : "",
			].filter(Boolean).join(" ");
			lines.push(field("Branch", theme.fg("accent", branch ?? "detached")));
			if (this.state.git.upstream || sync) {
				lines.push(field("Tracking", `${theme.fg("dim", this.state.git.upstream ?? "no upstream")}${sync ? `  ${sync}` : ""}`));
			}
			if (this.state.git.commitHash) {
				lines.push(field(
					"Commit",
					`${theme.fg("accent", this.state.git.commitHash)}${theme.fg("dim", ` · ${formatRelativeAge(this.state.git.commitTimestamp)}`)}`,
				));
				if (this.state.git.commitSubject) {
					lines.push(field("", theme.fg("dim", this.state.git.commitSubject)));
				}
			}
			if (this.state.git.stashes > 0) {
				lines.push(field("Stashes", theme.fg("warning", `${this.state.git.stashes}`)));
			}

			if (this.state.git.changed === 0) {
				lines.push(field("Changes", theme.fg("success", "✓ clean working tree")));
			} else {
				const states = [
					this.state.git.staged > 0 ? theme.fg("success", `${this.state.git.staged} staged`) : "",
					this.state.git.modified > 0 ? theme.fg("accent", `${this.state.git.modified} modified`) : "",
					this.state.git.untracked > 0 ? theme.fg("warning", `${this.state.git.untracked} untracked`) : "",
					this.state.git.conflicts > 0 ? theme.fg("error", `${this.state.git.conflicts} conflicts`) : "",
				].filter(Boolean).join(theme.fg("dim", " · "));
				lines.push(field("Changes", states));
				if (this.state.git.additions > 0 || this.state.git.deletions > 0) {
					lines.push(field("Diff", `${theme.fg("success", `+${this.state.git.additions}`)} ${theme.fg("error", `−${this.state.git.deletions}`)}`));
				}
				for (const [index, file] of this.state.git.files.slice(0, 3).entries()) {
					const color = file.code === "??" ? "warning" : file.code.includes("U") ? "error" : file.code[0] !== " " ? "success" : "muted";
					lines.push(field(index === 0 ? "Files" : "", `${theme.fg(color, file.code)} ${theme.fg("dim", file.path)}`));
				}
				if (this.state.git.files.length > 3) lines.push(field("", theme.fg("dim", `+${this.state.git.files.length - 3} more`)));
			}
		}

		section("Activity");
		const request = this.state.requestActivity;
		if (request.startedAt !== undefined) {
			const callLabel = `${request.calls} tool call${request.calls === 1 ? "" : "s"}`;
			const errors = request.errors > 0
				? theme.fg("error", ` · ${request.errors} failed`)
				: theme.fg("success", " · no failures");
			lines.push(field("Request", `${theme.fg("text", callLabel)}${errors}`));
			const elapsed = request.durationMs ?? Date.now() - request.startedAt;
			lines.push(field(
				"Elapsed",
				theme.fg(request.durationMs === undefined ? "accent" : "muted", formatDuration(elapsed)),
			));
			const toolSummary = [...request.tools.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4)
				.map(([tool, count]) => `${tool} ${count}`)
				.join(theme.fg("dim", " · "));
			if (toolSummary) lines.push(field("Tools", toolSummary));
		} else if (this.state.active.size === 0 && this.state.recent.length === 0) {
			lines.push(field("Status", theme.fg("dim", "No tool activity yet")));
		}
		const activeItems = [...this.state.active.values()].slice(-2);
		for (const [index, item] of activeItems.entries()) {
			const detail = truncateToWidth(item.detail, 22, "…");
			lines.push(field(index === 0 ? "Running" : "", `${theme.fg("accent", "●")} ${theme.fg("text", item.tool)} ${theme.fg("dim", detail)}`));
		}
		for (const [index, item] of this.state.recent.slice(0, Math.max(0, 3 - activeItems.length)).entries()) {
			const icon = item.error ? theme.fg("error", "×") : theme.fg("success", "✓");
			const activity = align(`${icon} ${item.tool}`, theme.fg("dim", formatDuration(item.durationMs)), fieldValueWidth);
			lines.push(field(index === 0 ? "Recent" : "", activity));
		}

		const footer = [
			row(theme.fg("dim", truncateToWidth(this.cwd, contentWidth, "…"))),
			row(theme.fg("dim", "Wheel / Ctrl+Shift+↑↓ scroll · Right-click paste")),
			row(theme.fg("dim", "F2, Alt+M, /focus  hide")),
		];
		const bodyLimit = Math.max(0, targetHeight - footer.length);
		if (lines.length > bodyLimit) lines.length = bodyLimit;
		while (lines.length < bodyLimit) lines.push(row());
		lines.push(...footer);
		return lines.slice(0, targetHeight).map((line) => truncateToWidth(line, w, ""));
	}

	invalidate(): void { }
}

export default function piFocus(pi: ExtensionAPI) {
	registerTokenUsage(pi);
	registerSessionBulkDelete(pi);
	patchToolSuccessStripe();

	const state: FocusState = {
		phase: "Ready",
		sessionTitle: "new session",
		branch: null,
		footer: {
			model: "no-model",
			thinking: "off",
		},
		git: {
			isRepo: false,
			changed: 0,
			files: [],
			staged: 0,
			modified: 0,
			untracked: 0,
			conflicts: 0,
			ahead: 0,
			behind: 0,
			additions: 0,
			deletions: 0,
			stashes: 0,
		},
		active: new Map(),
		recent: [],
		requestActivity: {
			calls: 0,
			errors: 0,
			tools: new Map(),
		},
		provider: {
			id: "",
			name: "No provider",
			model: "No model",
			quotaStatus: "unsupported",
			quotaMessage: "No quota data",
			quotaMetrics: [],
			rateMetrics: [],
		},
	};
	let requestRender: (() => void) | undefined;
	let dashboardVisible = true;
	let providerRefreshGeneration = 0;
	let transcriptScrollView: ScrollView | undefined;
	let chromeTui: TUI | undefined;
	let headerVisible = true;
	let headerHideTimer: ReturnType<typeof setTimeout> | undefined;
	const resetTerminalOnExit = () => resetTerminalModes();

	const repaint = () => requestRender?.();

	const captureFooterSnapshot = (ctx: ExtensionContext): void => {
		state.footer = {
			usage: ctx.getContextUsage(),
			model: ctx.model?.id ?? "no-model",
			thinking: ctx.thinkingLevel ?? "off",
		};
	};

	const captureSessionTitle = (ctx: ExtensionContext): void => {
		state.sessionTitle = ctx.sessionManager.getSessionName?.()
			?? firstUserMessageLabel(ctx.sessionManager.getBranch())
			?? "new session";
	};

	const refreshProviderUsage = async (ctx: ExtensionContext, force = false): Promise<void> => {
		if (ctx.mode !== "tui") return;
		const model = ctx.model;
		if (!model) {
			providerRefreshGeneration += 1;
			state.provider = {
				id: "",
				name: "No provider",
				model: "No model",
				quotaStatus: "unsupported",
				quotaMessage: "No quota data",
				quotaMetrics: [],
				rateMetrics: [],
			};
			repaint();
			return;
		}

		const providerId = model.provider;
		const sameProvider = state.provider.id === providerId;
		const isFresh = sameProvider && state.provider.updatedAt !== undefined
			&& Date.now() - state.provider.updatedAt < PROVIDER_USAGE_TTL_MS;
		state.provider.name = ctx.modelRegistry.getProviderDisplayName(providerId) || titleCase(providerId);
		state.provider.model = model.id;
		if (!force && isFresh) {
			repaint();
			return;
		}

		const supportsQuota = providerId === "github-copilot" || providerId === "openai-codex";
		const previousMetrics = sameProvider ? state.provider.quotaMetrics : [];
		const previousRateMetrics = sameProvider ? state.provider.rateMetrics : [];
		const generation = ++providerRefreshGeneration;
		state.provider = {
			id: providerId,
			name: ctx.modelRegistry.getProviderDisplayName(providerId) || titleCase(providerId),
			model: model.id,
			quotaStatus: supportsQuota ? (previousMetrics.length > 0 ? "available" : "loading") : "unsupported",
			quotaMessage: providerId === "cursor" ? "Use Cursor dashboard" : "Not exposed by provider",
			quotaMetrics: previousMetrics,
			rateMetrics: previousRateMetrics,
			updatedAt: sameProvider ? state.provider.updatedAt : undefined,
		};
		repaint();
		if (!supportsQuota) return;

		try {
			const quotaMetrics = providerId === "github-copilot"
				? await fetchCopilotQuota()
				: await fetchOpenAICodexQuota(ctx);
			if (generation !== providerRefreshGeneration || ctx.model?.provider !== providerId) return;
			state.provider.quotaMetrics = quotaMetrics;
			state.provider.quotaStatus = quotaMetrics.length > 0 ? "available" : "unsupported";
			state.provider.quotaMessage = quotaMetrics.length > 0 ? undefined : "No quota data";
			state.provider.updatedAt = Date.now();
		} catch {
			if (generation !== providerRefreshGeneration || ctx.model?.provider !== providerId) return;
			state.provider.quotaStatus = previousMetrics.length > 0 ? "available" : "error";
			state.provider.quotaMessage = previousMetrics.length > 0 ? undefined : "Temporarily unavailable";
			state.provider.updatedAt = Date.now();
		}
		repaint();
	};

	const setPhase = (ctx: ExtensionContext, phase: Phase) => {
		captureFooterSnapshot(ctx);
		state.phase = phase;
		if (phase === "Ready") {
			ctx.ui.setStatus(UI_STATUS_ID, undefined);
			ctx.ui.setWorkingMessage();
		} else {
			ctx.ui.setStatus(UI_STATUS_ID, undefined);
		}
		repaint();
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		const [statusResult, diffResult, commitResult, stashResult] = await Promise.all([
			pi.exec("git", ["status", "--porcelain=v1", "--branch"], { cwd: ctx.cwd, timeout: 3000 }),
			pi.exec("git", ["diff", "--no-ext-diff", "--numstat", "HEAD"], { cwd: ctx.cwd, timeout: 3000 }),
			pi.exec("git", ["log", "-1", "--format=%h%x09%ct%x09%s"], { cwd: ctx.cwd, timeout: 3000 }),
			pi.exec("git", ["stash", "list", "--format=%gd"], { cwd: ctx.cwd, timeout: 3000 }),
		]);
		if (statusResult.code !== 0) {
			state.git = {
				isRepo: false,
				changed: 0,
				files: [],
				staged: 0,
				modified: 0,
				untracked: 0,
				conflicts: 0,
				ahead: 0,
				behind: 0,
				additions: 0,
				deletions: 0,
				stashes: 0,
			};
			repaint();
			return;
		}

		const lines = statusResult.stdout.split("\n").filter(Boolean);
		const heading = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
		const upstreamMatch = heading.match(/\.\.\.([^\s\[]+)/);
		const aheadMatch = heading.match(/ahead (\d+)/);
		const behindMatch = heading.match(/behind (\d+)/);
		const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
		const files = lines.map((line): GitFile => ({
			code: line.slice(0, 2),
			path: line.length > 3 ? line.slice(3).trim() : line.trim(),
		}));
		const [commitHash, commitTimestampRaw, ...commitSubjectParts] = commitResult.code === 0
			? commitResult.stdout.trim().split("\t")
			: [];
		const parsedCommitTimestamp = Number.parseInt(commitTimestampRaw ?? "", 10);
		const commitSubject = commitSubjectParts.join("\t");
		const stashes = stashResult.code === 0
			? stashResult.stdout.split("\n").filter(Boolean).length
			: 0;
		let additions = 0;
		let deletions = 0;
		if (diffResult.code === 0) {
			for (const line of diffResult.stdout.split("\n")) {
				const [added, removed] = line.split("\t");
				if (added && added !== "-") additions += Number.parseInt(added, 10) || 0;
				if (removed && removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
			}
		}

		state.git = {
			isRepo: true,
			changed: files.length,
			files,
			staged: files.filter((file) => file.code !== "??" && !conflictCodes.has(file.code) && file.code[0] !== " ").length,
			modified: files.filter((file) => file.code !== "??" && !conflictCodes.has(file.code) && file.code[1] !== " ").length,
			untracked: files.filter((file) => file.code === "??").length,
			conflicts: files.filter((file) => conflictCodes.has(file.code)).length,
			ahead: aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : 0,
			behind: behindMatch ? Number.parseInt(behindMatch[1]!, 10) : 0,
			upstream: upstreamMatch?.[1],
			additions,
			deletions,
			commitHash: commitHash || undefined,
			commitTimestamp: Number.isFinite(parsedCommitTimestamp) ? parsedCommitTimestamp : undefined,
			commitSubject: commitSubject || undefined,
			stashes,
		};
		repaint();
	};

	const installChrome = (ctx: ExtensionContext) => {
		patchToolSuccessStripe();
		transcriptScrollView = undefined;
		const appTheme = ctx.ui.theme;
		const systemInfo = collectSystemInfo(ctx.cwd);
		ctx.ui.setTitle(`π ${basename(ctx.cwd)}`);
		ctx.ui.setWorkingIndicator({
			frames: [
				appTheme.fg("dim", "·"),
				appTheme.fg("muted", "•"),
				appTheme.fg("accent", "●"),
				appTheme.fg("muted", "•"),
			],
			intervalMs: 120,
		});
		ctx.ui.setWorkingVisible(false);

		ctx.ui.setHeader((tui, theme) => {
			chromeTui = tui;
			requestRender = () => tui.requestRender();
			const component: Component = {
				render(width: number): string[] {
					if (!headerVisible) return [];
					const layoutWidth = width;
					const logo = [
						theme.fg("text", "      ██████  "),
						theme.fg("text", "      ██  ██  "),
						theme.fg("text", "      ████  ██"),
						theme.fg("text", "      ██    ██"),
					];
					const info = [
						theme.fg("text", theme.bold("PI CODING AGENT")) + theme.fg("dim", "  focus ui"),
						`${theme.fg("muted", "version ")}${theme.fg("text", `v${VERSION}`)}${theme.fg("dim", ` · ${systemInfo.os}`)}`,
						`${theme.fg("muted", "network ")}${theme.fg("text", systemInfo.network)}`,
						`${theme.fg("muted", "disk    ")}${theme.fg("text", systemInfo.disk)}${theme.fg("dim", ` · memory ${systemInfo.memory}`)}`,
					];

					const lines = [fillCanvas(layoutWidth)];
					if (layoutWidth >= 76) {
						const logoWidth = 28;
						for (let i = 0; i < logo.length; i++) {
							const left = logo[i]!;
							lines.push(left + " ".repeat(Math.max(2, logoWidth - visibleWidth(left))) + truncateToWidth(info[i]!, layoutWidth - logoWidth, "…"));
						}
					} else {
						lines.push(...logo.map((line) => truncateToWidth(line, layoutWidth, "")));
						lines.push(truncateToWidth(theme.fg("text", theme.bold("π  PI CODING AGENT")), layoutWidth, "…"));
						lines.push(truncateToWidth(theme.fg("muted", `v${VERSION} · ${systemInfo.os}`), layoutWidth, "…"));
						lines.push(truncateToWidth(theme.fg("muted", `network ${systemInfo.network}`), layoutWidth, "…"));
						lines.push(truncateToWidth(theme.fg("muted", `disk ${systemInfo.disk} · memory ${systemInfo.memory}`), layoutWidth, "…"));
					}
					lines.push(fillCanvas(layoutWidth));
					lines.push(theme.fg("borderMuted", "─".repeat(Math.max(1, layoutWidth))));
					return lines.map((line) => truncateToWidth(line, layoutWidth, ""));
				},
				invalidate() { },
			};
			return component;
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			state.branch = footerData.getGitBranch();
			const unsubscribe = footerData.onBranchChange(() => {
				state.branch = footerData.getGitBranch();
				tui.requestRender();
			});
			return {
				dispose: unsubscribe,
				invalidate() { },
				render(width: number): string[] {
					const layoutWidth = width;
					const { usage, model, thinking } = state.footer;
					const meter = contextMeter(usage, theme, 16);
					const tokenCount = usage?.tokens !== null && usage?.tokens !== undefined
						? `${compactNumber(usage.tokens)} / ${compactNumber(usage.contextWindow)} tokens`
						: `? / ${usage ? compactNumber(usage.contextWindow) : "?"} tokens`;
					const right =
						`${theme.fg("text", model)}${theme.fg("dim", " · ")}${theme.fg("mdLinkUrl", thinking)}${theme.fg("dim", ` · ${tokenCount}  ·  `)}${meter}`;
					const phaseColor = state.phase === "Ready" ? "success" : state.phase === "Testing" ? "warning" : "accent";
					const phaseIcon = state.phase === "Ready" ? "○" : "●";
					const statusItems = [...footerData.getExtensionStatuses().entries()]
						.filter(([key]) => key !== UI_STATUS_ID)
						.map(([, text]) => oneLine(text));
					statusItems.unshift(theme.fg(phaseColor, `${phaseIcon} ${state.phase}`));
					if (transcriptScrollView && !transcriptScrollView.isFollowingEnd) {
						statusItems.push(theme.fg("warning", "↑ viewing history · Ctrl+Shift+↓ toward latest"));
					}
					const statuses = statusItems.join(theme.fg("dim", "  ·  "));
					const statusMargin = fillCanvas(EDITOR_MARGIN_X);
					const statusWidth = Math.max(1, layoutWidth - EDITOR_MARGIN_X);
					return [
						...Array.from({ length: STATUS_PADDING_TOP }, () => fillCanvas(layoutWidth)),
						`${statusMargin}${align(statuses, right, statusWidth)}`,
					].map((line) => truncateToWidth(line, layoutWidth, ""));
				},
			};
		});

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			configureTranscriptScrollKeybindings(keybindings);
			return new FocusEditor(
				tui,
				theme,
				keybindings,
				appTheme,
				() => transcriptScrollView !== undefined,
				(data) => scrollTranscriptByKeyboard(data, transcriptScrollView),
				(data) => scrollTranscriptByWheelFallback(data, transcriptScrollView),
				() => void toggleDashboard(ctx),
			);
		});

		// Keep Pi's fullscreen mouse reporting enabled so wheel events reach the
		// primary transcript ScrollView. Right-click paste is wired on Linux below.
		// Use Pi's native fullscreen layout engine. Only loaded notices and chat
		// messages live in the ScrollView; header, editor dock, footer, and the
		// right-hand dashboard are fixed layout siblings.
		if (chromeTui && isViewportTUI(chromeTui)) {
			enableLinuxRightClickPaste(chromeTui);
			const roots = chromeTui.children;
			const document = roots[0];
			if (document instanceof Container && document.children.length >= 3 && roots.length >= 7) {
				const transcript = new Container();
				for (const child of document.children.slice(1)) transcript.addChild(child);
				transcriptScrollView = new ScrollView(transcript, {
					follow: "end",
					primary: true,
					overscroll: "contain",
					scrollbar: "auto",
					scrollbarStyle: (text) => appTheme.bg("scrollbarThumb", text),
				});
				const dock = new VStack([
					{ component: roots[1]!, shrink: 1, minSize: 0 },
					{ component: roots[2]!, shrink: 1, minSize: 0 },
					{ component: roots[3]!, shrink: 1, minSize: 0 },
					{ component: roots[4]!, shrink: 1, minSize: 3 },
					{ component: roots[5]!, shrink: 1, minSize: 0 },
					{ component: roots[6]!, shrink: 1, minSize: 1 },
				]);
				const left = new VStack([
					{ component: document.children[0]!, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
					{ component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
				]);
				// Render only from plain snapshots. Pi can render the outgoing layout
				// once after invalidating its ExtensionContext during session replacement.
				const dashboard = new ControlCenter(
					chromeTui,
					appTheme,
					ctx.cwd,
					state,
				);
				chromeTui.setLayoutRoot(new HStack([
					{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{
						component: dashboard,
						basis: CONTROL_WIDTH,
						grow: 0,
						shrink: 0,
						minSize: CONTROL_WIDTH,
						maxSize: CONTROL_WIDTH,
						visible: ({ width, height }) =>
							dashboardVisible && width >= DASHBOARD_MIN_WIDTH && height >= DASHBOARD_MIN_HEIGHT,
					},
				], { gap: DASHBOARD_GAP }));
				chromeTui.requestRender(true);
			} else {
				ctx.ui.notify("Pi Focus: fullscreen component layout is incompatible.", "warning");
			}
		} else {
			ctx.ui.notify("Pi Focus requires tuiMode=fullscreen for a fixed message viewport.", "warning");
		}

		headerVisible = true;
		if (headerHideTimer) clearTimeout(headerHideTimer);
		headerHideTimer = setTimeout(() => {
			headerVisible = false;
			headerHideTimer = undefined;
			repaint();
		}, HEADER_AUTO_HIDE_MS);
		headerHideTimer.unref();
	};

	const toggleDashboard = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") return;
		dashboardVisible = !dashboardVisible;
		chromeTui?.requestRender(true);

		// Never delay the visual toggle behind git commands in large repositories.
		void refreshGit(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		captureSessionTitle(ctx);
		captureFooterSnapshot(ctx);
		process.removeListener("exit", resetTerminalOnExit);
		process.once("exit", resetTerminalOnExit);
		installChrome(ctx);
		applyTerminalBackground(CANVAS_BG_HEX);
		await refreshGit(ctx);
		void refreshProviderUsage(ctx, true);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		providerRefreshGeneration += 1;
		if (headerHideTimer) clearTimeout(headerHideTimer);
		headerHideTimer = undefined;
		ctx.ui.setWorkingVisible(true);
		restoreToolSuccessStripe();
		// Interactive quit stops the TUI before extension cleanup. Keep the exit
		// fallback installed for quit; replacement sessions remove it before the
		// next extension instance installs its own handler.
		if (event.reason === "quit") {
			applyTerminalBackground(TERMINAL_BG_RESTORE_HEX);
		} else {
			process.removeListener("exit", resetTerminalOnExit);
		}
		if (event.reason === "quit") resetTerminalModes();
	});

	pi.on("agent_start", async (_event, ctx) => {
		captureSessionTitle(ctx);
		state.active.clear();
		state.requestActivity = {
			startedAt: Date.now(),
			calls: 0,
			errors: 0,
			tools: new Map(),
		};
		setPhase(ctx, "Thinking");
	});
	pi.on("message_update", async (_event, ctx) => {
		captureFooterSnapshot(ctx);
		if (state.active.size === 0) setPhase(ctx, "Responding");
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		patchToolSuccessStripe();
		const activity: Activity = {
			tool: event.toolName,
			detail: toolDetail(event.toolName, event.args),
			startedAt: Date.now(),
		};
		state.active.set(event.toolCallId, activity);
		state.requestActivity.calls += 1;
		state.requestActivity.tools.set(
			event.toolName,
			(state.requestActivity.tools.get(event.toolName) ?? 0) + 1,
		);
		setPhase(ctx, phaseForTool(event.toolName, event.args));
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		const activity = state.active.get(event.toolCallId);
		if (activity) {
			state.active.delete(event.toolCallId);
			activity.durationMs = Date.now() - activity.startedAt;
			activity.error = event.isError;
			if (event.isError) state.requestActivity.errors += 1;
			state.recent.unshift(activity);
			state.recent = state.recent.slice(0, 8);
		}
		if (["edit", "write", "bash"].includes(event.toolName)) void refreshGit(ctx);
		if (state.active.size === 0) setPhase(ctx, "Thinking");
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.requestActivity.startedAt !== undefined) {
			state.requestActivity.durationMs = Date.now() - state.requestActivity.startedAt;
		}
		setPhase(ctx, "Ready");
		await refreshGit(ctx);
		void refreshProviderUsage(ctx);
	});
	pi.on("after_provider_response", async (event, ctx) => {
		const metrics = rateLimitMetrics(event.headers);
		if (metrics.length === 0 || state.provider.id !== ctx.model?.provider) return;
		state.provider.rateMetrics = metrics;
		repaint();
	});
	pi.on("model_select", async (_event, ctx) => {
		captureFooterSnapshot(ctx);
		void refreshProviderUsage(ctx, true);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		captureFooterSnapshot(ctx);
		repaint();
	});
	pi.on("session_info_changed", async (_event, ctx) => {
		captureSessionTitle(ctx);
		repaint();
	});

	pi.registerCommand("focus", {
		description: "Toggle the passive Pi Focus dashboard",
		handler: async (_args, ctx) => toggleDashboard(ctx),
	});
	// The editor intercepts these keys directly because focused editor input can
	// take precedence over extension-level shortcuts. Do not bind Ctrl+Shift+M:
	// Ctrl+M and Enter are indistinguishable in terminals without key protocols.
	pi.registerShortcut(Key.alt("m"), {
		description: "Toggle the passive Pi Focus dashboard",
		handler: toggleDashboard,
	});
	pi.registerShortcut(Key.f2, {
		description: "Toggle the passive Pi Focus dashboard",
		handler: toggleDashboard,
	});
	pi.registerCommand("provider-usage", {
		description: "Refresh provider quota information",
		handler: async (_args, ctx) => {
			await refreshProviderUsage(ctx, true);
			const status = state.provider.quotaStatus;
			await ctx.ui.notify(
				status === "available" ? "Provider usage refreshed." : state.provider.quotaMessage ?? "Provider usage unavailable.",
				status === "available" ? "info" : "warning",
			);
		},
	});
}
