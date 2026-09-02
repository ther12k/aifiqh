import type { Principal } from '@aifiqh/shared'
import type postgres from 'postgres'
import type { Sql } from '../db/client'

/**
 * Unified operational status + failure taxonomy (OPS-001, DB-019).
 *
 * Builds on the append-only `service_health_events` /
 * `operation_failures` ledger. Guarantees:
 *  - every failure carries its PRIMARY SUBSYSTEM and reason (the code
 *    registry owns the subsystem; callers cannot mis-file a failure);
 *  - a component OUTAGE (health = unavailable) is categorically distinct
 *    from a DATA failure (recent critical operation failures while the
 *    component is up) — the status API reports both dimensions separately
 *    and derives one primary category;
 *  - STALE health is marked: a component whose newest health event is
 *    older than the freshness window never reads as healthy;
 *  - drill-down counts RECONCILE: the per-subsystem totals in the status
 *    payload are computed with the exact same visibility predicate and
 *    window as the failure list endpoint;
 *  - tenant SCOPES are enforced: a failure row whose entity_ref points
 *    at another tenant, or at a scope outside the caller's grants, is
 *    invisible in both status and drill-down.
 */

export const OPS_STATUS_VERSION = 'ops-status-v1'

/** health events older than this are stale (no heartbeat is not healthy) */
export const HEALTH_STALE_MS = 5 * 60_000
/** window over which data failures are aggregated */
export const FAILURE_WINDOW_MS = 24 * 60 * 60_000

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable'
export type FailureSeverity = 'info' | 'warning' | 'critical'

export type ComponentCategory =
	| 'healthy'
	| 'degraded'
	| 'outage'
	| 'data_failure'
	| 'stale'

export class OpsError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'OpsError'
		this.code = code
	}
}

/** runbook anchor for a failure code (rendered as a link in the panel) */
export function runbookFor(code: string, subsystem: string): string {
	return `/runbooks/${subsystem}#${code.toLowerCase().replace(/_/g, '-')}`
}

const HEALTH_STATUSES: readonly HealthStatus[] = [
	'healthy',
	'degraded',
	'unavailable',
]
const SEVERITIES: readonly FailureSeverity[] = ['info', 'warning', 'critical']

/** drill-down links for an entity_ref (only kinds with real GET routes) */
export function linksFor(
	traceId: string | null,
	entityRef: Record<string, unknown> | null,
): Array<{ kind: string; id: string; href: string }> {
	const links: Array<{ kind: string; id: string; href: string }> = []
	if (traceId) {
		links.push({
			kind: 'trace',
			id: traceId,
			href: `/retrieval/traces/${traceId}/inspector`,
		})
	}
	const ref = entityRef ?? {}
	const routes: Record<string, string> = {
		sourceId: '/sources',
		conceptId: '/knowledge/concepts',
		answerId: '/answers',
	}
	for (const [key, base] of Object.entries(routes)) {
		const id = ref[key]
		if (typeof id === 'string' && id.length > 0) {
			const suffix = key === 'answerId' ? '/graph' : ''
			links.push({
				kind: key.replace(/Id$/, ''),
				id,
				href: `${base}/${id}${suffix}`,
			})
		}
	}
	return links
}

export async function recordHealthEvent(
	sql: Sql,
	input: { componentKey: string; status: string; detail?: unknown },
): Promise<{ id: string; componentKey: string; status: HealthStatus }> {
	if (!HEALTH_STATUSES.includes(input.status as HealthStatus)) {
		throw new OpsError(
			'STATUS_INVALID',
			`health status must be one of ${HEALTH_STATUSES.join(', ')}`,
		)
	}
	const [component] = await sql<{ id: string }[]>`
		select id from service_components where key = ${input.componentKey}`
	if (!component) {
		throw new OpsError(
			'COMPONENT_UNKNOWN',
			`unknown component: ${input.componentKey}`,
		)
	}
	const [row] = await sql<{ id: string }[]>`
		insert into service_health_events (component_id, status, detail)
		values (${component.id}::uuid, ${input.status}, ${sql.json((input.detail ?? null) as never)}::jsonb)
		returning id`
	return {
		id: row.id,
		componentKey: input.componentKey,
		status: input.status as HealthStatus,
	}
}

