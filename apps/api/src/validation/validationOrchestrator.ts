import type { Principal, StructuredAnswer } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { storeResponseDecision } from '../retrieval/abstentionPolicy'
import type { DraftCitation } from './citationValidator'
import { validateAnswerCitations } from './citationValidator'
import { validateClaimsSupport } from './claimValidator'
import type { EvidenceMadhhab } from './madhhabValidator'
import { validateMadhhabAttribution } from './madhhabValidator'
import { verifyAnswerQuotations } from './quotationVerifier'

/**
 * Validation orchestration: run every validator, repair ONCE, else abstain
 * (VAL-005).
 *
 *  - repair max one: a single repair attempt over the full bundle, then
 *    the verdict is final;
 *  - a second critical failure ABSTAINS: the answer row moves to
 *    'abstained' (a terminal safe state — it can never satisfy the
 *    draft→validated→published gate), an abstention decision with the
 *    issue summary is stored on the trace;
 *  - a citation removed by repair UPDATES THE CLAIMS: its evidence links
 *    are dropped, material claims left without evidence are removed, and
 *    section references to removed claims are cleaned — the answer never
 *    ships claims pointing at citations that no longer exist;
 *  - decision and issues are stored for audit; an invalid draft is never
 *    final.
 */

export const VALIDATION_ORCHESTRATOR_VERSION = 'validation-orchestrator-v1'

export interface CitedDraft extends DraftCitation {
	quote?: string
	/** claims whose evidence this citation provides */
	claimIds?: string[]
}

export interface AnswerBundle {
	answerId: string
	traceId: string
	answer: StructuredAnswer
	citations: CitedDraft[]
	selectedEvidenceIds: string[]
	evidenceMadhhab: EvidenceMadhhab[]
	requestedMadhhab?: string[]
}

export interface LiteIssue {
	source: string
	severity: 'critical' | 'major' | 'minor'
	code: string
	location: string
	detail: string
}

export interface OrchestrationOutcome {
	status: 'valid' | 'repaired' | 'abstained'
	answer: StructuredAnswer
	citations: CitedDraft[]
	firstRoundIssues: LiteIssue[]
	finalIssues: LiteIssue[]
	removedCitations: number[]
	removedClaims: string[]
	decisionStored: boolean
}

export interface RepairDeps {
	/** one repair attempt over the whole bundle; returns the fixed parts */
	repair: (context: {
		issues: LiteIssue[]
		answer: StructuredAnswer
		citations: CitedDraft[]
	}) => Promise<{ answer: StructuredAnswer; citations: CitedDraft[] }>
}

/** Run VAL-001..004 over a bundle and aggregate the issues. */
export async function runAllValidators(
	sql: Sql,
	principal: Principal,
	bundle: AnswerBundle,
): Promise<LiteIssue[]> {
	const issues: LiteIssue[] = []

	const citations = await validateAnswerCitations(
		sql,
		principal,
		bundle.citations,
	)
	for (const i of citations.issues) {
		issues.push({
			source: 'VAL-001',
			severity: i.severity,
			code: i.code,
			location: i.location,
			detail: i.detail,
		})
	}

	const quotations = await verifyAnswerQuotations(
		sql,
		principal,
		bundle.citations
			.filter((c) => c.quote)
			.map((c) => ({
				ordinal: c.ordinal,
				spanId: c.spanId as string,
				quote: c.quote as string,
			})),
	)
	for (const i of quotations.issues) {
		issues.push({
			source: 'VAL-002',
			severity: i.severity,
			code: i.code,
			location: i.location,
			detail: i.detail,
		})
	}

	const claims = validateClaimsSupport(
		bundle.answer,
		bundle.selectedEvidenceIds,
	)
	for (const i of claims.issues) {
		issues.push({
			source: 'VAL-003',
			severity: i.severity,
			code: i.code,
			location: i.location,
			detail: i.detail,
		})
	}

	const madhhab = validateMadhhabAttribution(
		bundle.answer,
		bundle.evidenceMadhhab,
		bundle.requestedMadhhab ?? [],
	)
	for (const i of madhhab.issues) {
		issues.push({
			source: 'VAL-004',
			severity: i.severity,
			code: i.code,
			location: i.location,
			detail: i.detail,
		})
	}

	return issues
}

/**
 * A citation removed by repair updates the claims: evidence links tied to
 * the removed citation are dropped, material claims left without evidence
 * are removed entirely, and sections stop referencing removed claims.
 */
export function reconcileClaimsWithCitations(
	answer: StructuredAnswer,
	citations: CitedDraft[],
	previousCitations: CitedDraft[],
): {
	answer: StructuredAnswer
	citations: CitedDraft[]
	removedClaims: string[]
	removedCitations: number[]
} {
	const keptOrdinals = new Set(citations.map((c) => c.ordinal))
	const removedCitations = previousCitations
		.filter((c) => !keptOrdinals.has(c.ordinal))
		.map((c) => c.ordinal)

	// spans (evidence anchors) that disappeared with the removed citations
	const removedSpans = new Set(
		previousCitations
			.filter((c) => !keptOrdinals.has(c.ordinal) && c.spanId)
			.map((c) => c.spanId as string),
	)
	// claims those citations were feeding
	const claimsLosingFeed = new Set(
		previousCitations
			.filter((c) => !keptOrdinals.has(c.ordinal))
			.flatMap((c) => c.claimIds ?? []),
	)

	const removedClaims: string[] = []
	const claims = answer.claims.filter((claim) => {
		if (!claimsLosingFeed.has(claim.id)) return true
		// drop evidence links anchored at the removed spans
		claim.evidence = claim.evidence.filter(
			(link) => !removedSpans.has(link.evidenceId),
		)
		if (claim.material && claim.evidence.length === 0) {
			// a material claim without evidence cannot ship — remove it
			removedClaims.push(claim.id)
			return false
		}
		return true
	})

	const removedSet = new Set(removedClaims)
	const sections = answer.sections.map((section) => ({
		...section,
		claimIds: section.claimIds?.filter((id) => !removedSet.has(id)),
	}))

	return {
		answer: { ...answer, claims, sections },
		citations,
		removedClaims,
		removedCitations,
	}
}

