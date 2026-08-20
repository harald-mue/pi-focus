/**
 * Token usage extension — per-request summary in the footer,
 * compact analysis via /last-request, full dump via /last-request-dump.
 */

import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "token-usage";
const STATE_ENTRY_TYPE = "token-usage-state";

interface TurnRecord {
	turnIndex: number;
	/** Total model input for this call, including cache reads/writes. */
	totalInput: number;
	/** Uncached input tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface SystemPromptBreakdown {
	total: number;
	customPrompt: number;
	toolSnippets: number;
	contextFiles: number;
	skills: number;
	guidelines: number;
	append: number;
	remainder: number;
}

interface MessageBreakdown {
	user: number;
	assistant: number;
	tools: number;
	history: number;
	other: number;
}

interface RequestAnalysis {
	prompt: string;
	llmCalls: number;
	billed: {
		/** Sum of all input categories across all LLM calls. */
		totalInput: number;
		/** Uncached input tokens across all LLM calls. */
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	finalContextSize: number;
	estimated: {
		systemPrompt: SystemPromptBreakdown;
		userPrompt: number;
		runMessages: MessageBreakdown;
	};
	turns: TurnRecord[];
}

interface LastRequestDump {
	timestamp: string;
	analysis: RequestAnalysis;
	systemPrompt: string;
	inputMessages: AgentMessage[];
	runMessages: AgentMessage[];
	providerPayload: unknown;
}

interface RequestState {
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions | null;
	firstContext: AgentMessage[] | null;
	lastContext: AgentMessage[];
	lastPayload: unknown;
	runMessages: AgentMessage[];
	turns: TurnRecord[];
	billedInput: number;
	billedOutput: number;
	billedCacheRead: number;
	billedCacheWrite: number;
	lastContextInput: number;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function estimateTextTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function estimateSystemPromptBreakdown(
	systemPrompt: string,
	options: BuildSystemPromptOptions | null,
): SystemPromptBreakdown {
	const customPrompt = estimateTextTokens(options?.customPrompt ?? "");
	const toolSnippets = estimateTextTokens(
		options?.toolSnippets ? JSON.stringify(options.toolSnippets) : "",
	);
	const contextFiles = (options?.contextFiles ?? []).reduce(
		(sum, file) => sum + estimateTextTokens(file.content),
		0,
	);
	const skills = (options?.skills ?? []).reduce((sum, skill) => {
		const body = [skill.name, skill.description, skill.filePath].filter(Boolean).join("\n");
		return sum + estimateTextTokens(body);
	}, 0);
	const guidelines = estimateTextTokens((options?.promptGuidelines ?? []).join("\n"));
	const append = estimateTextTokens(options?.appendSystemPrompt ?? "");
	const known = customPrompt + toolSnippets + contextFiles + skills + guidelines + append;
	const total = estimateTextTokens(systemPrompt);

	return {
		total,
		customPrompt,
		toolSnippets,
		contextFiles,
		skills,
		guidelines,
		append,
		remainder: Math.max(0, total - known),
	};
}

function estimateRunMessageBreakdown(
	messages: AgentMessage[],
	firstContext: AgentMessage[] | null,
): MessageBreakdown {
	let user = 0;
	let assistant = 0;
	let tools = 0;
	let other = 0;

	for (const message of messages) {
		const tokens = estimateTokens(message);
		switch (message.role) {
			case "user":
				user += tokens;
				break;
			case "assistant":
				assistant += tokens;
				break;
			case "toolResult":
				tools += tokens;
				break;
			default:
				other += tokens;
				break;
		}
	}

	let history = 0;
	if (firstContext && firstContext.length > 0) {
		let lastUserIndex = -1;
		for (let i = firstContext.length - 1; i >= 0; i--) {
			if (firstContext[i]?.role === "user") {
				lastUserIndex = i;
				break;
			}
		}
		if (lastUserIndex > 0) {
			history = estimateMessagesTokens(firstContext.slice(0, lastUserIndex));
		}
	}

	return { user, assistant, tools, history, other };
}

function buildAnalysis(state: RequestState): RequestAnalysis {
	return {
		prompt: state.prompt,
		llmCalls: state.turns.length,
		billed: {
			totalInput:
				state.billedInput + state.billedCacheRead + state.billedCacheWrite,
			input: state.billedInput,
			output: state.billedOutput,
			cacheRead: state.billedCacheRead,
			cacheWrite: state.billedCacheWrite,
		},
		finalContextSize: state.lastContextInput,
		estimated: {
			systemPrompt: estimateSystemPromptBreakdown(state.systemPrompt, state.systemPromptOptions),
			userPrompt: estimateTextTokens(state.prompt),
			runMessages: estimateRunMessageBreakdown(state.runMessages, state.firstContext),
		},
		turns: state.turns,
	};
}

function updateStatusWorking(ctx: ExtensionContext, llmCalls: number): void {
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(STATUS_ID, theme.fg("dim", llmCalls > 0 ? `⋯ ${llmCalls} calls` : "⋯"));
}

function updateStatusSummary(ctx: ExtensionContext, analysis: RequestAnalysis): void {
	const theme = ctx.ui.theme;
	const { billed, llmCalls } = analysis;
	const text =
		theme.fg("dim", `req ↑${formatTokens(billed.totalInput)} `) +
		theme.fg("accent", `↓${formatTokens(billed.output)}`) +
		theme.fg("dim", ` · ${llmCalls}×`);
	ctx.ui.setStatus(STATUS_ID, text);
}

function truncatePrompt(prompt: string, max = 80): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine || "(empty)";
	return `${oneLine.slice(0, max - 1)}…`;
}

