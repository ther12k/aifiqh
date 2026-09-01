import {
	ANSWER_SCHEMA_VERSION,
	type SchemaIssue,
	type StructuredAnswer,
	validateStructuredAnswer,
} from '@aifiqh/shared'
import type { ResponseDecisionOutcome } from '../retrieval/abstentionPolicy'
import type { BuiltContext } from '../retrieval/contextBuilder'

/**
 * Versioned grounded-generation pipeline (LLM-005).
 *
 * Everything that shapes an answer is PINNED before the model runs:
 * prompt version, model + provider, context manifest hash, answer schema
 * version and pipeline version travel with the result so any answer can be
 * reproduced and audited against its exact inputs.
 *
 * Grounding rules enforced by construction:
 *  - the prompt only contains context items INCLUDED in the manifest;
 *  - the model may only cite those evidence ids — anything else is
 *    rejected (UNKNOWN_EVIDENCE_ID), never silently kept;
 *  - abstain/escalate decisions never reach the model at all: abstention
 *    is a decision, not generated prose;
 *  - a failed or invalid generation NEVER produces a valid answer — the
 *    draft is discarded with its issues, no partial output leaks through.
 */

export const GENERATION_PIPELINE_VERSION = 'grounded-generation-v1'

export const PROMPT_VERSION = 'grounded-answer-prompt-v1'

export interface PinnedVersions {
	pipelineVersion: string
	promptVersion: string
	schemaVersion: string
	contextManifestHash: string
	providerKey: string
	modelId: string
}

export interface GenerateAnswerInput {
	query: string
	context: BuiltContext
	decision: ResponseDecisionOutcome
	providerKey: string
	generate: (request: {
		messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
		responseFormat: 'text' | 'json_object'
		promptVersion: string
	}) => Promise<{ text: string; finishReason: string; modelId?: string }>
}

export type GenerationStatus = 'generated' | 'abstained' | 'failed'

export interface GenerationResult {
	status: GenerationStatus
	answer: StructuredAnswer | null
	issues: SchemaIssue[]
	pinned: PinnedVersions | null
	/** the raw model output, kept only for failure forensics */
	rawOutput: string | null
}

function buildSystemPrompt(
	decision: ResponseDecisionOutcome,
	evidenceBlock: string,
): string {
	const constraints = decision.languageConstraints.join('\n- ')
	return `Anda adalah asisten fiqih yang HANYA menjawab berdasarkan bukti yang diberikan.

ATURAN JAWABAN (wajib):
- Keluarkan HANYA satu objek JSON valid, tanpa teks lain.
- schemaVersion: "${ANSWER_SCHEMA_VERSION}"
- language: "id", "ar", atau "mixed" sesuai pertanyaan.
- Wajib memuat kelima section: direct_answer, evidence, method, caveats, sources.
- Setiap klaim material (status ${'`material: true`'}) wajib memiliki minimal satu link evidence.
- Link evidence: relation "direct" wajib memuat kutipan verbatim (quote); relation "synthesis" tidak boleh memuat quote tunggal.
- evidenceId HANYA boleh salah satu id bukti yang diberikan di bawah. Id lain ditolak.

BATASAN BAHASA (wajib dipatuhi):
- ${constraints}

BUKTI (satu-satunya sumber yang boleh dikutip):
${evidenceBlock}`
}

function buildUserPrompt(query: string): string {
	return `Pertanyaan: ${query}\n\nKembalikan objek JSON jawaban terstruktur sesuai aturan.`
}

/**
 * Run the grounded generation pipeline. Pure with respect to the database —
 * callers persist invocations/answers; this function decides ground truth.
 */
export async function generateGroundedAnswer(
	input: GenerateAnswerInput,
): Promise<GenerationResult> {
	// abstain / escalate decisions never call the model
	if (
		input.decision.decision !== 'answer' &&
		input.decision.decision !== 'answer_with_caveats'
	) {
		return {
			status: 'abstained',
			answer: null,
			issues: [],
			pinned: null,
			rawOutput: null,
		}
	}

	const includedItems = input.context.items.filter((i) => i.included)
	const evidenceIds = new Set(includedItems.map((i) => i.unitId))
	const evidenceBlock = includedItems
		.map((i) => `- id: ${i.unitId} [${i.relation}] ${i.selectionReason}`)
		.join('\n')

	const pinned: PinnedVersions = {
		pipelineVersion: GENERATION_PIPELINE_VERSION,
		promptVersion: PROMPT_VERSION,
		schemaVersion: ANSWER_SCHEMA_VERSION,
		contextManifestHash: input.context.manifestHash,
		providerKey: input.providerKey,
		modelId: '',
	}

	let response: { text: string; finishReason: string; modelId?: string }
	try {
		response = await input.generate({
			messages: [
				{
					role: 'system',
					content: buildSystemPrompt(input.decision, evidenceBlock),
				},
				{ role: 'user', content: buildUserPrompt(input.query) },
			],
			responseFormat: 'json_object',
			promptVersion: PROMPT_VERSION,
		})
	} catch (err) {
		// gateway failure is a failed generation, never a partial draft
		return {
			status: 'failed',
			answer: null,
			issues: [
				{
					path: '$gateway',
					code: 'GATEWAY_ERROR',
					message: err instanceof Error ? err.message : String(err),
				},
			],
			pinned,
			rawOutput: null,
		}
	}

	pinned.modelId = response.modelId ?? ''

	if (response.finishReason !== 'stop') {
		return {
			status: 'failed',
			answer: null,
			issues: [
				{
					path: '$gateway',
					code: 'INCOMPLETE_GENERATION',
					message: `finishReason=${response.finishReason}`,
				},
			],
			pinned,
			rawOutput: response.text,
		}
	}

	// parse: the model must return a single JSON object
	let parsed: unknown
	try {
		parsed = JSON.parse(response.text)
	} catch {
		return {
			status: 'failed',
			answer: null,
			issues: [
				{
					path: '$',
					code: 'UNPARSEABLE_JSON',
					message: 'model output is not valid JSON',
				},
			],
			pinned,
			rawOutput: response.text,
		}
	}

	// schema validation (LLM-004) — all issues collected for repair
	const validation = validateStructuredAnswer(parsed)

	// grounding gate: only manifest evidence ids are accepted — the check
	// runs even when schema validation already failed so callers see every
	// problem at once
	if (validation.answer) {
		const unknownIds: string[] = []
		for (const claim of validation.answer.claims) {
			for (const link of claim.evidence) {
				if (!evidenceIds.has(link.evidenceId)) {
					unknownIds.push(link.evidenceId)
				}
			}
		}
		for (const id of unknownIds) {
			validation.issues.push({
				path: 'claims',
				code: 'UNKNOWN_EVIDENCE_ID',
				message: `evidence id ${id} is not part of the pinned context manifest`,
			})
		}
		if (unknownIds.length > 0) {
			validation.ok = false
			validation.answer = null
		}
	}

	if (!validation.ok) {
		// invalid output is NEVER surfaced as a valid answer — the draft
		// dies here with its full issue list (LLM-006 may repair once)
		return {
			status: 'failed',
			answer: null,
			issues: validation.issues,
			pinned,
			rawOutput: response.text,
		}
	}

	return {
		status: 'generated',
		answer: validation.answer,
		issues: [],
		pinned,
		rawOutput: null,
	}
}
