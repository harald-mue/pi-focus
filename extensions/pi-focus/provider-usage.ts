import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
	if (typeof value === "number" && Number.isFinite(value)) {
		const millis = value > 1e12 ? value : value * 1000;
		const date = new Date(millis);
		if (Number.isNaN(date.getTime())) return undefined;
		return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
	}
	if (typeof value === "string" && value) {
		if (/^\d+$/.test(value)) return formatResetDate(Number(value));
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return undefined;
		return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
	}
	return undefined;
}

function formatUsd(dollars: number): string {
	if (!Number.isFinite(dollars)) return "?";
	return `$${dollars.toLocaleString("en-US", {
		minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatUsdFromCents(cents: number): string {
	return formatUsd(cents / 100);
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

async function fetchJson(
	url: string,
	headers: Record<string, string>,
	init?: { method?: string; body?: string },
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: init?.method,
		headers,
		body: init?.body,
		signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = asRecord(await response.json());
	if (!data) throw new Error("Invalid provider response");
	return data;
}

function cursorStateDbPath(): string | undefined {
	const home = homedir();
	const candidates = [
		process.env.CURSOR_CONFIG_DIR
			? join(process.env.CURSOR_CONFIG_DIR, "User/globalStorage/state.vscdb")
			: "",
		join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
		join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
		process.env.APPDATA ? join(process.env.APPDATA, "Cursor/User/globalStorage/state.vscdb") : "",
	];
	return candidates.find((path) => path.length > 0 && existsSync(path));
}

async function readCursorDesktopSession(): Promise<{
	token: string;
	email?: string;
	teamId?: number;
	teamName?: string;
} | undefined> {
	const dbPath = cursorStateDbPath();
	if (!dbPath) return undefined;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const get = (key: string): string | undefined => {
				const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
					| { value?: string | Uint8Array }
					| undefined;
				if (!row?.value) return undefined;
				return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
			};
			const token = get("cursorAuth/accessToken");
			if (!token) return undefined;
			const payload = decodeJwtPayload(token);
			const exp = finiteNumber(payload?.exp);
			if (exp !== undefined && exp * 1000 <= Date.now()) {
				throw new Error("Cursor desktop session expired");
			}
			const teamRaw = get("cursorAuth/cachedTeam");
			let team: Record<string, unknown> | undefined;
			if (teamRaw) {
				try {
					team = asRecord(JSON.parse(teamRaw));
				} catch {
					team = undefined;
				}
			}
			const teamId = finiteNumber(team?.teamId);
			return {
				token,
				email: get("cursorAuth/cachedEmail"),
				teamId,
				teamName: typeof team?.name === "string" ? team.name : undefined,
			};
		} finally {
			db.close();
		}
	} catch (error) {
		if (error instanceof Error && error.message === "Cursor desktop session expired") throw error;
		return undefined;
	}
}

async function fetchCursorDashboardJson(
	token: string,
	method: string,
	body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	return fetchJson(
		`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
		{
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
		},
		{ method: "POST", body: JSON.stringify(body) },
	);
}

function cursorSpendMetrics(
	member: Record<string, unknown>,
	extras: {
		planName?: string;
		teamName?: string;
		onDemandAllowed?: boolean;
		reset?: string;
	},
): ProviderMetric[] {
	const metrics: ProviderMetric[] = [];
	if (extras.planName) metrics.push({ label: "Plan", value: extras.planName, tone: "text" });
	if (extras.teamName) metrics.push({ label: "Team", value: extras.teamName, tone: "muted" });
	const spendCents = finiteNumber(member.overallSpendCents) ?? finiteNumber(member.spendCents) ?? 0;
	const onDemandCents = finiteNumber(member.spendCents);
	const limitDollars =
		finiteNumber(member.effectivePerUserLimitDollars)
		?? finiteNumber(member.monthlyLimitDollars)
		?? finiteNumber(member.hardLimitOverrideDollars);
	if (limitDollars !== undefined && limitDollars > 0) {
		const usedPercent = (spendCents / 100 / limitDollars) * 100;
		metrics.push({
			label: "Usage",
			value: `${formatUsdFromCents(spendCents)} / ${formatUsd(limitDollars)}`,
			tone: quotaTone(usedPercent),
		});
		metrics.push({
			label: "Remaining",
			value: formatUsd(Math.max(0, limitDollars - spendCents / 100)),
			tone: quotaTone(usedPercent),
		});
	} else {
		metrics.push({ label: "Usage", value: formatUsdFromCents(spendCents), tone: "muted" });
	}
	if (extras.onDemandAllowed === false) {
		metrics.push({ label: "On-demand", value: "Off", tone: "muted" });
	} else if (onDemandCents !== undefined) {
		metrics.push({
			label: "On-demand",
			value: formatUsdFromCents(onDemandCents),
			tone: onDemandCents > 0 ? "accent" : "muted",
		});
	}
	if (extras.reset) metrics.push({ label: "Reset", value: extras.reset, tone: "muted" });
	return metrics;
}

