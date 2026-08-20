import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

export type MetricTone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

export interface ProviderMetric {
	label: string;
	value: string;
	tone?: MetricTone;
}

export function titleCase(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join(" ");
}

function quotaNumber(value: number): string {
	if (!Number.isFinite(value)) return "?";
	if (Math.abs(value) < 1000) return Number.isInteger(value) ? `${value}` : value.toFixed(1);
	if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function quotaTone(usedPercent: number): MetricTone {
	if (usedPercent >= 90) return "error";
	if (usedPercent >= 75) return "warning";
	return "success";
}

function formatResetDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}

function formatQuotaWindow(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "usage window";
	if (seconds % 604_800 === 0) return `${seconds / 604_800}w window`;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d window`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h window`;
	return "usage window";
}

function formatResetDate(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
	} catch {
		return undefined;
	}
}

function readStoredOAuthCredential(provider: string): Record<string, unknown> | undefined {
	try {
		const auth = asRecord(JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8")));
		const credential = asRecord(auth?.[provider]);
		return credential?.type === "oauth" ? credential : undefined;
	} catch {
		return undefined;
	}
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = asRecord(await response.json());
	if (!data) throw new Error("Invalid provider response");
	return data;
}

export async function fetchCopilotQuota(): Promise<ProviderMetric[]> {
	const credential = readStoredOAuthCredential("github-copilot");
	const token = typeof credential?.refresh === "string" ? credential.refresh : undefined;
	if (!token) throw new Error("OAuth credential unavailable");
	const enterprise = typeof credential?.enterpriseUrl === "string" ? credential.enterpriseUrl.trim() : "";
	const domain = enterprise || "github.com";
	const data = await fetchJson(`https://api.${domain}/copilot_internal/user`, {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		"User-Agent": "GitHubCopilotChat/0.35.0",
		"Editor-Version": "vscode/1.107.0",
		"Editor-Plugin-Version": "copilot-chat/0.35.0",
		"Copilot-Integration-Id": "vscode-chat",
	});
	const metrics: ProviderMetric[] = [];
	if (typeof data.copilot_plan === "string") {
		metrics.push({ label: "Plan", value: titleCase(data.copilot_plan), tone: "text" });
	}
	const snapshots = asRecord(data.quota_snapshots);
	const premium = asRecord(snapshots?.premium_interactions);
	if (premium) {
		const total = finiteNumber(premium.entitlement);
		const used = finiteNumber(premium.credits_used);
		const remaining = finiteNumber(premium.quota_remaining) ?? finiteNumber(premium.remaining);
		const remainingPercent = finiteNumber(premium.percent_remaining);
		if (total !== undefined && used !== undefined) {
			metrics.push({
				label: "Premium",
				value: `${quotaNumber(used)} / ${quotaNumber(total)} credits`,
				tone: quotaTone(total > 0 ? (used / total) * 100 : 0),
			});
		}
		if (remaining !== undefined) {
			metrics.push({
				label: "Remaining",
				value: `${quotaNumber(remaining)}${remainingPercent !== undefined ? ` · ${remainingPercent.toFixed(1)}%` : ""}`,
				tone: remainingPercent !== undefined ? quotaTone(100 - remainingPercent) : "muted",
			});
		}
	}
	const chat = asRecord(snapshots?.chat);
	if (chat?.unlimited === true) metrics.push({ label: "Chat", value: "Unlimited", tone: "success" });
	const completions = asRecord(snapshots?.completions);
	if (completions?.unlimited === true) metrics.push({ label: "Completion", value: "Unlimited", tone: "success" });
	const reset = formatResetDate(data.quota_reset_date_utc ?? data.quota_reset_date);
	if (reset) metrics.push({ label: "Reset", value: reset, tone: "muted" });
	return metrics;
}

export async function fetchOpenAICodexQuota(ctx: ExtensionContext): Promise<ProviderMetric[]> {
	const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = resolved?.auth.apiKey;
	if (!token) throw new Error("OAuth credential unavailable");
	const payload = decodeJwtPayload(token);
	const authClaims = asRecord(payload?.["https://api.openai.com/auth"]);
	const accountId = typeof authClaims?.chatgpt_account_id === "string"
		? authClaims.chatgpt_account_id
		: undefined;
	if (!accountId) throw new Error("Account identifier unavailable");
	const data = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		"User-Agent": "codex_cli_rs/0.101.0",
	});
	const metrics: ProviderMetric[] = [];
	if (typeof data.plan_type === "string") {
		metrics.push({ label: "Plan", value: titleCase(data.plan_type), tone: "text" });
	}
	const rateLimit = asRecord(data.rate_limit);
	const primary = asRecord(rateLimit?.primary_window);
	const usedPercent = finiteNumber(primary?.used_percent);
	const windowSeconds = finiteNumber(primary?.limit_window_seconds);
	if (usedPercent !== undefined) {
		metrics.push({
			label: "Usage",
			value: `${usedPercent.toFixed(0)}% · ${formatQuotaWindow(windowSeconds ?? 0)}`,
			tone: quotaTone(usedPercent),
		});
		metrics.push({
			label: "Remaining",
			value: `${Math.max(0, 100 - usedPercent).toFixed(0)}%`,
			tone: quotaTone(usedPercent),
		});
	}
	const resetAfter = finiteNumber(primary?.reset_after_seconds);
	const resetAt = finiteNumber(primary?.reset_at);
	if (resetAfter !== undefined || resetAt !== undefined) {
		const seconds = resetAfter ?? Math.max(0, resetAt! - Date.now() / 1000);
		metrics.push({ label: "Reset", value: formatResetDuration(seconds), tone: "muted" });
	}
	const credits = asRecord(data.credits);
	if (credits?.has_credits === true && typeof credits.balance === "string") {
		metrics.push({ label: "Credits", value: credits.balance, tone: "accent" });
	}
	return metrics;
}

export function rateLimitMetrics(headers: Record<string, string>): ProviderMetric[] {
	const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const first = (...names: string[]) => names.map((name) => normalized.get(name)).find(Boolean);
	const metrics: ProviderMetric[] = [];
	const requestLimit = first("x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit", "ratelimit-limit");
	const requestRemaining = first(
		"x-ratelimit-remaining-requests",
		"anthropic-ratelimit-requests-remaining",
		"ratelimit-remaining",
	);
	if (requestLimit && requestRemaining) {
		metrics.push({ label: "Requests", value: `${requestRemaining} / ${requestLimit} left`, tone: "muted" });
	}
	const tokenLimit = first("x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit");
	const tokenRemaining = first("x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining");
	if (tokenLimit && tokenRemaining) {
		metrics.push({ label: "Rate tokens", value: `${tokenRemaining} / ${tokenLimit} left`, tone: "muted" });
	}
	const retryAfter = first("retry-after");
	if (retryAfter) metrics.push({ label: "Retry", value: `${retryAfter}s`, tone: "warning" });
	return metrics;
}
