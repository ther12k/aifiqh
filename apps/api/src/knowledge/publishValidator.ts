import type { Principal } from '@aifiqh/shared'
import { validateConceptFields } from '@aifiqh/shared'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationFinding {
	/** machine-readable, versioned code */
	code: string
	severity: ValidationSeverity
	/** human-readable location: concept / revision / field / relationship / span */
	location: string
	conceptId?: string
	revisionId?: string
	field?: string
	relationshipId?: string
	spanLinkId?: string
	message: string
}

export interface ValidationReport {
	subject: { conceptId: string; revisionId: string }
	/** validator policy version — bump when warning policy changes */
	validatorVersion: string
	ok: boolean
	errors: ValidationFinding[]
	warnings: ValidationFinding[]
}

export const PUBLISH_VALIDATOR_VERSION = 'publish-validator-v1'

const FIELD_TO_COLUMN: Record<string, string> = {
	title: 'title',
	bodyMarkdown: 'body_markdown',
	language: 'language',
	madhhab: 'madhhab',
}

/**
 * Deterministic publish-time validator (KNW-006). Composes:
 *  - required-field profile checks (KNW-002)
 *  - provenance presence (KNW-004)
 *  - review/verification status
 *  - active-link target validity incl. reverse (broken links)
 *  - concept↔source-span pinning with quotation text
 *  - access-scope reachability for the acting principal
 * Identical input yields an identical report (stable ordering, no timestamps).
 */
