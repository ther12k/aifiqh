/**
 * Ops status view logic (OPS-001): the operator panel model built from
 * the /ops/status and /ops/failures payloads. Pure — no framework code.
 *
 *  - the overall banner keeps OUTAGE and DATA FAILURE distinct and names
 *    the primary subsystem;
 *  - stale health is surfaced as its own state, never as healthy;
 *  - drill-down filters (subsystem/severity) are pure functions so the
 *    panel and tests agree on exactly what is shown;
 *  - every failure row carries its runbook anchor and record links.
 */

export interface OpsOverallLike {
	status: 'healthy' | 'degraded' | 'unavailable'
	category: string
	primarySubsystem: string | null
	guidance: string
	outageComponents: string[]
	dataFailureComponents: string[]
	staleComponents: string[]
}

export interface OpsComponentLike {
	key: string
	name: string
	kind: string
	health: {
		status: string
		lastEventAt: string | null
		stale: boolean
	}
	category: string
	dataFailureCounts: { critical: number; warning: number; info: number }
	primaryFailure: OpsPrimaryFailureLike | null
}

export interface OpsPrimaryFailureLike {
	id: string
	code: string
	subsystem: string
	severity: string
	message: string
	traceId: string | null
	occurredAt: string
	runbook: string
	links: Array<{ kind: string; id: string; href: string }>
}

export interface OpsStatusPayloadLike {
	version: string
	generatedAt: string
	overall: OpsOverallLike
	components: OpsComponentLike[]
	failuresBySubsystem: Record<string, number>
}

export interface OpsFailureLike {
	id: string
	componentKey: string
	code: string
	subsystem: string
	severity: string
	message: string
	traceId: string | null
	occurredAt: string
	runbook: string
	links: Array<{ kind: string; id: string; href: string }>
}

const CATEGORY_LABELS: Record<string, string> = {
	healthy: 'sehat',
	degraded: 'menurun',
	outage: 'OUTAGE',
	data_failure: 'KEGAGALAN DATA',
	stale: 'health basi',
}

const SEVERITY_LABELS: Record<string, string> = {
	critical: 'kritis',
	warning: 'peringatan',
	info: 'info',
}

const LINK_LABELS: Record<string, string> = {
	trace: 'Inspektur trace',
	source: 'Sumber',
	concept: 'Konsep',
	answer: 'Jawaban',
}

export function categoryLabel(category: string): string {
	return CATEGORY_LABELS[category] ?? category
}

export function severityLabel(severity: string): string {
	return SEVERITY_LABELS[severity] ?? severity
}

export interface OverallBanner {
	tone: 'healthy' | 'warning' | 'critical'
	title: string
	detail: string
}

export function deriveOverallBanner(overall: OpsOverallLike): OverallBanner {
	if (overall.category === 'outage') {
		return {
			tone: 'critical',
			title: `OUTAGE: ${overall.outageComponents.join(', ')}`,
			detail: overall.guidance,
		}
	}
	if (overall.category === 'data_failure') {
		const subsystem = overall.primarySubsystem ?? 'tidak diketahui'
		return {
			tone: 'critical',
			title: `Kegagalan data pada subsistem ${subsystem}`,
			detail: overall.guidance,
		}
	}
	if (overall.status === 'degraded') {
		return {
			tone: 'warning',
			title: 'Layanan menurun',
			detail: overall.guidance,
		}
	}
	return {
		tone: 'healthy',
		title: 'Semua komponen sehat',
		detail: overall.guidance,
	}
}

export interface ComponentView {
	key: string
	name: string
	kind: string
	/** one-line operator summary: health, stale marker and category */
	line: string
	category: string
	stale: boolean
	primaryFailure: OpsPrimaryFailureLike | null
}

export function buildComponentViews(
	components: OpsComponentLike[],
): ComponentView[] {
	return components.map((c) => {
		const health = c.health.stale
			? `${c.health.status} (basi)`
			: c.health.status
		const failures = c.dataFailureCounts
		const failureBits: string[] = []
		if (failures.critical > 0) failureBits.push(`${failures.critical} kritis`)
		if (failures.warning > 0) failureBits.push(`${failures.warning} peringatan`)
		if (failures.info > 0) failureBits.push(`${failures.info} info`)
		const line = `${health} · ${categoryLabel(c.category)}${
			failureBits.length > 0 ? ` · ${failureBits.join(', ')}` : ''
		}`
		return {
			key: c.key,
			name: c.name,
			kind: c.kind,
			line,
			category: c.category,
			stale: c.health.stale,
			primaryFailure: c.primaryFailure,
		}
	})
}

export interface FailureFilter {
	subsystem?: string
	severity?: string
}

export function filterFailures(
	failures: OpsFailureLike[],
	filter: FailureFilter,
): OpsFailureLike[] {
	return failures.filter(
		(f) =>
			(!filter.subsystem || f.subsystem === filter.subsystem) &&
			(!filter.severity || f.severity === filter.severity),
	)
}

export function linkLabel(kind: string): string {
	return LINK_LABELS[kind] ?? kind
}
