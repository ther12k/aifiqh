import { type Principal, sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Feature flags + safe rollout controls (CFG-003).
 *
 *  - SAME SUBJECT DETERMINISTIC: bucketing is a salted SHA-256 of
 *    (flag, tenant, user) — the same subject always lands in the same
 *    bucket, no randomness, no flicker between requests;
 *  - KILL SWITCH IMMEDIATE: a flag-level kill switch (rollout_rules row
 *    with percentage 0 at priority 100, or flipping enabled_by_default)
 *    takes effect on the very next evaluation — no caches;
 *  - INVALID TARGETING REJECTED: percentages outside 0..100, unknown
 *    segments, or a rule for a missing flag are refused;
 *  - EFFECTIVE FLAGS STORED IN TRACE: evaluation snapshots are written
 *    to retrieval_traces.effective_flags;
 *  - changes audited: every rule/kill-switch change writes an event.
 */

export const FLAG_SERVICE_VERSION = 'flag-service-v1'

export class FlagError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'FlagError'
		this.code = code
	}
}

export interface EffectiveFlags {
	flags: Record<string, boolean>
	/** bucket assignments behind each true flag */
	buckets: Record<string, number>
	evaluatedAt: string
	killSwitched: string[]
}

/**
 * Deterministic bucket for a subject: 0..99. Same (flag, tenant, user)
 * always yields the same bucket.
 */
export function bucketFor(
	flagKey: string,
	tenantId: string,
	userId: string,
): number {
	const digest = sha256Hex(`${flagKey}|${tenantId}|${userId}`)
	return Number.parseInt(digest.slice(0, 8), 16) % 100
}

interface RuleRow {
	id: string
	percentage: number
	segment: { kill_switch?: boolean; roles?: string[] }
	priority: number
}

/**
 * Evaluate all flags for a subject. Deterministic per subject; a kill
 * switch (segment.kill_switch) overrides everything for its flag.
 */
export async function evaluateFlags(
	sql: Sql,
	principal: Principal,
): Promise<EffectiveFlags> {
	const flags = await sql<
		{ key: string; enabled_by_default: boolean }[]
	>`select key, enabled_by_default from feature_flags order by key`
	const rules = await sql<RuleRow[]>`
		select r.id, r.percentage, r.segment, r.priority
		from rollout_rules r
		where r.tenant_id is null or r.tenant_id = ${principal.tenantId}::uuid
		order by r.priority desc`

	const effective: EffectiveFlags = {
		flags: {},
		buckets: {},
		evaluatedAt: new Date().toISOString(),
		killSwitched: [],
	}

	for (const flag of flags) {
		let enabled = flag.enabled_by_default
		// rules apply highest priority first; first matching rule wins.
		// The initial tenant-wide query is unused for per-flag decisions —
		// kept for the snapshot of rule volume only.
		void rules
		const flagRules = await sql<RuleRow[]>`
			select r.id, r.percentage, r.segment, r.priority
			from rollout_rules r
			join feature_flags f on f.id = r.flag_id
			where f.key = ${flag.key}
				and (r.tenant_id is null or r.tenant_id = ${principal.tenantId}::uuid)
			order by r.priority desc`
		for (const rule of flagRules) {
			if (rule.segment?.kill_switch) {
				enabled = false
				effective.killSwitched.push(flag.key)
				break
			}
			const ruleRoles = rule.segment?.roles ?? []
			const matchesRoles =
				ruleRoles.length === 0 ||
				ruleRoles.some((role) => principal.roles.includes(role as never))
			if (!matchesRoles) continue
			const bucket = bucketFor(flag.key, principal.tenantId, principal.userId)
			effective.buckets[flag.key] = bucket
			enabled = bucket < rule.percentage
			break
		}
		effective.flags[flag.key] = enabled
	}
	return effective
}

