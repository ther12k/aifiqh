import { sha256Hex } from '@aifiqh/shared'
import type { Principal } from '@aifiqh/shared'
import type postgres from 'postgres'
import { recordAuditInTx } from '../audit/audit'
import { evaluateFlags } from '../config/flagService'
import type { Sql } from '../db/client'

/**
 * Deterministic release gate policies and stored results (EVAL-006).
 *
 * Gate evaluation is a PURE function: `evaluateThresholds` compares a
 * metric map against a policy's thresholds (min/max/boolean) and fails
 * CLOSED — a threshold whose metric is absent from the inputs fails the
 * gate with METRIC_MISSING, never passes silently. The same inputs
 * (policy version + thresholds + metric values + subject) hash to the
 * same input_hash and always produce the same result.
 *
 * Results are stored in the append-only gate_results (0018): one result
 * per (policy, subject). Re-evaluating with identical inputs returns the
 * stored row (determinism); a DIFFERENT input hash for an already-gated
 * subject is rejected — the subject version is immutable, evaluate the
 * new stack as a new subject.
 *
 * Overrides: only when the policy allows (thresholds.allowOverride) and
 * only through overrideGateFailure, which requires review:publish, a
 * reason of at least 16 chars, and writes an audit event — an untracked
 * manual pass is impossible.
 */

export const GATE_SERVICE_VERSION = 'gate-service-v1'

export class GateError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'GateError'
		this.code = code
	}
}

export interface GateThresholds {
	allowOverride?: boolean
	[key: string]: unknown
}

export interface ThresholdCheck {
	threshold: string
	expected: string
	value: number | boolean | null
	passed: boolean
	reason: string | null
}

/**
 * Pure threshold evaluation. min → value >= bound; max → value <= bound;
 * boolean → equality. Missing metric → failed check (fails closed).
 */
export function evaluateThresholds(
	thresholds: GateThresholds,
	metrics: Record<string, number | boolean | null>,
): { checks: ThresholdCheck[]; passed: boolean } {
	const checks: ThresholdCheck[] = []
	let passed = true
	for (const [name, bound] of Object.entries(thresholds)) {
		if (name === 'allowOverride') continue
		const value = metrics[name] ?? null
		let ok = false
		let expected: string
		let reason: string | null = null
		if (typeof bound === 'boolean') {
			expected = `= ${bound}`
			ok = typeof value === 'boolean' && value === bound
			if (!ok && value !== null) reason = `expected ${bound}, got ${value}`
		} else if (name.endsWith('_min')) {
			expected = `>= ${bound}`
			ok = typeof value === 'number' && value >= (bound as number)
			if (!ok && value !== null) {
				reason = `expected >= ${bound}, got ${value}`
			}
		} else if (name.endsWith('_max')) {
			expected = `<= ${bound}`
			ok = typeof value === 'number' && value <= (bound as number)
			if (!ok && value !== null) {
				reason = `expected <= ${bound}, got ${value}`
			}
		} else {
			expected = 'present'
			ok = value !== null
			if (!ok) reason = 'metric absent'
		}
		if (value === null) {
			reason = 'METRIC_MISSING'
			ok = false
		}
		if (!ok) passed = false
		checks.push({ threshold: name, expected, value, passed: ok, reason })
	}
	return { checks, passed }
}

/** the launch_v1 metric names mapped from run reports */
export const LAUNCH_METRIC_SOURCES = ['retrieval', 'e2e', 'comparison'] as const

export function mergeLaunchMetrics(
	retrievalReport: Record<string, unknown> | null,
	e2eReport: Record<string, unknown> | null,
	comparisonReport: Record<string, unknown> | null,
): Record<string, number | boolean | null> {
	const num = (
		report: Record<string, unknown> | null,
		field: string,
	): number | null => {
		if (!report) return null
		const v = report[field]
		return typeof v === 'number' ? v : null
	}
	const comparisonClean = (): boolean | null => {
		if (!comparisonReport) return null
		const summary = comparisonReport.summary as
			| { regressed?: number }
			| undefined
		if (!summary || typeof summary.regressed !== 'number') return null
		return summary.regressed === 0
	}
	return {
		exact_lookup_min: num(retrievalReport, 'exactLookupRate'),
		recall_at_10_min: num(retrievalReport, 'recallAtK'),
		permission_leakage_max: num(retrievalReport, 'scopeLeaks'),
		citation_resolution_min: num(e2eReport, 'citationResolutionRate'),
		exact_quote_match_min: num(e2eReport, 'exactQuoteMatchRate'),
		critical_unsupported_claims_max: num(e2eReport, 'unsupportedClaimsRate'),
		critical_attribution_errors_max: num(e2eReport, 'attributionErrorRate'),
		sensitive_case_policy_compliance: num(e2eReport, 'sensitiveComplianceRate'),
		traceability: num(e2eReport, 'traceabilityRate'),
		rebuild_equivalence: comparisonClean(),
	}
}