function formatSummaryText(analysis: RequestAnalysis): string {
	const { estimated, billed, finalContextSize, turns, prompt } = analysis;
	const sys = estimated.systemPrompt;
	const run = estimated.runMessages;

	const lines = [
		"Token Usage Summary — Last Request",
		"═".repeat(42),
		"",
		`Prompt: "${truncatePrompt(prompt)}"`,
		"",
		`Provider Usage (${turns.length} LLM call${turns.length === 1 ? "" : "s"})`,
		`  Total input:       ${billed.totalInput.toLocaleString()} (including cache)`,
		`  Uncached input:    ${billed.input.toLocaleString()}`,
		`  Cache read:        ${billed.cacheRead.toLocaleString()}`,
		`  Cache write:       ${billed.cacheWrite.toLocaleString()}`,
		`  Total output:      ${billed.output.toLocaleString()}`,
		`  Final context:     ${finalContextSize.toLocaleString()} input tokens`,
		"",
		"Estimated Breakdown (~)",
		`  System prompt:        ${sys.total.toLocaleString()}`,
		`    Context files:      ${sys.contextFiles.toLocaleString()}`,
		`    Skills:             ${sys.skills.toLocaleString()}`,
		`    Remainder (tools, Pi): ${sys.remainder.toLocaleString()}`,
		`  User prompt:          ${estimated.userPrompt.toLocaleString()}`,
		`  Session history:      ${run.history.toLocaleString()}`,
		`  Tools (request):      ${run.tools.toLocaleString()}`,
		`  Assistant (request):  ${run.assistant.toLocaleString()}`,
		"",
	];

	if (turns.length > 0) {
		lines.push("Per LLM Call");
		for (const turn of turns) {
			const cache =
				turn.cacheRead > 0 || turn.cacheWrite > 0
					? ` · cache ${turn.cacheRead.toLocaleString()}/${turn.cacheWrite.toLocaleString()}`
					: "";
			lines.push(
				`  #${turn.turnIndex}: ↑${turn.totalInput.toLocaleString()} ↓${turn.output.toLocaleString()}${cache}`,
			);
		}
		lines.push("");
	}

	lines.push(
		"Note: Total input includes uncached input, cache reads, and cache writes summed across all calls.",
		"Estimated values use Pi's chars/4 heuristic.",
		"",
		"Full dump (messages, payload, system prompt): /last-request-dump",
	);

	return lines.join("\n");
}

function defaultDumpPath(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(homedir(), "dumps", `last-request-${stamp}.json`);
}

function resolveDumpPath(input: string | undefined): string {
	const trimmed = input?.trim();
	if (!trimmed) return defaultDumpPath();
	if (trimmed.startsWith("~/")) {
		return join(homedir(), trimmed.slice(2));
	}
	return trimmed;
}

function buildDumpData(state: RequestState): LastRequestDump {
	return {
		timestamp: new Date().toISOString(),
		analysis: buildAnalysis(state),
		systemPrompt: state.systemPrompt,
		inputMessages: state.lastContext,
		runMessages: state.runMessages,
		providerPayload: state.lastPayload,
	};
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, val: unknown) => {
			if (typeof val === "bigint") return val.toString();
			if (typeof val === "function") return undefined;
			if (val && typeof val === "object") {
				if (seen.has(val)) return "[Circular]";
				seen.add(val);
			}
			return val;
		},
		2,
	);
}