/** Persist the evaluation snapshot onto a trace (effective flags stored). */
export async function storeEffectiveFlags(
	sql: Sql,
	traceId: string,
	effective: EffectiveFlags,
): Promise<void> {
	await sql`
		update retrieval_traces set effective_flags = ${sql.json(effective as never)}
		where id = ${traceId}::uuid`
}

export interface CreateRuleInput {
	flagKey: string
	percentage: number
	tenantId?: string | null
	segment?: { kill_switch?: boolean; roles?: string[] }
	priority?: number
}

export async function createRolloutRule(
	sql: Sql,
	principal: Principal,
	input: CreateRuleInput,
): Promise<{ ruleId: string }> {
	if (!principal.permissions.includes('config:manage')) {
		throw new FlagError('FORBIDDEN', 'config:manage required')
	}
	if (
		!Number.isInteger(input.percentage) ||
		input.percentage < 0 ||
		input.percentage > 100
	) {
		throw new FlagError(
			'PERCENTAGE_INVALID',
			'percentage must be an integer 0..100',
		)
	}
	if (input.segment?.roles) {
		const known = new Set([
			'tenant_admin',
			'editor',
			'reviewer',
			'reader',
			'operator',
			'service',
		])
		for (const role of input.segment.roles) {
			if (!known.has(role)) {
				throw new FlagError(
					'SEGMENT_INVALID',
					`unknown role in segment: ${role}`,
				)
			}
		}
	}
	const [flag] = await sql<{ id: string }[]>`
		select id from feature_flags where key = ${input.flagKey}`
	if (!flag)
		throw new FlagError(
			'FLAG_NOT_FOUND',
			`flag ${input.flagKey} does not exist`,
		)

	const ruleId = await sql.begin(async (tx) => {
		const [row] = await tx<{ id: string }[]>`
			insert into rollout_rules (
				flag_id, tenant_id, percentage, segment, priority, created_by
			) values (
				${flag.id}::uuid,
				${input.tenantId ? tx`${input.tenantId}::uuid` : null},
				${input.percentage},
				${tx.json((input.segment ?? {}) as never)},
				${input.priority ?? 0},
				${principal.userId}::uuid
			)
			returning id`
		await recordAuditInTx(tx, {
			tenantId: null,
			actorType: 'user',
			actorId: principal.userId,
			action: 'config.rollout_rule_created',
			entityType: 'rollout_rule',
			entityId: row.id,
			afterRef: {
				flagKey: input.flagKey,
				percentage: input.percentage,
				segment: input.segment ?? {},
				priority: input.priority ?? 0,
			},
		})
		return row.id
	})
	return { ruleId }
}

/** Kill switch: immediate 0% rule with kill_switch segment, audited. */
export async function killSwitch(
	sql: Sql,
	principal: Principal,
	flagKey: string,
): Promise<{ ruleId: string }> {
	if (!principal.permissions.includes('config:manage')) {
		throw new FlagError('FORBIDDEN', 'config:manage required')
	}
	return createRolloutRule(sql, principal, {
		flagKey,
		percentage: 0,
		segment: { kill_switch: true },
		priority: 100,
	})
}

export async function upsertFlag(
	sql: Sql,
	principal: Principal,
	key: string,
	description: string,
	enabledByDefault: boolean,
): Promise<{ key: string }> {
	if (!principal.permissions.includes('config:manage')) {
		throw new FlagError('FORBIDDEN', 'config:manage required')
	}
	await sql.begin(async (tx) => {
		await tx`
			insert into feature_flags (key, description, enabled_by_default)
			values (${key}, ${description}, ${enabledByDefault})
			on conflict (key) do update
				set description = excluded.description,
					enabled_by_default = excluded.enabled_by_default`
		await recordAuditInTx(tx, {
			tenantId: null,
			actorType: 'user',
			actorId: principal.userId,
			action: 'config.flag_upserted',
			entityType: 'feature_flag',
			entityId: key,
			afterRef: { description, enabledByDefault },
		})
	})
	return { key }
}
