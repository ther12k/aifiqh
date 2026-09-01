import type { StructuredAnswer } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Madhhab attribution and comparative coverage validation (VAL-004).
 *
 *  - a claim attributed to a madhhab must be supported by evidence
 *    carrying that madhhab (an explicitly comparative source carrying
 *    several schools supports attributions to any of them);
 *  - evidence tagged with OTHER schools and not the claimed one is a
 *    CONFLICT — critical, it blocks publication;
 *  - unattributed evidence cannot contradict, so attribution against it
 *    is allowed but recorded as unverified (auditable, minor);
 *  - requested madhhabs missing from an answer must be DISCLOSED in the
 *    caveats section — silent omission is a major issue;
 *  - every reason carries its claim/evidence context for audit.
 */

export const MADHHAB_VALIDATOR_VERSION = 'madhhab-validator-v1'

export interface MadhhabIssue {
	claimId: string | null
	severity: 'critical' | 'major' | 'minor'
	code: string
	location: string
	detail: string
}

export interface MadhhabValidationResult {
	issues: MadhhabIssue[]
	hasCritical: boolean
	representedMadhhab: string[]
	missingMadhhab: string[]
	validatorVersion: string
}

export interface EvidenceMadhhab {
	evidenceId: string
	/** schools the evidence is tagged with; empty = unattributed */
	madhhab: string[]
}

export function validateMadhhabAttribution(
	answer: Pick<StructuredAnswer, 'claims' | 'sections'>,
	evidence: EvidenceMadhhab[],
	requestedMadhhab: string[] = [],
): MadhhabValidationResult {
	const issues: MadhhabIssue[] = []
	const byId = new Map(evidence.map((e) => [e.evidenceId, e]))
	const attributed = answer.claims.filter((c) => c.madhhab)

	for (const claim of attributed) {
		const school = claim.madhhab as string
		const linked = claim.evidence
			.map((l) => byId.get(l.evidenceId))
			.filter((e): e is EvidenceMadhhab => e !== undefined)

		if (linked.length === 0) continue // VAL-003 handles missing links

		// does any linked evidence carry the claimed school? (an explicitly
		// comparative source lists several schools and supports each of them)
		const supporting = linked.some((e) => e.madhhab.includes(school))
		if (supporting) continue

		const attributedEvidence = linked.filter((e) => e.madhhab.length > 0)
		if (attributedEvidence.length > 0) {
			// every attributable evidence carries OTHER schools: conflict
			const carriers = [
				...new Set(attributedEvidence.flatMap((e) => e.madhhab)),
			].sort()
			issues.push({
				claimId: claim.id,
				severity: 'critical',
				code: 'MADHHAB_ATTRIBUTION_CONFLICT',
				location: `claims[${claim.id}].madhhab`,
				detail: `claim attributed to ${school} but its evidence only carries ${carriers.join(',')} — conflicting attribution`,
			})
		} else {
			// evidence is unattributed: cannot contradict, but unverified
			issues.push({
				claimId: claim.id,
				severity: 'minor',
				code: 'MADHHAB_ATTRIBUTION_UNVERIFIED',
				location: `claims[${claim.id}].madhhab`,
				detail: `claim attributed to ${school} but no linked evidence carries madhhab tags`,
			})
		}
	}

	// comparative coverage: requested schools missing from the answer must
	// be disclosed in the caveats section — silent omission is not allowed
	const represented = [
		...new Set(attributed.map((c) => c.madhhab as string)),
	].sort()
	const missing = requestedMadhhab
		.filter((m) => !represented.includes(m))
		.sort()
	if (missing.length > 0) {
		const caveats = answer.sections.find((s) => s.kind === 'caveats')
		const caveatsText = (caveats?.markdown ?? '').toLowerCase()
		for (const m of missing) {
			if (!caveatsText.includes(m.toLowerCase())) {
				issues.push({
					claimId: null,
					severity: 'major',
					code: 'MISSING_MADHHAB_DISCLOSURE',
					location: 'sections[caveats]',
					detail: `requested madhhab ${m} is absent from the answer and not disclosed in caveats`,
				})
			}
		}
	}

	return {
		issues,
		hasCritical: issues.some((i) => i.severity === 'critical'),
		representedMadhhab: represented,
		missingMadhhab: missing,
		validatorVersion: MADHHAB_VALIDATOR_VERSION,
	}
}

/** Persist attribution issues through validation_runs (auditable). */
export async function storeMadhhabValidationRun(
	sql: Sql,
	answerId: string,
	result: MadhhabValidationResult,
): Promise<string> {
	return await sql.begin(async (tx) => {
		const [run] = await tx<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, result, finished_at)
			values (
				${answerId}::uuid,
				${result.validatorVersion},
				${tx.json({
					hasCritical: result.hasCritical,
					representedMadhhab: result.representedMadhhab,
					missingMadhhab: result.missingMadhhab,
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