export async function validateForPublish(
	sql: Sql,
	principal: Principal,
	conceptId: string,
	revisionId: string,
): Promise<ValidationReport> {
	const errors: ValidationFinding[] = []
	const warnings: ValidationFinding[] = []
	const add = (f: ValidationFinding) =>
		f.severity === 'error' ? errors.push(f) : warnings.push(f)

	const [rev] = await sql<
		{
			concept_id: string
			revision_number: number
			title: string
			body_markdown: string
			language: string
			madhhab: string[]
			type_key: string
			lifecycle_status: string
			access_scope_id: string
		}[]
	>`select r.concept_id, r.revision_number, r.title, r.body_markdown, r.language,
			r.madhhab, c.type_key, r.lifecycle_status, c.access_scope_id
		from knowledge_concept_revisions r
		join knowledge_concepts c on c.id = r.concept_id
		where r.id = ${revisionId}::uuid
			and r.concept_id = ${conceptId}::uuid
			and c.tenant_id = ${principal.tenantId}::uuid
		limit 1`

	if (!rev) {
		// nothing to validate: single blocking finding, deterministic
		return {
			subject: { conceptId, revisionId },
			validatorVersion: PUBLISH_VALIDATOR_VERSION,
			ok: false,
			errors: [
				{
					code: 'SUBJECT_NOT_FOUND',
					severity: 'error',
					location: 'concept',
					conceptId,
					revisionId,
					message: 'Concept revision does not exist in this tenant',
				},
			],
			warnings: [],
		}
	}

	const loc = (field?: string) =>
		`concept/${conceptId}/revision/${rev.revision_number}${field ? `/field/${field}` : ''}`

	// 1. lifecycle: only drafts (or rejected → resubmitted as new draft) may publish
	if (rev.lifecycle_status !== 'draft') {
		add({
			code: 'LIFECYCLE_NOT_DRAFT',
			severity: 'error',
			location: loc(),
			conceptId,
			revisionId,
			message: `Revision lifecycle is '${rev.lifecycle_status}', expected 'draft'`,
		})
	}

	// 2. required-field profile (KNW-002)
	const profile = validateConceptFields(rev.type_key as never, {
		title: rev.title,
		bodyMarkdown: rev.body_markdown,
		language: rev.language,
		madhhab: rev.madhhab,
	})
	for (const field of profile.missingFields) {
		add({
			code: 'REQUIRED_FIELD_MISSING',
			severity: 'error',
			location: loc(field),
			conceptId,
			revisionId,
			field,
			message: `Concept type '${rev.type_key}' requires field '${field}'`,
		})
	}

	// 3. provenance present (KNW-004)
	const [provenance] = await sql<{ id: string }[]>`
		select id from knowledge_revision_provenance
		where revision_id = ${revisionId}::uuid limit 1`
	if (!provenance) {
		add({
			code: 'PROVENANCE_MISSING',
			severity: 'error',
			location: loc('provenance'),
			conceptId,
			revisionId,
			field: 'provenance',
			message: 'Revision has no generation provenance record',
		})
	}

	// 4. human verification approved (KNW-004)
	const [approval] = await sql<{ id: string }[]>`
		select id from knowledge_verifications
		where revision_id = ${revisionId}::uuid and verdict = 'approved'
		order by verified_at desc limit 1`
	if (!approval) {
		add({
			code: 'VERIFICATION_MISSING',
			severity: 'error',
			location: loc('verification'),
			conceptId,
			revisionId,
			field: 'verification',
			message: 'Revision has no approved verification',
		})
	}

	// 5. active links must resolve to real targets (broken-link check, KNW-005)
	const links = await sql<
		{
			id: string
			relationship_type: string
			to_concept_id: string | null
			to_revision_id: string | null
			target_exists: boolean
		}[]
	>`select l.id, l.relationship_type, l.to_concept_id, l.to_revision_id,
			(l.to_concept_id is not null and exists (
				select 1 from knowledge_concepts tc where tc.id = l.to_concept_id))
			or (l.to_revision_id is not null and exists (
				select 1 from knowledge_concept_revisions tr where tr.id = l.to_revision_id))
			as target_exists
		from knowledge_links l
		where l.from_revision_id = ${revisionId}::uuid and l.active`

	for (const link of links) {
		if (!link.target_exists) {
			add({
				code: 'LINK_TARGET_BROKEN',
				severity: 'error',
				location: `concept/${conceptId}/relationship/${link.id}`,
				conceptId,
				revisionId,
				relationshipId: link.id,
				message: `Active '${link.relationship_type}' link points at a missing target`,
			})
		}
	}

	// 6. evidence pinning: at least one source-span link with quotation
	const spanLinks = await sql<
		{
			id: string
			source_span_id: string
			span_exists: boolean
			quotation_text: string | null
			source_revision_id: string
			revision_status: string
		}[]
	>`select css.id, css.source_span_id, css.quotation_text, css.source_revision_id,
			exists (select 1 from source_spans ss where ss.id = css.source_span_id) as span_exists,
			sr.status as revision_status
		from concept_source_spans css
		join source_revisions sr on sr.id = css.source_revision_id
		where css.revision_id = ${revisionId}::uuid`

	for (const span of spanLinks) {
		if (!span.span_exists) {
			add({
				code: 'SPAN_LINK_BROKEN',
				severity: 'error',
				location: `concept/${conceptId}/span/${span.id}`,
				conceptId,
				revisionId,
				spanLinkId: span.id,
				message: 'Source-span pin points at a missing span',
			})
			continue
		}
		// evidence must come from a resolvable (non-deprecated) revision
		if (span.revision_status === 'deprecated') {
			add({
				code: 'SPAN_SOURCE_DEPRECATED',
				severity: 'warning',
				location: `concept/${conceptId}/span/${span.id}`,
				conceptId,
				revisionId,
				spanLinkId: span.id,
				message:
					'Pinned source revision is deprecated; consider re-pinning to its replacement',
			})
		}
		if (!span.quotation_text?.trim()) {
			add({
				code: 'SPAN_QUOTATION_MISSING',
				severity: 'warning',
				location: `concept/${conceptId}/span/${span.id}`,
				conceptId,
				revisionId,
				spanLinkId: span.id,
				message: 'Span link has no quotation text to verify against the source',
			})
		}
	}

	// 7. acting principal must be able to read the concept's scope (publish path sanity)
	const scopeDecision = await checkAccess(
		sql,
		principal,
		'knowledge:read',
		rev.access_scope_id,
	)
	if (!scopeDecision.allowed) {
		add({
			code: 'SCOPE_UNREACHABLE',
			severity: 'error',
			location: loc('accessScope'),
			conceptId,
			revisionId,
			field: 'accessScope',
			message: `Acting principal cannot reach the concept's access scope (${scopeDecision.reasonCode})`,
		})
	}

	// stable order: by code then location, so identical input → identical report
	const byStableOrder = (a: ValidationFinding, b: ValidationFinding) =>
		a.code === b.code
			? a.location.localeCompare(b.location)
			: a.code.localeCompare(b.code)
	errors.sort(byStableOrder)
	warnings.sort(byStableOrder)

	return {
		subject: { conceptId, revisionId },
		validatorVersion: PUBLISH_VALIDATOR_VERSION,
		ok: errors.length === 0,
		errors,
		warnings,
	}
}
