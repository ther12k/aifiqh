import {
	type SchemaIssue,
	type StructuredAnswer,
	validateStructuredAnswer,
} from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Validate → repair once → or reject (LLM-006).
 *
 *  - valid output passes through UNCHANGED — no extra model call, no
 *    re-serialization, byte-for-byte the object that was validated;
 *  - invalid output gets exactly ONE repair attempt whose instruction is
 *    built from the complete issue list; a second failure is final;
 *  - evidence grounding is part of validation: evidence ids outside the
 *    allowed set are rejected (\`UNKNOWN_EVIDENCE_ID\`), including after
 *    repair;
 *  - unrepaired output never becomes an answer — callers surface the safe
 *    error / abstention path instead (EVD-005);
 *  - every attempt is traced (pure trace + \`repair_attempts\` storage,
 *    schema-enforced to attempt_no = 1).
 */

export const REPAIR_PIPELINE_VERSION = 'repair-once-v1'

export interface ValidationResult {
	ok: boolean
	answer: StructuredAnswer | null
	issues: SchemaIssue[]
}

/** Schema validation + evidence grounding in one gate. */
export function validateAnswerWithEvidence(
	output: unknown,
	allowedEvidenceIds: string[],
): ValidationResult {
	const validation = validateStructuredAnswer(output)
	if (!validation.answer) return validation

	const allowed = new Set(allowedEvidenceIds)
	const unknown: string[] = []
	for (const claim of validation.answer.claims) {
		for (const link of claim.evidence) {
			if (!allowed.has(link.evidenceId)) unknown.push(link.evidenceId)
		}
	}
	if (unknown.length > 0) {
		for (const id of unknown) {
			validation.issues.push({
				path: 'claims',
				code: 'UNKNOWN_EVIDENCE_ID',
				message: `evidence id ${id} is not in the allowed evidence set`,
			})
		}
		validation.ok = false
		validation.answer = null
	}
	return validation
}

export interface RepairAttemptTrace {
	attempted: boolean
	instruction: string | null
	result: 'not_needed' | 'success' | 'failed'
	issueCountBefore: number
	issueCountAfter: number
}

export interface RepairOutcome {
	status: 'valid' | 'repaired' | 'rejected'
	answer: StructuredAnswer | null
	originalIssues: SchemaIssue[]
	finalIssues: SchemaIssue[]
	trace: RepairAttemptTrace
	version: string
}

/** Deterministic repair instruction from the issue list. */
export function buildRepairInstruction(issues: SchemaIssue[]): string {
	const lines = issues.map((i) => `- [${i.code}] di ${i.path}: ${i.message}`)
	return [
		'Jawaban JSON sebelumnya tidak valid. Perbaiki SEMUA masalah berikut dan kembalikan JSON lengkap yang valid:',
		...lines,
	].join('\n')
}

export interface RepairDeps {
	/** produce a repaired JSON string from the instruction; called at most once */
	repair: (instruction: string) => Promise<string>
}

/** Validate once; on failure repair AT MOST once; reject if still invalid. */
export async function validateAndRepairOnce(
	output: unknown,
	allowedEvidenceIds: string[],
	deps: RepairDeps,
): Promise<RepairOutcome> {
	const first = validateAnswerWithEvidence(output, allowedEvidenceIds)
	if (first.ok) {
		return {
			status: 'valid',
			answer: first.answer, // unchanged — no second model call
			originalIssues: [],
			finalIssues: [],
			trace: {
				attempted: false,
				instruction: null,
				result: 'not_needed',
				issueCountBefore: 0,
				issueCountAfter: 0,
			},
			version: REPAIR_PIPELINE_VERSION,
		}
	}

	const instruction = buildRepairInstruction(first.issues)
	let repairedRaw: string
	try {
		repairedRaw = await deps.repair(instruction)
	} catch (err) {
		return {
			status: 'rejected',
			answer: null,
			originalIssues: first.issues,
			finalIssues: [
				...first.issues,
				{
					path: '$repair',
					code: 'REPAIR_CALL_FAILED',
					message: err instanceof Error ? err.message : String(err),
				},
			],
			trace: {
				attempted: true,
				instruction,
				result: 'failed',
				issueCountBefore: first.issues.length,
				issueCountAfter: first.issues.length + 1,
			},
			version: REPAIR_PIPELINE_VERSION,
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(repairedRaw)
	} catch {
		return {
			status: 'rejected',
			answer: null,
			originalIssues: first.issues,
			finalIssues: [
				...first.issues,
				{
					path: '$repair',
					code: 'UNPARSEABLE_JSON',
					message: 'repaired output is not valid JSON',
				},
			],
			trace: {
				attempted: true,
				instruction,
				result: 'failed',
				issueCountBefore: first.issues.length,
				issueCountAfter: first.issues.length + 1,
			},
			version: REPAIR_PIPELINE_VERSION,
		}
	}

	const second = validateAnswerWithEvidence(parsed, allowedEvidenceIds)
	if (!second.ok) {
		// exactly one repair allowed — still-broken output is rejected and
		// the caller falls back to the safe error / abstention path
		return {
			status: 'rejected',
			answer: null,
			originalIssues: first.issues,
			finalIssues: second.issues,
			trace: {
				attempted: true,
				instruction,
				result: 'failed',
				issueCountBefore: first.issues.length,
				issueCountAfter: second.issues.length,
			},
			version: REPAIR_PIPELINE_VERSION,
		}
	}

	return {
		status: 'repaired',
		answer: second.answer,
		originalIssues: first.issues,
		finalIssues: [],
		trace: {
			attempted: true,
			instruction,
			result: 'success',
			issueCountBefore: first.issues.length,
			issueCountAfter: 0,
		},
		version: REPAIR_PIPELINE_VERSION,
	}
}

/**
 * Persist the attempt trace. The schema pins attempt_no = 1 — a second
 * insert for the same answer is a database error, enforcing repair-once
 * at the storage layer too.
 */
export async function storeRepairAttempt(
	sql: Sql,
	answerId: string,
	trace: RepairAttemptTrace,
): Promise<void> {
	if (!trace.attempted) return
	await sql`
		insert into repair_attempts (answer_id, attempt_no, instruction, result)
		values (${answerId}::uuid, 1, ${trace.instruction ?? ''}, ${trace.result})`
}