async function resolveDumpTarget(
	ctx: ExtensionCommandContext,
	argPath: string,
): Promise<string | null> {
	const defaultPath = defaultDumpPath();
	if (argPath) return resolveDumpPath(argPath);

	if (!ctx.hasUI) return defaultPath;

	try {
		const useDefault = await ctx.ui.confirm(
			"Save token dump?",
			`Save to: ${defaultPath}`,
		);
		if (useDefault) return defaultPath;

		const custom = await ctx.ui.input("Alternative path:", defaultPath);
		return resolveDumpPath(custom?.trim() || defaultPath);
	} catch {
		// Cursor bridge may not support all UI dialogs — fall back to default path.
		return defaultPath;
	}
}

function normalizeAnalysis(value: unknown): RequestAnalysis | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<RequestAnalysis>;
	if (!candidate.billed || !Array.isArray(candidate.turns)) return null;
	if (typeof candidate.prompt !== "string" || typeof candidate.llmCalls !== "number") return null;
	if (!candidate.estimated || typeof candidate.finalContextSize !== "number") return null;

	const billed = candidate.billed as RequestAnalysis["billed"];
	const input = billed.input ?? 0;
	const cacheRead = billed.cacheRead ?? 0;
	const cacheWrite = billed.cacheWrite ?? 0;
	const turns = candidate.turns.map((turn, index) => ({
		...turn,
		turnIndex: turn.turnIndex ?? index,
		totalInput: turn.totalInput ?? turn.input + turn.cacheRead + turn.cacheWrite,
	}));

	return {
		...candidate,
		llmCalls: turns.length,
		billed: {
			...billed,
			totalInput: billed.totalInput ?? input + cacheRead + cacheWrite,
			input,
			output: billed.output ?? 0,
			cacheRead,
			cacheWrite,
		},
		turns,
	} as RequestAnalysis;
}

function getBranchMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as AgentMessage);
}

function userMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function reconstructAnalysis(ctx: ExtensionContext): RequestAnalysis | null {
	const messages = getBranchMessages(ctx);
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			lastUserIndex = index;
			break;
		}
	}
	if (lastUserIndex < 0) return null;

	const turns: TurnRecord[] = [];
	let billedInput = 0;
	let billedOutput = 0;
	let billedCacheRead = 0;
	let billedCacheWrite = 0;
	let lastContextInput = 0;

	for (const message of messages.slice(lastUserIndex + 1)) {
		if (message.role !== "assistant") continue;
		const usage = (message as AssistantMessage).usage;
		if (!usage) continue;
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		const totalInput = input + cacheRead + cacheWrite;
		turns.push({
			turnIndex: turns.length,
			totalInput,
			input,
			output,
			cacheRead,
			cacheWrite,
		});
		billedInput += input;
		billedOutput += output;
		billedCacheRead += cacheRead;
		billedCacheWrite += cacheWrite;
		lastContextInput = totalInput;
	}
	if (turns.length === 0) return null;

	const firstContext = messages.slice(0, lastUserIndex + 1);
	const runMessages = messages.slice(lastUserIndex + 1);
	return buildAnalysis({
		prompt: userMessageText(messages[lastUserIndex]!),
		systemPrompt: ctx.getSystemPrompt(),
		systemPromptOptions: null,
		firstContext,
		lastContext: messages,
		lastPayload: null,
		runMessages,
		turns,
		billedInput,
		billedOutput,
		billedCacheRead,
		billedCacheWrite,
		lastContextInput,
	});
}

function restorePersistedAnalysis(ctx: ExtensionContext): RequestAnalysis | null {
	const branch = ctx.sessionManager.getBranch();
	let lastUserIndex = -1;
	let lastStateIndex = -1;
	let persisted: unknown;

	for (const [index, entry] of branch.entries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			lastUserIndex = index;
		}
		if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
			lastStateIndex = index;
			persisted = (entry.data as { analysis?: unknown } | undefined)?.analysis;
		}
	}

	return lastStateIndex > lastUserIndex ? normalizeAnalysis(persisted) : null;
}

function buildRestoredDump(ctx: ExtensionContext, analysis: RequestAnalysis): LastRequestDump {
	const messages = getBranchMessages(ctx);
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			lastUserIndex = index;
			break;
		}
	}
	return {
		timestamp: new Date().toISOString(),
		analysis,
		systemPrompt: ctx.getSystemPrompt(),
		inputMessages: lastUserIndex >= 0 ? messages.slice(0, lastUserIndex + 1) : messages,
		runMessages: lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [],
		providerPayload: null,
	};
}