export async function recordOperationFailure(
	sql: Sql,
	input: {
		componentKey: string
		failureCode: string
		severity: string
		message: string
		traceId?: string | null
		entityRef?: Record<string, unknown> | null
	},
): Promise<{
	id: string
	subsystem: string
	code: string
	severity: FailureSeverity
}> {
	if (!SEVERITIES.includes(input.severity as FailureSeverity)) {
		throw new OpsError(
			'SEVERITY_INVALID',
			`severity must be one of ${SEVERITIES.join(', ')}`,
		)
	}
	if (!input.message || input.message.trim().length === 0) {
		throw new OpsError('MESSAGE_REQUIRED', 'failure message is required')
	}
	const [component] = await sql<{ id: string }[]>`
		select id from service_components where key = ${input.componentKey}`
	if (!component) {
		throw new OpsError(
			'COMPONENT_UNKNOWN',
			`unknown component: ${input.componentKey}`,
		)
	}
	// the code registry owns the subsystem: callers cannot mis-file a failure
	const [code] = await sql<{ subsystem: string }[]>`
		select subsystem from operation_failure_codes where code = ${input.failureCode}`
	if (!code) {
		throw new OpsError(
			'FAILURE_CODE_UNKNOWN',
			`unknown failure code: ${input.failureCode}`,
		)
	}
	const ref = input.entityRef ?? null
	if (ref) {
		for (const key of ['tenantId', 'scopeId'] as const) {
			const v = ref[key]
			if (
				v !== undefined &&
				(typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v))
			) {
				throw new OpsError(
					'ENTITY_REF_INVALID',
					`entity_ref.${key} must be a uuid when present`,
				)
			}
		}
	}
	const [row] = await sql<{ id: string }[]>`
		insert into operation_failures
			(component_id, failure_code, severity, trace_id, entity_ref, message)
		values (
			${component.id}::uuid, ${input.failureCode}, ${input.severity},
			${input.traceId ?? null}, ${ref ? sql.json(ref as never) : null}::jsonb, ${input.message}
		)
		returning id`
	return {
		id: row.id,
		code: input.failureCode,
		subsystem: code.subsystem,
		severity: input.severity as FailureSeverity,
	}
}

export async function listFailureCodes(sql: Sql): Promise<
	Array<{
		code: string
		subsystem: string
		description: string
		runbook: string
	}>
> {
	const rows = await sql<
		{ code: string; subsystem: string; description: string }[]
	>`select code, subsystem, description from operation_failure_codes order by subsystem, code`
	return rows.map((r) => ({
		...r,
		runbook: runbookFor(r.code, r.subsystem),
	}))
}

/**
 * Visibility predicate (SQL fragment context): a failure row is visible to
 * the principal when it is platform-level (no tenant in entity_ref) or
 * belongs to the caller's tenant within the caller's scope grants.
 * UUIDs are compared as text so a malformed entity_ref can never throw.
 */
function visibilityPredicate(
	sql: Sql,
	principal: Principal,
): postgres.Fragment {
	return sql`(f.entity_ref->>'tenantId' is null
			or (f.entity_ref->>'tenantId' = ${principal.tenantId}
				and (f.entity_ref->>'scopeId' is null
					or f.entity_ref->>'scopeId' = any(${principal.scopes}::text[]))))`
}

export interface OpsPrimaryFailure {
	id: string
	code: string
	subsystem: string
	severity: FailureSeverity
	message: string
	traceId: string | null
	occurredAt: string
	runbook: string
	links: Array<{ kind: string; id: string; href: string }>
}

export interface OpsComponentStatus {
	key: string
	name: string
	kind: string
	health: {
		status: HealthStatus | 'unknown'
		lastEventAt: string | null
		stale: boolean
	}
	category: ComponentCategory
	dataFailureCounts: Record<FailureSeverity, number>
	/** most severe recent failure — the PRIMARY subsystem/reason for drill-down */
	primaryFailure: OpsPrimaryFailure | null
}

export interface OpsStatusReport {
	version: string
	generatedAt: string
	overall: {
		status: 'healthy' | 'degraded' | 'unavailable'
		category: ComponentCategory
		primarySubsystem: string | null
		guidance: string
		outageComponents: string[]
		dataFailureComponents: string[]
		staleComponents: string[]
	}
	components: OpsComponentStatus[]
	/** reconciles 1:1 with the drill-down list within the same window */
	failuresBySubsystem: Record<string, number>
	windowMs: number
}

const CATEGORY_RANK: Record<ComponentCategory, number> = {
	healthy: 0,
	degraded: 1,
	stale: 2,
	data_failure: 3,
	outage: 4,
}

const GUIDANCE: Record<ComponentCategory, string> = {
	healthy: 'Semua komponen sehat. Tidak ada tindakan.',
	degraded:
		'Komponen menurun: periksa detail komponen dan jalankan ulang pekerjaan yang gagal.',
	stale:
		'Health tidak diperbarui dalam batas waktu: verifikasi heartbeat/penjadwal worker sebelum menyimpulkan sehat.',
	data_failure:
		'Komponen hidup tetapi ada kegagalan data: telusuri failure utama ke trace/entitas terkait dan ikuti runbook.',
	outage:
		'Terjadi outage: komponen tidak tersedia. Prioritaskan pemulihan layar sebelum investigasi data.',
}

