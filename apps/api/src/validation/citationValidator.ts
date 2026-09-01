import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Citation reference validation (VAL-001).
 *
 * A citation is only as good as the canonical location it points at.
 * Every draft citation is resolved against the source registry:
 *
 *  - a missing or mismatched source/revision/span/page/section reference
 *    is a CRITICAL issue (critical issues block publishing via the
 *    guard_answer_publish trigger — no broken citation ever publishes);
 *  - a DEPRECATED historical revision still resolves: the citation is
 *    valid but labeled (minor issue, disclosed) rather than rejected;
 *  - a citation may never point ONLY at a retrieval unit — retrieval
 *    units are derived projections; the canonical span is the evidence
 *    identity. Draft citations without a span are critical.
 *
 * Issues are persisted through validation_runs/validation_issues so the
 * publish gate, repair (VAL-005) and audits read the same truth.
 */

export const CITATION_VALIDATOR_VERSION = 'citation-validator-v1'

export type IssueSeverity = 'critical' | 'major' | 'minor'

export interface CitationIssue {
	ordinal: number
	severity: IssueSeverity
	code: string
	location: string
	detail: string
}

export interface DraftCitation {
	ordinal: number
	sourceId: string | null
	sourceRevisionId: string | null
	pageId?: string | null
	sectionId?: string | null
	spanId: string | null
	/** retrieval unit id offered as evidence — never sufficient alone */
	retrievalUnitId?: string | null
}

export interface CitationValidationResult {
	issues: CitationIssue[]
	hasCritical: boolean
	validCount: number
	validatorVersion: string
}

