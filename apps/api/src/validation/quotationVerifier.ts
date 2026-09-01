import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'

/**
 * Exact quotation verification against canonical source text (VAL-002).
 *
 * A quotation is a verbatim (or controlled-normalized) rendering of the
 * canonical span text — nothing fuzzier:
 *
 *  - exact:      the quote appears verbatim in the span's original text
 *                (recorded as quote_match_status='exact');
 *  - normalized: the quote matches after the controlled normalization
 *                profile only (tashkeel/tatweel removal, whitespace
 *                collapse) — labeled with the transformation list, never
 *                presented as verbatim;
 *  - mismatch:   everything else. A PARAPHRASE can never be a quotation:
 *                there is no fuzzy/threshold fallback, so a same-meaning
 *                rewording lands here and must be re-labeled as a
 *                paraphrase/synthesis claim or removed (VAL-005).
 *
 * Mismatches persist as unresolved critical validation issues, blocking
 * publication until repaired or the citation is removed.
 */

export const QUOTATION_VERIFIER_VERSION = 'quotation-verifier-v1'

export type QuoteMatchStatus = 'exact' | 'normalized' | 'mismatch'

export interface QuotationCheck {
	ordinal: number
	spanId: string
	quote: string
	status: QuoteMatchStatus
	/** canonical text the normalized match was found in (normalized runs) */
	matchedAgainst?: string
	transformations: string[]
	detail: string
}

export interface QuotationIssue {
	ordinal: number
	severity: 'critical' | 'minor'
	code: string
	location: string
	detail: string
}

export interface QuotationVerificationResult {
	checks: QuotationCheck[]
	issues: QuotationIssue[]
	hasCritical: boolean
	verifierVersion: string
}

const MIN_QUOTE_LENGTH = 3

export async function verifyQuotation(
	sql: Sql,
	principal: Principal,
	ordinal: number,
	spanId: string,
	quote: string,
): Promise<QuotationCheck> {
	const [span] = await sql<{ original_text: string }[]>`
		select ss.original_text
		from source_spans ss
		join source_revisions sr on sr.id = ss.source_revision_id
		join sources s on s.id = sr.source_id
		where ss.id = ${spanId}::uuid
			and s.tenant_id = ${principal.tenantId}::uuid`
	if (!span) {
		return {
			ordinal,
			spanId,
			quote,
			status: 'mismatch',
			transformations: [],
			detail: 'span not found in tenant — quotation unverifiable',
		}
	}

	const trimmed = quote.trim()
	if (trimmed.length < MIN_QUOTE_LENGTH) {
		return {
			ordinal,
			spanId,
			quote,
			status: 'mismatch',
			transformations: [],
			detail: `quotation shorter than ${MIN_QUOTE_LENGTH} characters cannot be verified`,
		}
	}

	// 1) verbatim in the ORIGINAL canonical text
	if (span.original_text.includes(trimmed)) {
		return {
			ordinal,
			spanId,
			quote,
			status: 'exact',
			transformations: [],
			detail: 'verbatim match in canonical original text',
		}
	}

	// 2) controlled normalization only — the same profile the retrieval
	// lanes use (query-norm-v1): tashkeel/tatweel removal + whitespace.
	// Exact already failed above, so any hit here means normalization
	// bridged the gap (on the original's side, the quote's, or both).
	const normalizedOriginal = normalizeText(span.original_text)
	const normalizedQuote = normalizeText(trimmed)
	if (normalizedOriginal.includes(normalizedQuote)) {
		return {
			ordinal,
			spanId,
			quote,
			status: 'normalized',
			matchedAgainst: normalizedOriginal,
			transformations: [
				'tashkeel_removed',
				'tatweel_removed',
				'whitespace_collapsed',
			],
			detail:
				'match only after controlled normalization (query-norm-v1); labeled, not verbatim',
		}
	}

	// 3) paraphrase or wrong text: a paraphrase is NEVER a quotation
	return {
		ordinal,
		spanId,
		quote,
		status: 'mismatch',
		transformations: [],
		detail:
			'no exact or controlled-normalized match — paraphrase cannot be a quotation; repair as paraphrase/synthesis or remove',
	}
}

export async function verifyAnswerQuotations(
	sql: Sql,
	principal: Principal,
	citations: Array<{ ordinal: number; spanId: string; quote: string }>,
): Promise<QuotationVerificationResult> {
	const checks: QuotationCheck[] = []
	const issues: QuotationIssue[] = []
	for (const c of citations) {
		const check = await verifyQuotation(
			sql,
			principal,
			c.ordinal,
			c.spanId,
			c.quote,
		)
		checks.push(check)
		if (check.status === 'mismatch') {
			issues.push({
				ordinal: c.ordinal,
				severity: 'critical',
				code: 'QUOTATION_MISMATCH',
				location: `citation[${c.ordinal}].quote`,
				detail: check.detail,
			})
		} else if (check.status === 'normalized') {
			issues.push({
				ordinal: c.ordinal,
				severity: 'minor',
				code: 'QUOTATION_NORMALIZED',
				location: `citation[${c.ordinal}].quote`,
				detail: check.detail,
			})
		}
	}
	return {
		checks,
		issues,
		hasCritical: issues.some((i) => i.severity === 'critical'),
		verifierVersion: QUOTATION_VERIFIER_VERSION,
	}
}

/**
 * Persist match statuses on the citation rows and the labeled/critical
 * issues through validation_runs — the publish gate reads the criticals.
 */
export async function persistQuotationVerification(
	sql: Sql,
	answerId: string,
	result: QuotationVerificationResult,
): Promise<string> {
	return await sql.begin(async (tx) => {
		for (const check of result.checks) {
			await tx`
				update citations set quote_match_status = ${check.status}
				where answer_id = ${answerId}::uuid and ordinal = ${check.ordinal}`
		}
		const [run] = await tx<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, result, finished_at)
			values (
				${answerId}::uuid,
				${result.verifierVersion},
				${tx.json({
					hasCritical: result.hasCritical,
					checks: result.checks.length,
					exact: result.checks.filter((c) => c.status === 'exact').length,
					normalized: result.checks.filter((c) => c.status === 'normalized')
						.length,
					mismatch: result.checks.filter((c) => c.status === 'mismatch').length,
				} as never)},
				now()
			)
			returning id`
		for (const issue of result.issues) {
			await tx`
				insert into validation_issues (run_id, severity, code, location, detail)
				values (
					${run.id}::uuid, ${issue.severity}, ${issue.code},
					${issue.location},
					${tx.json({ detail: issue.detail, ordinal: issue.ordinal } as never)}
				)`
		}
		return run.id
	})
}