const SEVERITY_RANK: Record<FailureSeverity, number> = {
	critical: 0,
	warning: 1,
	info: 2,
}

export async function getOpsStatus(
	sql: Sql,
	principal: Principal,
	options: {
		now?: Date
		staleMs?: number
		failureWindowMs?: number
	} = {},
): Promise<OpsStatusReport> {
	const now = options.now ?? new Date()
	const staleMs = options.staleMs ?? HEALTH_STALE_MS
	const windowMs = options.failureWindowMs ?? FAILURE_WINDOW_MS
	const windowStart = new Date(now.getTime() - windowMs)

	const components = await sql<
		{ id: string; key: string; name: string; kind: string }[]
	>`select id, key, name, kind from service_components order by key`

	// latest health event per component
	const healthRows = await sql<
		{ component_id: string; status: HealthStatus; occurred_at: string }[]
	>`select distinct on (h.component_id) h.component_id, h.status, h.occurred_at
		from service_health_events h
		order by h.component_id, h.occurred_at desc`

	// visibility-filtered failure aggregates per component/severity/subsystem
	const visible = visibilityPredicate(sql, principal)
	const failureRows = await sql<
		{
			component_id: string
			severity: FailureSeverity
			subsystem: string
			n: string
		}[]
	>`select f.component_id, f.severity, c.subsystem, count(*) as n
		from operation_failures f
		join operation_failure_codes c on c.code = f.failure_code
		where f.occurred_at >= ${windowStart.toISOString()}
			and ${visible}
		group by f.component_id, f.severity, c.subsystem`

	// primary failure per component: most severe recent row
	const primaryRows = await sql<
		{
			id: string
			component_id: string
			code: string
			subsystem: string
			severity: FailureSeverity
			message: string
			trace_id: string | null
			entity_ref: Record<string, unknown> | null
			occurred_at: string
		}[]
	>`select distinct on (f.component_id)
			f.id, f.component_id, f.failure_code as code, c.subsystem,
			f.severity, f.message, f.trace_id, f.entity_ref, f.occurred_at
		from operation_failures f
		join operation_failure_codes c on c.code = f.failure_code
		where f.occurred_at >= ${windowStart.toISOString()}
			and ${visible}
		order by f.component_id,
			case f.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
			f.occurred_at desc`

	const healthByComponent = new Map(healthRows.map((h) => [h.component_id, h]))
	const primaryByComponent = new Map(
		primaryRows.map((p) => [p.component_id, p]),
	)

	const componentStatuses: OpsComponentStatus[] = components.map((c) => {
		const health = healthByComponent.get(c.id)
		const lastAt = health ? new Date(health.occurred_at) : null
		const stale = !lastAt || now.getTime() - lastAt.getTime() > staleMs
		const counts: Record<FailureSeverity, number> = {
			critical: 0,
			warning: 0,
			info: 0,
		}
		for (const row of failureRows) {
			if (row.component_id !== c.id) continue
			counts[row.severity] = (counts[row.severity] ?? 0) + Number(row.n)
		}

		let category: ComponentCategory
		const healthStatus = health?.status ?? 'unknown'
		if (healthStatus === 'unavailable') category = 'outage'
		else if (stale) category = 'stale'
		else if (counts.critical > 0) category = 'data_failure'
		else if (healthStatus === 'degraded') category = 'degraded'
		else category = 'healthy'

		const primary = primaryByComponent.get(c.id)
		return {
			key: c.key,
			name: c.name,
			kind: c.kind,
			health: {
				status: healthStatus,
				lastEventAt: health ? new Date(health.occurred_at).toISOString() : null,
				stale,
			},
			category,
			dataFailureCounts: counts,
			primaryFailure: primary
				? {
						id: primary.id,
						code: primary.code,
						subsystem: primary.subsystem,
						severity: primary.severity,
						message: primary.message,
						traceId: primary.trace_id,
						occurredAt: new Date(primary.occurred_at).toISOString(),
						runbook: runbookFor(primary.code, primary.subsystem),
						links: linksFor(primary.trace_id, primary.entity_ref),
					}
				: null,
		}
	})

	// subsystem totals over the SAME visibility predicate and window —
	// reconciles 1:1 with listOperationFailures rows
	const subsystemRows = await sql<
		{ subsystem: string; n: string }[]
	>`select c.subsystem, count(*) as n
		from operation_failures f
		join operation_failure_codes c on c.code = f.failure_code
		where f.occurred_at >= ${windowStart.toISOString()}
			and ${visibilityPredicate(sql, principal)}
		group by c.subsystem`
	const failuresBySubsystem: Record<string, number> = {}
	for (const r of subsystemRows) failuresBySubsystem[r.subsystem] = Number(r.n)

	const outageComponents = componentStatuses
		.filter((c) => c.category === 'outage')
		.map((c) => c.key)
	const dataFailureComponents = componentStatuses
		.filter((c) => c.category === 'data_failure')
		.map((c) => c.key)
	const staleComponents = componentStatuses
		.filter((c) => c.category === 'stale')
		.map((c) => c.key)

	const overallCategory = componentStatuses.reduce<ComponentCategory>(
		(worst, c) =>
			CATEGORY_RANK[c.category] > CATEGORY_RANK[worst] ? c.category : worst,
		'healthy',
	)
	const primaryFailureOverall = componentStatuses
		.map((c) => c.primaryFailure)
		.filter((f): f is OpsPrimaryFailure => f !== null)
		.sort(
			(a, b) =>
				SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
				b.occurredAt.localeCompare(a.occurredAt),
		)[0]

	const overallHttp =
		outageComponents.length > 0
			? 'unavailable'
			: outageComponents.length +
						dataFailureComponents.length +
						staleComponents.length >
						0 || componentStatuses.some((c) => c.category === 'degraded')
				? 'degraded'
				: 'healthy'

	return {
		version: OPS_STATUS_VERSION,
		generatedAt: now.toISOString(),
		overall: {
			status: overallHttp,
			category: overallCategory,
			primarySubsystem: primaryFailureOverall?.subsystem ?? null,
			guidance: GUIDANCE[overallCategory],
			outageComponents,
			dataFailureComponents,
			staleComponents,
		},
		components: componentStatuses,
		failuresBySubsystem,
		windowMs,
	}
}