/** Resolve one draft citation against the canonical source registry. */
export async function validateCitationRefs(
	sql: Sql,
	principal: Principal,
	draft: DraftCitation,
): Promise<CitationIssue[]> {
	const issues: CitationIssue[] = []
	const at = (
		code: string,
		location: string,
		detail: string,
		severity: IssueSeverity = 'critical',
	) => issues.push({ ordinal: draft.ordinal, severity, code, location, detail })

	// a citation that points only at a retrieval unit is never acceptable:
	// retrieval units are derived; the span is the canonical evidence id
	if (!draft.spanId) {
		at(
			'CITATION_UNIT_ONLY',
			'spanId',
			draft.retrievalUnitId
				? `retrieval unit ${draft.retrievalUnitId} cited without a canonical span`
				: 'no canonical span referenced',
		)
		return issues
	}
	if (!draft.sourceId) at('SOURCE_MISSING', 'sourceId', 'sourceId is required')
	if (!draft.sourceRevisionId)
		at('REVISION_MISSING', 'sourceRevisionId', 'sourceRevisionId is required')
	if (issues.some((i) => i.severity === 'critical')) return issues

	// ---- source exists in tenant ----
	const [source] = await sql<{ id: string }[]>`
		select id from sources
		where id = ${draft.sourceId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!source) {
		at(
			'SOURCE_NOT_FOUND',
			'sourceId',
			`source ${draft.sourceId} not found in tenant`,
		)
		return issues
	}

	// ---- revision belongs to the source ----
	const [revision] = await sql<
		{ id: string; source_id: string; status: string }[]
	>`
		select id, source_id, status from source_revisions
		where id = ${draft.sourceRevisionId}::uuid`
	if (!revision) {
		at(
			'REVISION_NOT_FOUND',
			'sourceRevisionId',
			`revision ${draft.sourceRevisionId} not found`,
		)
	} else if (revision.source_id !== draft.sourceId) {
		at(
			'REVISION_MISMATCH',
			'sourceRevisionId',
			`revision ${draft.sourceRevisionId} belongs to source ${revision.source_id}, cited as ${draft.sourceId}`,
		)
	} else if (revision.status === 'deprecated') {
		// historical revision: resolves, but the citation is labeled so
		// readers see they are looking at superseded text
		at(
			'DEPRECATED_REVISION',
			'sourceRevisionId',
			'citation resolves to a deprecated historical revision (labeled, not rejected)',
			'minor',
		)
	}

	// ---- span belongs to the cited revision ----
	const [span] = await sql<{ id: string; source_revision_id: string }[]>`
		select id, source_revision_id from source_spans
		where id = ${draft.spanId}::uuid`
	if (!span) {
		at('SPAN_NOT_FOUND', 'spanId', `span ${draft.spanId} not found`)
	} else if (span.source_revision_id !== draft.sourceRevisionId) {
		at(
			'SPAN_REVISION_MISMATCH',
			'spanId',
			`span ${draft.spanId} belongs to revision ${span.source_revision_id}, cited under ${draft.sourceRevisionId}`,
		)
	}

	// ---- optional page/section must match the same revision ----
	if (draft.pageId) {
		const [page] = await sql<{ id: string; source_revision_id: string }[]>`
			select id, source_revision_id from source_pages
			where id = ${draft.pageId}::uuid`
		if (!page) {
			at('PAGE_NOT_FOUND', 'pageId', `page ${draft.pageId} not found`)
		} else if (page.source_revision_id !== draft.sourceRevisionId) {
			at(
				'PAGE_REVISION_MISMATCH',
				'pageId',
				`page ${draft.pageId} belongs to revision ${page.source_revision_id}, cited under ${draft.sourceRevisionId}`,
			)
		}
	}
	if (draft.sectionId) {
		const [section] = await sql<{ id: string; source_revision_id: string }[]>`
			select id, source_revision_id from source_sections
			where id = ${draft.sectionId}::uuid`
		if (!section) {
			at(
				'SECTION_NOT_FOUND',
				'sectionId',
				`section ${draft.sectionId} not found`,
			)
		} else if (section.source_revision_id !== draft.sourceRevisionId) {
			at(
				'SECTION_REVISION_MISMATCH',
				'sectionId',
				`section ${draft.sectionId} belongs to revision ${section.source_revision_id}, cited under ${draft.sourceRevisionId}`,
			)
		}
	}

	// ---- when a retrieval unit is offered, it must agree with the span ----
	if (draft.retrievalUnitId) {
		const [unit] = await sql<{ id: string; source_span_id: string | null }[]>`
			select id, source_span_id from retrieval_units
			where id = ${draft.retrievalUnitId}::uuid and tenant_id = ${principal.tenantId}::uuid`
		if (!unit) {
			at(
				'UNIT_NOT_FOUND',
				'retrievalUnitId',
				`retrieval unit ${draft.retrievalUnitId} not found`,
			)
		} else if (unit.source_span_id !== draft.spanId) {
			at(
				'UNIT_SPAN_MISMATCH',
				'retrievalUnitId',
				`retrieval unit ${draft.retrievalUnitId} points at span ${unit.source_span_id}, cited span is ${draft.spanId}`,
			)
		}
	}

	return issues
}

/** Validate every draft citation; criticals aggregate for the publish gate. */
export async function validateAnswerCitations(
	sql: Sql,
	principal: Principal,
	drafts: DraftCitation[],
): Promise<CitationValidationResult> {
	const issues: CitationIssue[] = []
	for (const draft of drafts) {
		issues.push(...(await validateCitationRefs(sql, principal, draft)))
	}
	return {
		issues,
		hasCritical: issues.some((i) => i.severity === 'critical'),
		validCount:
			drafts.length -
			new Set(
				issues.filter((i) => i.severity === 'critical').map((i) => i.ordinal),
			).size,
		validatorVersion: CITATION_VALIDATOR_VERSION,
	}
}

/** Persist the run + issues so the DB publish gate sees them. */
export async function storeValidationRun(
	sql: Sql,
	answerId: string,
	result: CitationValidationResult,
): Promise<string> {
	return await sql.begin(async (tx) => {
		const [run] = await tx<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, result, finished_at)
			values (
				${answerId}::uuid,
				${result.validatorVersion},
				${tx.json({
					hasCritical: result.hasCritical,
					validCount: result.validCount,
					issueCount: result.issues.length,
				} as never)},
				now()
			)
			returning id`
		for (const issue of result.issues) {
			await tx`
				insert into validation_issues (run_id, severity, code, location, detail)
				values (
					${run.id}::uuid, ${issue.severity}, ${issue.code},
					${`citation[${issue.ordinal}].${issue.location}`},
					${tx.json({ detail: issue.detail, ordinal: issue.ordinal } as never)}
				)`
		}
		return run.id
	})
}