export interface GateEvaluationInput {
	policyKey?: string
	subjectType: 'knowledge_release' | 'index_release' | 'config'
	subjectId: string
	retrievalRunId: string | null
	e2eRunId: string | null
	comparisonId?: string | null
}

export interface GateEvaluationResult {
	gateResultId: string
	result: 'passed' | 'failed'
	inputHash: string
	policyKey: string
	policyVersion: number
	checks: ThresholdCheck[]
	stored: boolean
}

export async function evaluateLaunchGate(
	sql: Sql | postgres.TransactionSql,
	principal: Principal,
	input: GateEvaluationInput,
): Promise<GateEvaluationResult> {
	const policyKey = input.policyKey ?? 'launch_v1'
	const [policy] = await sql<
		{ id: string; version: number; thresholds: GateThresholds }[]
	>`
		select id, version, thresholds from gate_policies
		where key = ${policyKey} and active
		order by version desc limit 1`
	if (!policy) {
		throw new GateError(
			'POLICY_NOT_FOUND',
			`no active gate policy: ${policyKey}`,
		)
	}

	const loadRunReport = async (
		runId: string | null,
	): Promise<Record<string, unknown> | null> => {
		if (!runId) return null
		const [row] = await sql<{ report: Record<string, unknown> }[]>`
			select r.report from evaluation_runs r
			join evaluation_set_versions v on v.id = r.set_version_id
			join evaluation_sets s on s.id = v.set_id
			where r.id = ${runId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
		if (!row) {
			throw new GateError('RUN_NOT_FOUND', `run not found in tenant: ${runId}`)
		}
		return row.report
	}
	const retrievalReport = await loadRunReport(input.retrievalRunId)
	const e2eReport = await loadRunReport(input.e2eRunId)
	let comparisonReport: Record<string, unknown> | null = null
	if (input.comparisonId) {
		const [row] = await sql<{ report: Record<string, unknown> }[]>`
			select c.report from evaluation_comparisons c
			join evaluation_runs br on br.id = c.baseline_run_id
			join evaluation_set_versions bv on bv.id = br.set_version_id
			join evaluation_sets bs on bs.id = bv.set_id
			where c.id = ${input.comparisonId}::uuid
				and bs.tenant_id = ${principal.tenantId}::uuid`
		if (!row) {
			throw new GateError(
				'COMPARISON_NOT_FOUND',
				`comparison not found in tenant: ${input.comparisonId}`,
			)
		}
		comparisonReport = row.report
	}

	const metrics = mergeLaunchMetrics(
		retrievalReport,
		e2eReport,
		comparisonReport,
	)
	const { checks, passed } = evaluateThresholds(policy.thresholds, metrics)

	// canonical input hash: same inputs → same hash → same verdict
	const inputHash = sha256Hex(
		JSON.stringify({
			version: GATE_SERVICE_VERSION,
			policyKey,
			policyVersion: policy.version,
			thresholds: policy.thresholds,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			metricSources: {
				retrievalRunId: input.retrievalRunId,
				e2eRunId: input.e2eRunId,
				comparisonId: input.comparisonId ?? null,
			},
			metrics,
		}),
	)

	// one stored result per (policy, subject): identical inputs return the
	// stored verdict; different inputs on a gated subject are rejected
	const [existing] = await sql<
		{ id: string; input_hash: string; result: string }[]
	>`select id, input_hash, result from gate_results
		where policy_id = ${policy.id}::uuid
			and subject_type = ${input.subjectType}
			and subject_id = ${input.subjectId}::uuid`
	if (existing) {
		if (existing.input_hash === inputHash) {
			return {
				gateResultId: existing.id,
				result: existing.result as 'passed' | 'failed',
				inputHash,
				policyKey,
				policyVersion: policy.version,
				checks,
				stored: false,
			}
		}
		throw new GateError(
			'GATE_ALREADY_SET',
			'this subject already has a gate result with different inputs; evaluate the new stack as a new subject',
		)
	}

	const [row] = await sql<{ id: string }[]>`
		insert into gate_results (policy_id, subject_type, subject_id, input_hash, result, details, created_by)
		values (
			${policy.id}::uuid, ${input.subjectType}, ${input.subjectId}::uuid,
			${inputHash}, ${passed ? 'passed' : 'failed'},
			${sql.json({ checks, metrics, runIds: { retrieval: input.retrievalRunId, e2e: input.e2eRunId, comparison: input.comparisonId ?? null } } as never)}::jsonb,
			${principal.userId}::uuid)
		returning id`

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'gate.evaluated',
		entityType: 'gate_result',
		entityId: row.id,
		afterRef: {
			policyKey,
			policyVersion: policy.version,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			result: passed ? 'passed' : 'failed',
			inputHash,
		},
	})

	return {
		gateResultId: row.id,
		result: passed ? 'passed' : 'failed',
		inputHash,
		policyKey,
		policyVersion: policy.version,
		checks,
		stored: true,
	}
}

/** Override a failed gate — policy-gated, role-gated, audited. */
export async function overrideGateFailure(
	sql: Sql,
	principal: Principal,
	input: { gateResultId: string; reason: string },
): Promise<{ overridden: boolean; reason: string }> {
	const reason = input.reason?.trim() ?? ''
	if (reason.length < 16) {
		throw new GateError(
			'REASON_TOO_SHORT',
			'an override reason of at least 16 characters is required',
		)
	}
	if (!principal.permissions.includes('review:publish')) {
		throw new GateError('FORBIDDEN', 'override requires review:publish')
	}
	const [gate] = await sql<
		{ id: string; result: string; policy_id: string }[]
	>`select g.id, g.result, g.policy_id
		from gate_results g
		join gate_policies p on p.id = g.policy_id
		where g.id = ${input.gateResultId}::uuid`
	if (!gate) {
		// gate_results are global (RLS posture: platform release gates);
		// existence check without tenant scoping is intentional here
		throw new GateError('GATE_NOT_FOUND', 'gate result not found')
	}
	if (gate.result !== 'failed') {
		throw new GateError('NOT_FAILED', 'only failed gates can be overridden')
	}
	const [policy] = await sql<{ thresholds: GateThresholds }[]>`
		select thresholds from gate_policies where id = ${gate.policy_id}::uuid`
	if (policy?.thresholds?.allowOverride !== true) {
		throw new GateError(
			'OVERRIDE_NOT_ALLOWED',
			'this policy does not allow overrides',
		)
	}
	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'gate.override',
		entityType: 'gate_result',
		entityId: gate.id,
		reason,
		afterRef: { result: 'failed→passed (override)' },
	})
	return { overridden: true, reason }
}

/** Has a subject cleared its critical gate? (used by promotion paths) */
export async function gateClearance(
	sql: Sql | postgres.TransactionSql,
	principal: Principal,
	input: { policyKey?: string; subjectType: string; subjectId: string },
): Promise<{
	cleared: boolean
	reasonCode: string
	gateResultId: string | null
	result: string | null
}> {
	const policyKey = input.policyKey ?? 'launch_v1'
	const [row] = await sql<
		{ id: string; result: string; policy_key: string }[]
	>`select g.id, g.result, p.key as policy_key
		from gate_results g
		join gate_policies p on p.id = g.policy_id
		where p.key = ${policyKey}
			and g.subject_type = ${input.subjectType}
			and g.subject_id = ${input.subjectId}::uuid
		limit 1`
	if (!row) {
		return {
			cleared: false,
			reasonCode: 'NO_GATE_RESULT',
			gateResultId: null,
			result: null,
		}
	}
	if (row.result === 'passed') {
		return {
			cleared: true,
			reasonCode: 'OK',
			gateResultId: row.id,
			result: row.result,
		}
	}
	// a failed gate is cleared only by an audited override
	const overrides = await sql<{ id: string }[]>`
		select id from audit_events
		where action = 'gate.override' and entity_id = ${row.id}::text
		limit 1`
	if (overrides.length > 0) {
		return {
			cleared: true,
			reasonCode: 'OVERRIDDEN',
			gateResultId: row.id,
			result: row.result,
		}
	}
	return {
		cleared: false,
		reasonCode: 'GATE_FAILED',
		gateResultId: row.id,
		result: row.result,
	}
}

// ---------------------------------------------------------------------------
// Promotion gating (EVAL-007): knowledge/index/config alias promotion
// consults the stored gate results before moving production traffic.
//
// Enforcement posture:
//  - an EVALUATED FAILED gate (without an audited override) ALWAYS blocks
//    promotion, regardless of any flag — a recorded failure cannot be
//    sneaked past;
//  - full fail-closed enforcement (a MISSING gate also blocks) is rolled
//    out through the `eval_gate_enforced_promotion` feature flag so the
//    existing promotion flows keep working until the flag is enabled.
// ---------------------------------------------------------------------------

export const PROMOTION_GATE_FLAG = 'eval_gate_enforced_promotion'

export type PromotionSubjectType =
	| 'knowledge_release'
	| 'index_release'
	| 'config'

export class PromotionBlockedError extends Error {
	readonly reasonCode: string
	readonly gateResultId: string | null
	readonly reasons: ThresholdCheck[]

	constructor(
		reasonCode: string,
		reasons: ThresholdCheck[],
		gateResultId: string | null,
	) {
		super(`promotion blocked by critical release gate: ${reasonCode}`)
		this.name = 'PromotionBlockedError'
		this.reasonCode = reasonCode
		this.reasons = reasons
		this.gateResultId = gateResultId
	}
}

/** Is full fail-closed gate enforcement enabled for this principal? */
export async function isGateEnforced(
	sql: Sql,
	principal: Principal,
): Promise<boolean> {
	const effective = await evaluateFlags(sql, principal)
	return effective.flags[PROMOTION_GATE_FLAG] === true
}

/** An evaluated-and-failed (un-overridden) gate exists for the subject? */
export async function failedGateExists(
	sql: Sql | postgres.TransactionSql,
	subjectType: PromotionSubjectType,
	subjectId: string,
): Promise<boolean> {
	const rows = await sql<{ id: string }[]>`
		select g.id from gate_results g
		where g.subject_type = ${subjectType}
			and g.subject_id = ${subjectId}::uuid
			and g.result = 'failed'
			and not exists (
				select 1 from audit_events a
				where a.action = 'gate.override' and a.entity_id = g.id::text
			)
		limit 1`
	return rows.length > 0
}

/**
 * Assert the subject's critical gate is cleared before promotion.
 * Returns the gate result id on success; throws PromotionBlockedError
 * (with the failed threshold checks as reasons) otherwise.
 */
export async function assertPromotionGate(
	sql: Sql | postgres.TransactionSql,
	principal: Principal,
	input: {
		policyKey?: string
		subjectType: PromotionSubjectType
		subjectId: string
	},
): Promise<{ gateResultId: string; result: string }> {
	const clearance = await gateClearance(sql, principal, input)
	if (clearance.cleared && clearance.gateResultId) {
		return {
			gateResultId: clearance.gateResultId,
			result: clearance.result ?? 'passed',
		}
	}
	let reasons: ThresholdCheck[] = []
	if (clearance.gateResultId) {
		const [row] = await sql<{ details: { checks?: ThresholdCheck[] } }[]>`
			select details from gate_results where id = ${clearance.gateResultId}::uuid`
		reasons = row?.details?.checks ?? []
	}
	throw new PromotionBlockedError(
		clearance.reasonCode,
		reasons,
		clearance.gateResultId,
	)
}

/** Pin the clearing gate result onto the promoted release (artifact). */
export async function pinGateResult(
	sql: Sql | postgres.TransactionSql,
	subjectType: PromotionSubjectType,
	subjectId: string,
	gateResultId: string,
): Promise<void> {
	if (subjectType === 'knowledge_release') {
		await sql`update knowledge_releases set gate_result_id = ${gateResultId}::uuid
			where id = ${subjectId}::uuid`
	} else if (subjectType === 'index_release') {
		await sql`update index_releases set gate_result_id = ${gateResultId}::uuid
			where id = ${subjectId}::uuid`
	}
	// config subjects carry no artifact column; the gate_results row itself
	// is the audited artifact
}