async function persistRound(
	sql: Sql,
	answerId: string,
	label: string,
	issues: LiteIssue[],
): Promise<void> {
	if (issues.length === 0) return
	await sql.begin(async (tx) => {
		const [run] = await tx<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, result, finished_at)
			values (
				${answerId}::uuid,
				${`${VALIDATION_ORCHESTRATOR_VERSION}:${label}`},
				${tx.json({ issueCount: issues.length, criticals: issues.filter((i) => i.severity === 'critical').length } as never)},
				now()
			)
			returning id`
		for (const issue of issues) {
			await tx`
				insert into validation_issues (run_id, severity, code, location, detail)
				values (
					${run.id}::uuid, ${issue.severity}, ${issue.code},
					${`${issue.source}:${issue.location}`},
					${tx.json({ detail: issue.detail, source: issue.source } as never)}
				)`
		}
	})
}

/** Orchestrate validate → repair once → abstain. */
export async function orchestrateValidationAndRepair(
	sql: Sql,
	principal: Principal,
	bundle: AnswerBundle,
	deps: RepairDeps,
): Promise<OrchestrationOutcome> {
	const firstRound = await runAllValidators(sql, principal, bundle)
	await persistRound(sql, bundle.answerId, 'first-round', firstRound)

	if (!firstRound.some((i) => i.severity === 'critical')) {
		return {
			status: 'valid',
			answer: bundle.answer,
			citations: bundle.citations,
			firstRoundIssues: firstRound,
			finalIssues: firstRound,
			removedCitations: [],
			removedClaims: [],
			decisionStored: false,
		}
	}

	// exactly one repair attempt over the whole bundle
	let repairedAnswer: StructuredAnswer
	let repairedCitations: CitedDraft[]
	try {
		const repaired = await deps.repair({
			issues: firstRound,
			answer: bundle.answer,
			citations: bundle.citations,
		})
		repairedAnswer = repaired.answer
		repairedCitations = repaired.citations
	} catch (err) {
		// repair machinery failure abstains immediately — same terminal path
		return abstain(sql, bundle, firstRound, [
			...firstRound,
			{
				source: 'VAL-005',
				severity: 'critical',
				code: 'REPAIR_CALL_FAILED',
				location: '$repair',
				detail: err instanceof Error ? err.message : String(err),
			},
		])
	}

	// a removed citation updates the claims before re-validation
	const reconciled = reconcileClaimsWithCitations(
		repairedAnswer,
		repairedCitations,
		bundle.citations,
	)

	const secondRound = await runAllValidators(sql, principal, {
		...bundle,
		answer: reconciled.answer,
		citations: reconciled.citations,
	})
	await persistRound(sql, bundle.answerId, 'after-repair', secondRound)

	if (!secondRound.some((i) => i.severity === 'critical')) {
		return {
			status: 'repaired',
			answer: reconciled.answer,
			citations: reconciled.citations,
			firstRoundIssues: firstRound,
			finalIssues: secondRound,
			removedCitations: reconciled.removedCitations,
			removedClaims: reconciled.removedClaims,
			decisionStored: false,
		}
	}

	// second critical failure: safe abstention, invalid draft is never final
	return abstain(
		sql,
		bundle,
		firstRound,
		secondRound,
		reconciled.answer,
		reconciled.citations,
		reconciled.removedCitations,
		reconciled.removedClaims,
	)
}

async function abstain(
	sql: Sql,
	bundle: AnswerBundle,
	firstRound: LiteIssue[],
	finalIssues: LiteIssue[],
	answer?: StructuredAnswer,
	citations?: CitedDraft[],
	removedCitations?: number[],
	removedClaims?: string[],
): Promise<OrchestrationOutcome> {
	const criticals = finalIssues.filter((i) => i.severity === 'critical')
	// the answer row enters the terminal safe state: 'abstained' can never
	// satisfy the draft→validated→published gate
	await sql`update answers set status = 'abstained' where id = ${bundle.answerId}::uuid`
	// decision stored on the trace with the issue summary
	await storeResponseDecision(sql, bundle.traceId, {
		decision: 'abstain',
		languageConstraints: [
			'STATE_ABSTENTION_EXPLICITLY',
			'DO_NOT_ANSWER_FROM_GENERAL_KNOWLEDGE',
			'NO_NUMERIC_CONFIDENCE',
		],
		rationale: `validation criticals survived one repair attempt (${criticals
			.map((i) => i.code)
			.join(', ')})`,
		assessmentStatus: 'insufficient',
	})
	return {
		status: 'abstained',
		answer: answer ?? bundle.answer,
		citations: citations ?? bundle.citations,
		firstRoundIssues: firstRound,
		finalIssues,
		removedCitations: removedCitations ?? [],
		removedClaims: removedClaims ?? [],
		decisionStored: true,
	}
}
