import type { Sql } from '../db/client'

/**
 * Generation failure-domain quota breaker (CAL-010 / #145).
 *
 * A failure domain is the ACCOUNT/PROXY/QUOTA POOL behind a provider. Two
 * models behind the same proxy account are NOT independent fallbacks — the
 * 2026-09-11 incident 429'd the entire chain simultaneously. When one domain
 * trips (429 usage-limit), candidates in that domain are SKIPPED until the
 * provider-stated reset time instead of paying the failure latency again.
 *
 * The breaker only removes noise/latency; availability improves only with a
 * second INDEPENDENT domain (CAL-012). All operations are fail-open: a
 * broken breaker state can never make generation worse than no breaker.
 */

export const QUOTA_BREAKER_VERSION = 'quota-breaker-v1'

/** message fragments that mark SUSTAINED quota exhaustion (account-level) */
const QUOTA_EXHAUSTED_MARKERS = [
	'usage limit reached',
	'quota exceeded',
	'quota exhausted',
	'quota limit reached',
	'billing limit',
]

/** markers for a short-lived rate limit (per-request/minute throttling) */
const THROTTLE_MARKERS = ['429', 'rate limit', 'too many requests']

/**
 * CAL-010 residual: classify a rate-limit failure precisely.
 *  - quota_exhausted: the account's quota pool is drained for a sustained
 *    period (GLM: "Usage limit reached for 5 hour") → domain breaker.
 *  - transient_throttle: a 429 without sustained-quota wording (per-minute
 *    throttling, retry-after hints) → short cooldown, never the 30-min
 *    breaker.
 *  - null: not a rate limit at all.
 */
export type RateLimitKind = 'quota_exhausted' | 'transient_throttle'

export function classifyRateLimit(message: string): RateLimitKind | null {
	const lower = message.toLowerCase()
	if (QUOTA_EXHAUSTED_MARKERS.some((m) => lower.includes(m))) {
		return 'quota_exhausted'
	}
	if (THROTTLE_MARKERS.some((m) => lower.includes(m))) {
		return 'transient_throttle'
	}
	return null
}

/** does this gateway error message indicate a quota-exhausted domain? */
export function isQuotaExhaustion(message: string): boolean {
	return classifyRateLimit(message) === 'quota_exhausted'
}

/** short cooldown for transient throttling when the provider states none */
export const DEFAULT_THROTTLE_SECONDS = 60

/**
 * Parse a provider retry hint ("retry after 30s", "retry-after: 120") in
 * MILLISECONDS. Null when absent — the caller applies the 60s default.
 */
export function parseRetryAfterMs(message: string): number | null {
	const match = message.match(
		/retry[- ]?after[:\s]+(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes)?/i,
	)
	if (!match) return null
	const n = Number(match[1])
	if (!Number.isFinite(n) || n <= 0) return null
	const unit = (match[2] ?? 's').toLowerCase()
	return unit.startsWith('m') ? n * 60_000 : n * 1000
}

/**
 * Extract the provider-stated reset time when present
 * (e.g. "reset at 2026-09-11 16:25:24" from the GLM proxy). Null when the
 * message carries none — the caller then uses a bounded default.
 */
export function parseQuotaResetAt(message: string, now: Date): Date | null {
	const match = message.match(
		/reset (?:at|after)\s+([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})/i,
	)
	if (match) {
		const parsed = new Date(`${match[1]}Z`.replace(/ZT$/, 'T'))
		if (!Number.isNaN(parsed.getTime())) return parsed
	}
	const after = message.match(/reset after (\d+)h (\d+)m/i)
	if (after) {
		return new Date(
			now.getTime() + Number(after[1]) * 3_600_000 + Number(after[2]) * 60_000,
		)
	}
	return null
}

/** bounded default when the provider states no reset time */
export const DEFAULT_BREAKER_MINUTES = 30

export interface DomainSkip {
	domain: string
	resetAt: string | null
}

/**
 * Which domains are currently OPEN (quota exhausted) with reset in the
 * future. Fail-open on any error: an unreadable breaker never skips.
 */
export async function openQuotaDomains(
	sql: Sql,
	now: Date,
): Promise<Map<string, DomainSkip>> {
	try {
		const rows = await sql<
			{ key: string; reset_at: string | null }[]
		>`select key, reset_at from generation_quota_domains
			where state = 'open'
				and (reset_at is null or reset_at > ${now.toISOString()})`
		return new Map(
			rows.map((r) => [
				r.key,
				{
					domain: r.key,
					resetAt: r.reset_at ? new Date(r.reset_at).toISOString() : null,
				},
			]),
		)
	} catch {
		return new Map()
	}
}

/**
 * Trip the breaker for a domain. Persistent record — a later process reads
 * the open state even across restarts. Auto-expires via reset_at.
 */
export async function tripQuotaDomain(
	sql: Sql,
	domain: string,
	input: { message: string; resetAt: Date | null; now: Date },
): Promise<void> {
	try {
		const resetAt =
			input.resetAt ??
			new Date(input.now.getTime() + DEFAULT_BREAKER_MINUTES * 60_000)
		await sql`
			insert into generation_quota_domains
				(key, state, opened_at, reset_at, last_error, updated_at)
			values (${domain}, 'open', ${input.now.toISOString()},
				${resetAt.toISOString()}, ${input.message.slice(0, 500)},
				${input.now.toISOString()})
			on conflict (key) do update set
				state = 'open',
				opened_at = ${input.now.toISOString()},
				reset_at = ${resetAt.toISOString()},
				last_error = ${input.message.slice(0, 500)},
				updated_at = ${input.now.toISOString()}`
	} catch {
		// breaker write failure must never break the turn
	}
}

/**
 * Close a domain's breaker (called when a request in that domain SUCCEEDS —
 * self-healing if the provider reset earlier than stated).
 */
export async function closeQuotaDomain(
	sql: Sql,
	domain: string,
): Promise<void> {
	try {
		await sql`
			update generation_quota_domains
			set state = 'closed', reset_at = null, updated_at = now()
			where key = ${domain} and state = 'open'`
	} catch {
		// fail-open
	}
}