export function registerTokenUsage(pi: ExtensionAPI) {
	let active: RequestState | null = null;
	let lastAnalysis: RequestAnalysis | null = null;
	let lastDump: LastRequestDump | null = null;
	let capturedFirstContext = false;

	const requireLastAnalysis = async (
		ctx: ExtensionCommandContext,
	): Promise<RequestAnalysis | null> => {
		await ctx.waitForIdle();
		if (!lastAnalysis) {
			await ctx.ui.notify("No completed request available yet.", "warning");
			return null;
		}
		return lastAnalysis;
	};

	const requireLastDump = async (
		ctx: ExtensionCommandContext,
	): Promise<LastRequestDump | null> => {
		const analysis = await requireLastAnalysis(ctx);
		if (!analysis) return null;
		return lastDump ?? buildRestoredDump(ctx, analysis);
	};

	const startRequest = (
		prompt: string,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	) => {
		active = {
			prompt,
			systemPrompt,
			systemPromptOptions,
			firstContext: null,
			lastContext: [],
			lastPayload: null,
			runMessages: [],
			turns: [],
			billedInput: 0,
			billedOutput: 0,
			billedCacheRead: 0,
			billedCacheWrite: 0,
			lastContextInput: 0,
		};
		capturedFirstContext = false;
	};

	pi.on("session_start", async (_event, ctx) => {
		active = null;
		capturedFirstContext = false;
		lastAnalysis = restorePersistedAnalysis(ctx) ?? reconstructAnalysis(ctx);
		lastDump = lastAnalysis ? buildRestoredDump(ctx, lastAnalysis) : null;
		if (lastAnalysis) updateStatusSummary(ctx, lastAnalysis);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		startRequest(event.prompt, event.systemPrompt, event.systemPromptOptions);
		updateStatusWorking(ctx, 0);
	});

	pi.on("context", async (event) => {
		if (!active) return;
		active.lastContext = structuredClone(event.messages);
		if (!capturedFirstContext) {
			active.firstContext = structuredClone(event.messages);
			capturedFirstContext = true;
		}
	});

	pi.on("before_provider_request", async (event) => {
		if (!active) return;
		try {
			active.lastPayload = structuredClone(event.payload);
		} catch {
			active.lastPayload = event.payload;
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!active) return;

		const message = event.message as AssistantMessage;
		const usage = message.usage;
		const input = usage?.input ?? 0;
		const output = usage?.output ?? 0;
		const cacheRead = usage?.cacheRead ?? 0;
		const cacheWrite = usage?.cacheWrite ?? 0;

		const totalInput = input + cacheRead + cacheWrite;
		active.turns.push({
			turnIndex: event.turnIndex,
			totalInput,
			input,
			output,
			cacheRead,
			cacheWrite,
		});
		active.billedInput += input;
		active.billedOutput += output;
		active.billedCacheRead += cacheRead;
		active.billedCacheWrite += cacheWrite;
		active.lastContextInput = totalInput;

		updateStatusWorking(ctx, active.turns.length);
	});

	pi.on("agent_end", async (event) => {
		if (!active) return;
		active.runMessages = structuredClone(event.messages);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!active) return;

		lastDump = buildDumpData(active);
		lastAnalysis = lastDump.analysis;
		pi.appendEntry(STATE_ENTRY_TYPE, { analysis: lastAnalysis });
		updateStatusSummary(ctx, lastAnalysis);
		active = null;
	});

	pi.registerCommand("last-request", {
		description: "Show a concise token summary for the last request",
		handler: async (_args, ctx) => {
			const analysis = await requireLastAnalysis(ctx);
			if (!analysis) return;
			await ctx.ui.editor("Token Usage Summary", formatSummaryText(analysis));
		},
	});

	pi.registerCommand("last-request-dump", {
		description: "Write the full token dump to a file",
		handler: async (args, ctx) => {
			const dump = await requireLastDump(ctx);
			if (!dump) return;

			const targetPath = await resolveDumpTarget(ctx, args.trim());
			if (!targetPath) {
				await ctx.ui.notify("Dump cancelled.", "warning");
				return;
			}

			try {
				mkdirSync(dirname(targetPath), { recursive: true });
				writeFileSync(targetPath, safeStringify(dump), "utf-8");
				await ctx.ui.notify(`Dump saved: ${targetPath}`, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await ctx.ui.notify(`Dump failed: ${message}`, "error");
			}
		},
	});
}