async function fetchCursorQuotaFromDesktopSession(): Promise<ProviderMetric[]> {
	const session = await readCursorDesktopSession();
	if (!session) throw new Error("Cursor desktop session unavailable");
	const teamBody = session.teamId !== undefined ? { teamId: session.teamId } : {};
	const [plan, hardLimit, spend] = await Promise.all([
		fetchCursorDashboardJson(session.token, "GetPlanInfo", teamBody),
		fetchCursorDashboardJson(session.token, "GetHardLimit", teamBody),
		session.email
			? fetchCursorDashboardJson(session.token, "GetTeamSpend", {
				...teamBody,
				searchTerm: session.email,
				page: 1,
				pageSize: 10,
			}).catch(() => ({} as Record<string, unknown>))
			: Promise.resolve({} as Record<string, unknown>),
	]);
	const planInfo = asRecord(plan.planInfo);
	const members = Array.isArray(spend.teamMemberSpend) ? spend.teamMemberSpend : [];
	const member = members
		.map((value) => asRecord(value))
		.find((entry) => {
			if (!entry) return false;
			if (!session.email) return true;
			return typeof entry.email === "string" && entry.email.toLowerCase() === session.email.toLowerCase();
		});
	if (!member) {
		const metrics: ProviderMetric[] = [];
		if (typeof planInfo?.planName === "string") {
			metrics.push({ label: "Plan", value: planInfo.planName, tone: "text" });
		}
		if (session.teamName) metrics.push({ label: "Team", value: session.teamName, tone: "muted" });
		if (hardLimit.noUsageBasedAllowed === true) {
			metrics.push({ label: "On-demand", value: "Off", tone: "muted" });
		}
		const reset = formatResetDate(spend.nextCycleStart ?? planInfo?.billingCycleEnd);
		if (reset) metrics.push({ label: "Reset", value: reset, tone: "muted" });
		if (metrics.length === 0) throw new Error("No quota data");
		return metrics;
	}
	return cursorSpendMetrics(member, {
		planName: typeof planInfo?.planName === "string" ? planInfo.planName : undefined,
		teamName: session.teamName,
		onDemandAllowed: hardLimit.noUsageBasedAllowed === true ? false : undefined,
		reset: formatResetDate(spend.nextCycleStart ?? planInfo?.billingCycleEnd),
	});
}

async function fetchCursorQuotaFromApiKey(ctx: ExtensionContext): Promise<ProviderMetric[]> {
	const resolved = await ctx.modelRegistry.getProviderAuth("cursor");
	const token = resolved?.auth.apiKey;
	if (!token) throw new Error("API credential unavailable");
	const me = await fetchJson("https://api.cursor.com/v1/me", {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
	});
	const email = typeof me.userEmail === "string" ? me.userEmail : undefined;
	const spend = await fetchJson(
		"https://api.cursor.com/teams/spend",
		{
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		{
			method: "POST",
			body: JSON.stringify({
				searchTerm: email,
				page: 1,
				pageSize: 10,
			}),
		},
	);
	const members = Array.isArray(spend.teamMemberSpend) ? spend.teamMemberSpend : [];
	const member = members
		.map((value) => asRecord(value))
		.find((entry) => {
			if (!entry) return false;
			if (!email) return true;
			return typeof entry.email === "string" && entry.email.toLowerCase() === email.toLowerCase();
		});
	if (!member) throw new Error("Team spend unavailable for this API key");
	return cursorSpendMetrics(member, {
		reset: formatResetDate(spend.nextCycleStart ?? spend.subscriptionCycleStart),
	});
}

export async function fetchCursorQuota(ctx: ExtensionContext): Promise<ProviderMetric[]> {
	try {
		return await fetchCursorQuotaFromDesktopSession();
	} catch {
		return fetchCursorQuotaFromApiKey(ctx);
	}
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
	const secondary = asRecord(rateLimit?.secondary_window);
	const weeklyUsedPercent = finiteNumber(secondary?.used_percent);
	const weeklyWindowSeconds = finiteNumber(secondary?.limit_window_seconds);

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
	// Show weekly/secondary window (e.g. 7-day limit) when it differs from primary.
	if (
		weeklyUsedPercent !== undefined
		&& weeklyWindowSeconds !== undefined
		&& weeklyWindowSeconds !== windowSeconds
	) {
		metrics.push({
			label: "Weekly",
			value: `${weeklyUsedPercent.toFixed(0)}% · ${formatQuotaWindow(weeklyWindowSeconds)}`,
			tone: quotaTone(weeklyUsedPercent),
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