export interface OpsFailureRow extends OpsPrimaryFailure {
	componentKey: string
	entityRef: Record<string, unknown> | null
}

export async function listOperationFailures(
	sql: Sql,
	principal: Principal,
	filters: {
		subsystem?: string
		severity?: string
		component?: string
		limit?: number
		offset?: number
	} = {},
	options: { now?: Date; failureWindowMs?: number } = {},
): Promise<{
	version: string
	failures: OpsFailureRow[]
	pagination: { limit: number; offset: number; total: number }
}> {
	const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
	const offset = Math.max(filters.offset ?? 0, 0)
	const now = options.now ?? new Date()
	const windowMs = options.failureWindowMs ?? FAILURE_WINDOW_MS
	const windowStart = new Date(now.getTime() - windowMs)
	if (
		filters.severity !== undefined &&
		!SEVERITIES.includes(filters.severity as FailureSeverity)
	) {
		throw new OpsError(
			'SEVERITY_INVALID',
			`unknown severity: ${filters.severity}`,
		)
	}
	// filters compose as conditional fragments (empty fragment = skipped)
	const subsystemF = filters.subsystem
		? sql` and c.subsystem = ${filters.subsystem}`
		: sql``
	const severityF = filters.severity
		? sql` and f.severity = ${filters.severity}`
		: sql``
	const componentF = filters.component
		? sql` and sc.key = ${filters.component}`
		: sql``
	const visible = visibilityPredicate(sql, principal)

	const rows = await sql<
		{
			id: string
			component_key: string
			code: string
			subsystem: string
			severity: FailureSeverity
			message: string
			trace_id: string | null
			entity_ref: Record<string, unknown> | null
			occurred_at: string
		}[]
	>`select f.id, sc.key as component_key, f.failure_code as code, c.subsystem,
			f.severity, f.message, f.trace_id, f.entity_ref, f.occurred_at
		from operation_failures f
		join operation_failure_codes c on c.code = f.failure_code
		join service_components sc on sc.id = f.component_id
		where f.occurred_at >= ${windowStart.toISOString()}
			${subsystemF}${severityF}${componentF} and ${visible}
		order by f.occurred_at desc
		limit ${limit} offset ${offset}`

	const [totalRow] = await sql<{ n: string }[]>`
		select count(*) as n
		from operation_failures f
		join operation_failure_codes c on c.code = f.failure_code
		join service_components sc on sc.id = f.component_id
		where f.occurred_at >= ${windowStart.toISOString()}
			${subsystemF}${severityF}${componentF} and ${visible}`

	return {
		version: OPS_STATUS_VERSION,
		failures: rows.map((r) => ({
			id: r.id,
			componentKey: r.component_key,
			code: r.code,
			subsystem: r.subsystem,
			severity: r.severity,
			message: r.message,
			traceId: r.trace_id,
			entityRef: r.entity_ref,
			occurredAt: new Date(r.occurred_at).toISOString(),
			runbook: runbookFor(r.code, r.subsystem),
			links: linksFor(r.trace_id, r.entity_ref),
		})),
		pagination: { limit, offset, total: Number(totalRow.n) },
	}
}
