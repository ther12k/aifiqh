import type { StructuredAnswer } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Material-claim support validation (VAL-003).
 *
 * Runtime gate over a structured answer (LLM-004 schema) against the set
 * of evidence ids actually selected for the answer:
 *
 *  - every material claim maps to at least one evidence link
 *    (UNSUPPORTED_MATERIAL_CLAIM, critical);
 *  - evidence ids outside the selected set are rejected — unknown ids and
 *    unselected-but-existing ids alike (EVIDENCE_NOT_SELECTED, critical):
 *    citing evidence the pipeline did not select is untraceable grounding;
 *  - a claim that presents itself as a DIRECT statement of the nash
 *    (quotation markers, "menurut nash", qaul formulas) needs at least one
 *    DIRECT evidence link with a verbatim quote — a synthesis-only chain
 *    behind direct wording is critical misrepresentation;
 *  - critical issues block publication through the same
 *    validation_runs/issues storage as VAL-001/002.
 */

export const CLAIM_VALIDATOR_VERSION = 'claim-validator-v1'

export interface ClaimIssue {
	claimId: string
	severity: 'critical' | 'major' | 'minor'
	code: string
	location: string
	detail: string
}

export interface ClaimValidationResult {
	issues: ClaimIssue[]
	hasCritical: boolean
	materialClaimCount: number
	supportedClaimCount: number
	validatorVersion: string
}

/** markers that present a claim as a direct statement of the source */
const DIRECT_STATEMENT_MARKERS: RegExp[] = [
	/["“”«»]/, // quotation marks around nash
	/\bقال\b/, // "he said" (Arabic)
	/menurut\s+nash/i,
	/dalam\s+kitab/i,
	/\bnash[- ]nya\b/i,
	/\bbunyi\s+ayat\b/i,
	/\bteks\s+hadtis\b/i,
]

function presentsAsDirectStatement(text: string): boolean {
	return DIRECT_STATEMENT_MARKERS.some((re) => re.test(text))
}

export function validateClaimsSupport(
	answer: Pick<StructuredAnswer, 'claims'>,
	selectedEvidenceIds: string[],
): ClaimValidationResult {
	const issues: ClaimIssue[] = []
	const selected = new Set(selectedEvidenceIds)
	const material = answer.claims.filter((c) => c.material)

	for (const claim of answer.claims) {
		// 1) every material claim maps evidence
		if (claim.material && claim.evidence.length === 0) {
			issues.push({
				claimId: claim.id,
				severity: 'critical',
				code: 'UNSUPPORTED_MATERIAL_CLAIM',
				location: `claims[${claim.id}].evidence`,
				detail: `material claim "${claim.text.slice(0, 80)}" carries no evidence link`,
			})
			continue
		}

		// 2) unknown / unselected evidence ids are rejected outright
		for (const link of claim.evidence) {
			if (!selected.has(link.evidenceId)) {
				issues.push({
					claimId: claim.id,
					severity: 'critical',
					code: 'EVIDENCE_NOT_SELECTED',
					location: `claims[${claim.id}].evidence[${link.evidenceId}]`,
					detail: `evidence ${link.evidenceId} is not part of the selected evidence set for this answer`,
				})
			}
		}

		// 3) direct statements need direct support: wording that presents a
		// verbatim statement must be backed by at least one direct link
		if (
			claim.material &&
			presentsAsDirectStatement(claim.text) &&
			!claim.evidence.some((l) => l.relation === 'direct')
		) {
			issues.push({
				claimId: claim.id,
				severity: 'critical',
				code: 'DIRECT_WITHOUT_DIRECT_SUPPORT',
				location: `claims[${claim.id}].evidence`,
				detail:
					'claim presents a direct statement of the source but has no direct (verbatim-quote) evidence link',
			})
		}
	}

	const criticalClaimIds = new Set(
		issues.filter((i) => i.severity === 'critical').map((i) => i.claimId),
	)
	return {
		issues,
		hasCritical:
			issues.length > 0 && issues.some((i) => i.severity === 'critical'),
		materialClaimCount: material.length,
		supportedClaimCount: material.filter((c) => !criticalClaimIds.has(c.id))
			.length,
		validatorVersion: CLAIM_VALIDATOR_VERSION,
	}
}

/** Persist claim issues through validation_runs (feeds the publish gate). */
export async function storeClaimValidationRun(
	sql: Sql,
	answerId: string,
	result: ClaimValidationResult,
): Promise<string> {
	return await sql.begin(async (tx) => {
		const [run] = await tx<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, result, finished_at)
			values (
				${answerId}::uuid,
				${result.validatorVersion},
				${tx.json({
					hasCritical: result.hasCritical,
					materialClaimCount: result.materialClaimCount,
					supportedClaimCount: result.supportedClaimCount,
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
					${issue.location},
					${tx.json({ detail: issue.detail, claimId: issue.claimId } as never)}
				)`
		}
		return run.id
	})
}
