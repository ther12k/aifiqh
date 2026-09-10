import type { Principal, StructuredAnswer } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { HashEmbeddingProvider } from '../index/embeddingService'
import { DefaultModelGateway } from '../llm/gateway'
import {
	type ChatModelResolution,
	resolveChatModelCandidates,
} from '../llm/modelRouter'
import { resolveChatModelConfig } from '../llm/modelRouter'
import {
	type ResponseDecisionOutcome,
	decideResponse,
	storeResponseDecision,
} from '../retrieval/abstentionPolicy'
import {
	CONTEXT_PROFILES,
	type ContextProfileKind,
	buildContext,
	storeContextManifest,
} from '../retrieval/contextBuilder'
import {
	type AssessmentOutcome,
	assessEvidenceFromPipeline,
} from '../retrieval/evidenceAssessment'
import { expandEvidenceContext } from '../retrieval/evidenceExpansion'
import {
	applyEvidencePolicy,
	selectEvidence,
} from '../retrieval/evidenceSelector'
import { executeLanePlan } from '../retrieval/laneFusion'
import { planAndPersistQuery } from '../retrieval/queryPlanner'
import { HashRerankerProvider } from '../retrieval/reranker'
import { evaluateAnswerClaimSupport } from '../validation/claimSupportScorer'
import { type VerificationStatus, deriveVerification } from './answerStatus'
import { finalizeGroundedAnswer } from './answerTraceService'
import { generateGroundedAnswer } from './generationPipeline'

/**
 * Conversation + per-turn grounded answer API (CHAT-001).
 *
 * Chat discipline:
 *  - every answer turn carries its OWN retrieval trace (plan, lanes,
 *    manifest, assessment, decision) — nothing is shared or reused
 *    between turns;
 *  - prior messages NEVER supply uncited facts: the generator receives
 *    only the current turn's context manifest items. Conversation
 *    history is stored for display, never fed as evidence;
 *  - a retry re-runs the pipeline on a fresh trace with its own lineage
 *    while the earlier attempt stays queryable;
 *  - abstain/escalate decisions skip generation entirely and produce an
 *    abstained answer row (terminal, never publishable);
 *  - access is enforced per conversation through tenant membership.
 */

export const CHAT_SERVICE_VERSION = 'chat-grounded-v1'

export class ChatError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'ChatError'
		this.code = code
	}
}

export interface TurnResult {
	conversationId: string
	/** the user message this turn answers */
	userMessageId: string
	assistantMessageId: string | null
	answerId: string | null
	/** unique per turn — never reused across turns or retries */
	traceId: string
	decision: ResponseDecisionOutcome
	assessment: AssessmentOutcome | null
	answer: StructuredAnswer | null
	status: 'answered' | 'abstained' | 'escalated' | 'failed'
	/** what actually generated the answer — real provider or builtin */
	provider: string
	model: string
	/** layered verification status (citation integrity ≠ claim support ≠
	 * scholarly review) with the user-facing outcome mapping */
	verification: VerificationStatus
	/** canonical citations for this turn — the UI's evidence panel reads
	 * these (span-scoped, quote verified at finalize) */
	citations: TurnCitation[]
	/** AI-002: how this turn was generated, with an explicit reason when
	 * the LLM path did not run — no silent fallback */
	generation: GenerationMetadata
}

/** how a turn's answer text was produced */
export type GenerationMode = 'llm_rag' | 'deterministic_rag'

/** one model attempt inside a turn (AI-004 chain diagnostics) */
export interface ModelAttempt {
	provider: string
	model: string
	/** alias = the primary, fallback = the configured chain */
	source: 'alias' | 'fallback'
	outcome: 'success' | GenerationFallbackReason
	/** first validation issue message (truncated) — ops evidence */
	message?: string
}

/**
 * Why the LLM path did not produce the answer (null when it did). Codes
 * are stable API surface — the UI maps them to plain language.
 */
export type GenerationFallbackReason =
	| 'model_not_configured'
	| 'secret_unavailable'
	| 'ambiguous_model_config'
	| 'kill_switch'
	| 'provider_error'
	| 'invalid_output'
	| 'citation_validation_failed'

export interface GenerationMetadata {
	mode: GenerationMode
	provider: string
	model: string
	fallbackReason: GenerationFallbackReason | null
	/** AI-004: the attempts this turn made before an answer was produced */
	attempts?: ModelAttempt[]
}

/** resolution diagnostic → user-visible fallback reason */
function resolutionFallbackReason(
	reason: ChatModelResolution,
): GenerationFallbackReason {
	switch (reason) {
		case 'secret_unavailable':
			return 'secret_unavailable'
		case 'ambiguous':
			return 'ambiguous_model_config'
		case 'kill_switch':
			return 'kill_switch'
		default:
			// not_configured / disabled_or_empty / resolved-unreachable
			return 'model_not_configured'
	}
}

/** pipeline failure issue codes → the fallback reason the turn reports */
function fallbackReasonFromGeneration(
	issues: ReadonlyArray<{ code: string }>,
): GenerationFallbackReason {
	const codes = new Set(issues.map((i) => i.code))
	if (codes.has('GATEWAY_ERROR') || codes.has('INCOMPLETE_GENERATION')) {
		return 'provider_error'
	}
	if (codes.has('UNKNOWN_EVIDENCE_ID') || codes.has('QUOTE_MISMATCH')) {
		return 'citation_validation_failed'
	}
	return 'invalid_output'
}

/** fallback reason → per-attempt outcome label (same vocabulary) */
function attemptOutcome(
	reason: GenerationFallbackReason,
): ModelAttempt['outcome'] {
	return reason
}

export interface TurnCitation {
	ordinal: number
	sourceId: string
	sourceRevisionId: string
	spanId: string
	quote: string
	/** display metadata joined from sources — lets the chat UI render a
	 * proper source card without a per-citation round-trip */
	sourceTitle?: string
	sourceAuthor?: string
	sourceType?: string
	rightsStatus?: string
}

export async function startConversation(
	sql: Sql,
	principal: Principal,
	title: string | null,
): Promise<{ conversationId: string }> {
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, title, created_by)
		values (${principal.tenantId}::uuid, ${title}, ${principal.userId}::uuid)
		returning id`
	await sql`insert into conversation_members (conversation_id, user_id)
		values (${conversation.id}::uuid, ${principal.userId}::uuid)`
	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'chat.conversation_started',
		entityType: 'conversation',
		entityId: conversation.id,
	})
	return { conversationId: conversation.id }
}

async function assertConversationAccess(
	sql: Sql,
	principal: Principal,
	conversationId: string,
): Promise<void> {
	const [row] = await sql<{ id: string }[]>`
		select c.id from conversations c
		join conversation_members cm on cm.conversation_id = c.id
		where c.id = ${conversationId}::uuid
			and c.tenant_id = ${principal.tenantId}::uuid
			and cm.user_id = ${principal.userId}::uuid`
	if (!row)
		throw new ChatError(
			'CONVERSATION_NOT_FOUND',
			'conversation not found in tenant',
		)
}

async function nextMessageOrdinal(
	sql: Sql,
	conversationId: string,
): Promise<number> {
	const [row] = await sql<{ n: number }[]>`
		select coalesce(max(ordinal), 0) + 1 as n from messages
		where conversation_id = ${conversationId}::uuid`
	return row.n
}

/** metadata needed to emit canonical citations for context items */
interface CitableItem {
	unitId: string
	sourceId: string
	sourceRevisionId: string
	spanId: string
	text: string
}

async function loadCitableItems(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	unitIds: string[],
): Promise<Map<string, CitableItem>> {
	const map = new Map<string, CitableItem>()
	if (unitIds.length === 0) return map
	const rows = await sql<
		{
			unit_id: string
			source_id: string
			source_revision_id: string
			span_id: string
			original_text: string
		}[]
	>`select ru.id as unit_id, s.id as source_id, sr.id as source_revision_id,
			ss.id as span_id, ru.original_text
		from retrieval_units ru
		join source_spans ss on ss.id = ru.source_span_id
		join source_revisions sr on sr.id = ss.source_revision_id
		join sources s on s.id = sr.source_id
		where ru.id = any(${unitIds}::uuid[])
			and ru.index_release_id = ${indexReleaseId}::uuid
			and s.tenant_id = ${principal.tenantId}::uuid`
	for (const r of rows) {
		map.set(r.unit_id, {
			unitId: r.unit_id,
			sourceId: r.source_id,
			sourceRevisionId: r.source_revision_id,
			spanId: r.span_id,
			text: r.original_text,
		})
	}
	return map
}

/**
 * Deterministic built-in generator: composes the answer EXCLUSIVELY from
 * the current turn's context manifest items — one direct claim per
 * included citable item, quoting it verbatim. Remote model providers
 * plug in through the same generate callback; the grounding gate
 * (LLM-005) still applies to whatever they return.
 */
async function composeFromEvidence(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	includedUnitIds: string[],
): Promise<{
	answer: StructuredAnswer
	citations: Array<{
		ordinal: number
		sourceId: string
		sourceRevisionId: string
		spanId: string
		quote: string
	}>
}> {
	const citable = await loadCitableItems(
		sql,
		principal,
		indexReleaseId,
		includedUnitIds,
	)
	const ordered = includedUnitIds
		.map((id) => citable.get(id))
		.filter((c): c is CitableItem => c !== undefined)

	const claims: StructuredAnswer['claims'] = []
	const citations: Array<{
		ordinal: number
		sourceId: string
		sourceRevisionId: string
		spanId: string
		quote: string
	}> = []
	ordered.forEach((item, idx) => {
		claims.push({
			id: `c${idx + 1}`,
			text: item.text,
			material: true,
			evidence: [
				{
					claimId: `c${idx + 1}`,
					evidenceId: item.unitId,
					relation: 'direct',
					quote: item.text,
				},
			],
		})
		citations.push({
			ordinal: idx + 1,
			sourceId: item.sourceId,
			sourceRevisionId: item.sourceRevisionId,
			spanId: item.spanId,
			quote: item.text,
		})
	})

	const answer: StructuredAnswer = {
		schemaVersion: 'answer-schema-v1',
		language: 'id',
		sections: [
			{
				kind: 'direct_answer',
				markdown: ordered.length
					? ordered.map((i) => i.text).join('\n\n')
					: 'Tidak ada bukti yang cukup untuk menjawab.',
				claimIds: claims.map((c) => c.id),
			},
			{
				kind: 'evidence',
				markdown: 'Bukti dikutip apa adanya.',
				claimIds: claims.map((c) => c.id),
			},
			{
				kind: 'method',
				markdown: 'Jawaban disusun langsung dari bukti terpilih.',
			},
			{ kind: 'caveats', markdown: 'Sumber terbatas pada bukti giliran ini.' },
			{
				kind: 'sources',
				markdown: ordered.length
					? 'Sumber: kitab yang dikutip.'
					: 'Tidak ada sumber.',
			},
		],
		claims,
	}
	return { answer, citations }
}

export interface TurnOptions {
	conversationId: string
	content: string
	indexReleaseId?: string
	madhhab?: string[]
	ensureMadhhab?: string[]
	contextProfile?: ContextProfileKind
	mode?: 'grounded_only' | 'allow_general_knowledge'
}

/** Post a user turn and answer it with the full grounded pipeline. */
export async function postUserTurn(
	sql: Sql,
	principal: Principal,
	options: TurnOptions,
): Promise<TurnResult> {
	await assertConversationAccess(sql, principal, options.conversationId)
	if (!options.content.trim())
		throw new ChatError('CONTENT_REQUIRED', 'message content is required')

	const ordinal = await nextMessageOrdinal(sql, options.conversationId)
	const [userMessage] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${options.conversationId}::uuid, ${ordinal}, 'user', ${options.content})
		returning id`

	return runTurn(sql, principal, {
		...options,
		userMessageId: userMessage.id,
	})
}

/** Retry the last user turn on a FRESH trace — lineage preserved. */
export async function retryLastTurn(
	sql: Sql,
	principal: Principal,
	conversationId: string,
	options: Omit<TurnOptions, 'conversationId' | 'content'> = {},
): Promise<TurnResult> {
	await assertConversationAccess(sql, principal, conversationId)
	const [lastUser] = await sql<{ id: string; content: string }[]>`
		select id, content from messages
		where conversation_id = ${conversationId}::uuid and role = 'user'
		order by ordinal desc limit 1`
	if (!lastUser)
		throw new ChatError(
			'NO_USER_TURN',
			'conversation has no user turn to retry',
		)
	// the retried user message is NOT duplicated — the same message gets a
	// new pipeline run with its own trace and assistant attempt
	return runTurn(sql, principal, {
		...options,
		conversationId,
		content: lastUser.content,
		userMessageId: lastUser.id,
	})
}

async function runTurn(
	sql: Sql,
	principal: Principal,
	options: TurnOptions & { userMessageId: string },
): Promise<TurnResult> {
	const { conversationId, content, userMessageId } = options
	let indexReleaseId = options.indexReleaseId
	if (!indexReleaseId) {
		const [aliasRow] = await sql<{ release_id: string }[]>`
				select release_id from index_aliases
				where tenant_id = ${principal.tenantId}::uuid and alias = 'production'
				limit 1`
		if (aliasRow) {
			indexReleaseId = aliasRow.release_id
		}
	}

	// 1. plan: a UNIQUE trace per turn, bound to the conversation
	const plan = await planAndPersistQuery(sql, principal, {
		originalQuery: content,
		indexReleaseId,
		requestedMadhhab: options.madhhab,
		mode: options.mode,
		conversationId,
	})
	await sql`update retrieval_traces set conversation_id = ${conversationId}::uuid
			where id = ${plan.traceId}::uuid`
	// the user message links to the trace it spawned
	await sql`update messages set retrieval_trace_id = ${plan.traceId}::uuid
			where id = ${userMessageId}::uuid`

	if (!indexReleaseId) {
		// no pinned release: nothing to retrieve from — abstain explicitly
		const decision: ResponseDecisionOutcome = {
			decision: 'abstain',
			languageConstraints: [
				'STATE_ABSTENTION_EXPLICITLY',
				'NO_NUMERIC_CONFIDENCE',
			],
			rationale: 'no index release available for this conversation turn',
			assessmentStatus: 'insufficient',
		}
		await storeResponseDecision(sql, plan.traceId, decision)
		const ordinal = await nextMessageOrdinal(sql, conversationId)
		const [message] = await sql<{ id: string }[]>`
				insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
				values (${conversationId}::uuid, ${ordinal}, 'assistant', 'Belum dapat menjawab: tidak ada indeks aktif.', ${plan.traceId}::uuid)
				returning id`
		const [answer] = await sql<{ id: string }[]>`
				insert into answers (message_id, trace_id, status)
				values (${message.id}::uuid, ${plan.traceId}::uuid, 'abstained') returning id`
		await sql`update messages set answer_id = ${answer.id}::uuid where id = ${message.id}::uuid`
		return {
			conversationId,
			userMessageId,
			assistantMessageId: message.id,
			answerId: answer.id,
			traceId: plan.traceId,
			decision,
			assessment: null,
			answer: null,
			status: 'abstained',
			provider: '',
			model: '',
			verification: deriveVerification({
				status: 'abstained',
				decision,
				assessment: null,
				citationsOk: false,
				citedCount: 0,
			}),
			citations: [],
			// abstention is a decision, not a fallback — no generation ran
			generation: {
				mode: 'deterministic_rag',
				provider: '',
				model: '',
				fallbackReason: null,
			},
		}
	}

	// 2. retrieval + evidence + expansion (same composable pipeline)
	const outcome = await executeLanePlan(sql, principal, {
		query: content,
		indexReleaseId,
		filters: { madhhab: options.madhhab },
		vectorProvider: await embeddingProviderFor(sql, indexReleaseId),
		reranker: new HashRerankerProvider(),
		evidence: { requestedMadhhab: options.ensureMadhhab ?? [] },
	})
	const { identifier, quote } = outcome.lanes
	const expansion = await expandEvidenceContext(
		sql,
		principal,
		indexReleaseId,
		(outcome.evidence?.selected ?? outcome.fused.candidates).map((c) => ({
			unitId: c.unitId,
			logicalUnitId: c.logicalUnitId,
		})),
	)
	// 3. assessment + decision
	const assessment = await assessEvidenceFromPipeline(
		sql,
		principal,
		indexReleaseId,
		{
			intent: plan.plan.intent,
			exactCandidatesCount:
				identifier.candidates.length + quote.candidates.length,
			evidence: outcome.evidence ?? applyEvidencePolicy([]),
			requestedMadhhab: options.ensureMadhhab ?? [],
		},
	)
	// note: expansion does not alter selection for assessment — it is context
	const decision = decideFromAssessment(assessment, options)
	await storeResponseDecision(sql, plan.traceId, decision)

	// 4. non-answer decisions never generate
	if (
		decision.decision !== 'answer' &&
		decision.decision !== 'answer_with_caveats'
	) {
		const ordinal = await nextMessageOrdinal(sql, conversationId)
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
			values (${conversationId}::uuid, ${ordinal}, 'assistant',
				${decision.decision === 'escalate' ? 'Terdapat perbedaan dalil — diteruskan ke peninjau manusia.' : 'Belum dapat menjawab berdasarkan bukti yang tersedia.'},
				${plan.traceId}::uuid)
			returning id`
		const [answerRow] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${plan.traceId}::uuid, 'abstained') returning id`
		await sql`update messages set answer_id = ${answerRow.id}::uuid where id = ${message.id}::uuid`
		return {
			conversationId,
			userMessageId,
			assistantMessageId: message.id,
			answerId: answerRow.id,
			traceId: plan.traceId,
			decision,
			assessment,
			answer: null,
			status: decision.decision === 'escalate' ? 'escalated' : 'abstained',
			provider: '',
			model: '',
			verification: deriveVerification({
				status: decision.decision === 'escalate' ? 'escalated' : 'abstained',
				decision,
				assessment,
				citationsOk: false,
				citedCount: 0,
			}),
			citations: [],
			// abstention/escalation is a decision, not a fallback
			generation: {
				mode: 'deterministic_rag',
				provider: '',
				model: '',
				fallbackReason: null,
			},
		}
	}

	// 5. context manifest for THIS turn only
	const profileDef = CONTEXT_PROFILES[options.contextProfile ?? 'standard']
	const evidenceSelection = outcome.evidence ?? applyEvidencePolicy([])
	const context = buildContext(profileDef, evidenceSelection, expansion)
	await storeContextManifest(sql, plan.traceId, context)

	// 6. generation: a configured model provider (provider_configs +
	// chat-production alias + secret ref) generates the grounded answer;
	// without one — or when the model output fails validation — the
	// deterministic built-in composer takes over. Claims ALWAYS come from
	// this turn's manifest items; prior turns are never evidence.
	const includedUnitIds = context.items
		.filter((i) => i.included)
		.map((i) => i.unitId)
	const citable = await loadCitableItems(
		sql,
		principal,
		indexReleaseId,
		includedUnitIds,
	)

	let generation: Awaited<ReturnType<typeof generateGroundedAnswer>> | null =
		null
	let usedProvider = 'builtin-compose'
	let usedModel = 'compose-from-evidence'
	let citations: Array<{
		ordinal: number
		sourceId: string
		sourceRevisionId: string
		spanId: string
		quote: string
	}> = []
	// AI-002: why the LLM path did not produce the answer (null when it did)
	let fallbackReason: GenerationFallbackReason | null = null
	// AI-004: every model attempt this turn made, in order
	const modelAttempts: ModelAttempt[] = []

	const evidenceTexts: Record<string, string> = {}
	for (const id of includedUnitIds) {
		const item = citable.get(id)
		if (item) evidenceTexts[id] = item.text
	}

	// attempt order: the chat-production alias first, then the configured
	// fallback chain (AI-004) — kill-switch empties the whole chain
	const chain = await resolveChatModelCandidates(sql)
	for (const candidate of chain.candidates) {
		const model = candidate.config
		const gateway = new DefaultModelGateway()
		gateway.registerProvider(model.adapter)
		const result = await generateGroundedAnswer({
			query: content,
			context,
			decision,
			providerKey: model.providerKey,
			evidenceTexts,
			generate: async (request) => {
				const res = await gateway.generate(model.providerKey, {
					modelId: model.modelId,
					messages: request.messages,
					temperature: 0.2,
					// thinking models (e.g. GLM) spend reasoning tokens before the
					// JSON payload — measured live: 4k truncates (finishReason
					// length), 16k completes with valid grounded JSON
					maxTokens: 16_384,
					responseFormat: request.responseFormat,
				})
				return {
					text: res.text,
					finishReason: res.finishReason,
					modelId: res.modelId,
				}
			},
		})
		if (result.status === 'generated' && result.answer) {
			generation = result
			usedProvider = model.providerKey
			usedModel = result.pinned?.modelId || model.modelId
			fallbackReason = null
			// citations follow the model's claim links — quotes stay verbatim
			// unit text read from the pinned release, never model prose
			const citedIds: string[] = []
			for (const claim of result.answer.claims) {
				for (const link of claim.evidence) {
					if (!citedIds.includes(link.evidenceId))
						citedIds.push(link.evidenceId)
				}
			}
			citations = citedIds
				.map((id, idx) => {
					const item = citable.get(id)
					return item
						? {
								ordinal: idx + 1,
								sourceId: item.sourceId,
								sourceRevisionId: item.sourceRevisionId,
								spanId: item.spanId,
								quote: item.text,
							}
						: null
				})
				.filter((c): c is NonNullable<typeof c> => c !== null)
			modelAttempts.push({
				provider: model.providerKey,
				model: model.modelId,
				source: candidate.source,
				outcome: 'success',
			})
			break
		}
		// this candidate failed — record why and try the next one in the
		// chain (the deterministic composer remains the final fallback)
		const reason = fallbackReasonFromGeneration(result.issues)
		modelAttempts.push({
			provider: model.providerKey,
			model: model.modelId,
			source: candidate.source,
			outcome: attemptOutcome(reason),
			message: result.issues[0]?.message
				? result.issues[0].message.slice(0, 240)
				: undefined,
		})
		fallbackReason = reason
		generation = null
	}
	if (chain.candidates.length === 0) {
		// no usable model at all — the deterministic composer runs and the
		// turn reports WHY the chain was empty
		fallbackReason = resolutionFallbackReason(chain.primaryReason)
	}

	if (!generation) {
		const composed = await composeFromEvidence(
			sql,
			principal,
			indexReleaseId,
			includedUnitIds,
		)
		citations = composed.citations
		generation = await generateGroundedAnswer({
			query: content,
			context,
			decision,
			providerKey: 'builtin-compose',
			generate: async () => ({
				text: JSON.stringify(composed.answer),
				finishReason: 'stop',
				modelId: 'compose-from-evidence',
			}),
		})
	}

	if (generation.status !== 'generated' || !generation.answer) {
		// the composer is deterministic; a failure here is still terminal
		const ordinal = await nextMessageOrdinal(sql, conversationId)
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
			values (${conversationId}::uuid, ${ordinal}, 'assistant', 'Gagal menyusun jawaban.', ${plan.traceId}::uuid)
			returning id`
		const [answerRow] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${plan.traceId}::uuid, 'failed') returning id`
		await sql`update messages set answer_id = ${answerRow.id}::uuid where id = ${message.id}::uuid`
		return {
			conversationId,
			userMessageId,
			assistantMessageId: message.id,
			answerId: answerRow.id,
			traceId: plan.traceId,
			decision,
			assessment,
			answer: null,
			status: 'failed',
			provider: '',
			model: '',
			verification: deriveVerification({
				status: 'failed',
				decision,
				assessment,
				citationsOk: false,
				citedCount: 0,
			}),
			citations: [],
			generation: {
				mode: 'deterministic_rag',
				provider: '',
				model: '',
				fallbackReason,
			},
		}
	}

	// 7. finalize: message + answer + claims + citations + trace close
	const finalized = await finalizeGroundedAnswer(sql, principal, {
		conversationId,
		traceId: plan.traceId,
		answer: generation.answer,
		citations,
		provider: usedProvider,
		model: usedModel,
	})

	// middle verification layer (#109): does the cited evidence actually
	// support the specific material claims (no polarity reversal / dropped conditions)?
	const claimSupportEval = generation.answer
		? evaluateAnswerClaimSupport(generation.answer, evidenceTexts)
		: { allSupported: true }

	return {
		conversationId,
		userMessageId,
		assistantMessageId: finalized.messageId,
		answerId: finalized.answerId,
		traceId: plan.traceId,
		decision,
		assessment,
		answer: generation.answer,
		status: 'answered',
		provider: usedProvider,
		model: usedModel,
		verification: deriveVerification({
			status: 'answered',
			decision,
			assessment,
			// citations are built from units read on the PINNED release with
			// verbatim span text — zero citations on an answered turn means
			// the answer has no citable support at all
			citationsOk: citations.length > 0,
			citedCount: citations.length,
			claimSupportOk: claimSupportEval.allSupported,
		}),
		citations,
		generation: {
			mode:
				usedProvider === 'builtin-compose' ? 'deterministic_rag' : 'llm_rag',
			provider: usedProvider,
			model: usedModel,
			fallbackReason:
				usedProvider === 'builtin-compose' ? fallbackReason : null,
			attempts: modelAttempts.length > 0 ? modelAttempts : undefined,
		},
	}
}

function decideFromAssessment(
	assessment: AssessmentOutcome,
	options: TurnOptions,
): ResponseDecisionOutcome {
	return decideResponse(assessment, options.mode ?? 'grounded_only')
}

async function embeddingProviderFor(sql: Sql, indexReleaseId: string) {
	const [model] = await sql<
		{ model_id: string; version: string; dimensions: number }[]
	>`select em.model_id, em.version, em.dimensions
		from index_releases ir
		join index_configurations ic on ic.id = ir.configuration_id
		join embedding_models em on em.id = ic.embedding_model_id
		where ir.id = ${indexReleaseId}::uuid`
	return model
		? new HashEmbeddingProvider(model.model_id, model.version, model.dimensions)
		: undefined
}

export interface ConversationView {
	conversationId: string
	title: string | null
	messages: Array<{
		id: string
		ordinal: number
		role: string
		content: string
		/** message creation timestamp — the UI groups turns into days */
		createdAt: string
		answerId: string | null
		traceId: string | null
		answerStatus: string | null
		answer?: {
			id: string
			status: string
			provider: string | null
			model: string | null
			sections: Array<{ kind: string; markdown: string }>
			citations: TurnCitation[]
			verification: VerificationStatus
			/** AI-003: how this answer was generated (mode derived from the
			 * stored provider; exact fallback reasons live on the turn only) */
			generation: GenerationMetadata
		} | null
		decision?: {
			decision: string
			rationale?: string
			userOutcome?: string
		} | null
	}>
}

export interface ConversationListItem {
	id: string
	title: string | null
	createdAt: string
	updatedAt: string
	snippet: string | null
	messageCount: number
}

export async function listConversations(
	sql: Sql,
	principal: Principal,
): Promise<ConversationListItem[]> {
	const rows = await sql<
		{
			id: string
			title: string | null
			created_at: string
			updated_at: string
			snippet: string | null
			message_count: number
		}[]
	>`
		select
			c.id,
			c.title,
			c.created_at::text as created_at,
			coalesce(
				(select m.created_at::text from messages m where m.conversation_id = c.id order by m.ordinal desc limit 1),
				c.created_at::text
			) as updated_at,
			coalesce(
				(select m.content from messages m where m.conversation_id = c.id and m.role = 'user' order by m.ordinal asc limit 1),
				(select m.content from messages m where m.conversation_id = c.id order by m.ordinal asc limit 1)
			) as snippet,
			(select count(*)::int from messages m where m.conversation_id = c.id) as message_count
		from conversations c
		join conversation_members cm on cm.conversation_id = c.id
		where c.tenant_id = ${principal.tenantId}::uuid and cm.user_id = ${principal.userId}::uuid
		order by coalesce(
			(select m.created_at from messages m where m.conversation_id = c.id order by m.ordinal desc limit 1),
			c.created_at
		) desc
		limit 50
	`
	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		snippet: r.snippet ? r.snippet.slice(0, 100) : null,
		messageCount: r.message_count,
	}))
}

export async function deleteConversation(
	sql: Sql,
	principal: Principal,
	conversationId: string,
): Promise<{ deleted: boolean }> {
	await assertConversationAccess(sql, principal, conversationId)
	await sql`delete from conversation_members
		where conversation_id = ${conversationId}::uuid and user_id = ${principal.userId}::uuid`
	return { deleted: true }
}

export async function getConversation(
	sql: Sql,
	principal: Principal,
	conversationId: string,
): Promise<ConversationView> {
	await assertConversationAccess(sql, principal, conversationId)
	const [conversation] = await sql<{ id: string; title: string | null }[]>`
		select id, title from conversations where id = ${conversationId}::uuid`
	const messages = await sql<
		{
			id: string
			ordinal: number
			role: string
			content: string
			answer_id: string | null
			trace_id: string | null
			answer_status: string | null
			created_at: string
		}[]
	>`select m.id, m.ordinal, m.role, m.content,
			m.answer_id::text as answer_id, m.retrieval_trace_id::text as trace_id,
			a.status as answer_status, m.created_at::text as created_at
		from messages m left join answers a on a.id = m.answer_id
		where m.conversation_id = ${conversationId}::uuid
		order by m.ordinal`

	const answerIds = messages
		.map((m) => m.answer_id)
		.filter((id): id is string => id !== null)

	const traceIds = messages
		.map((m) => m.trace_id)
		.filter((id): id is string => id !== null)

	const sectionsByAnswer = new Map<
		string,
		Array<{ kind: string; markdown: string }>
	>()
	if (answerIds.length > 0) {
		const secRows = await sql<
			{ answer_id: string; kind: string; content: string }[]
		>`select answer_id, kind, content
			from answer_sections
			where answer_id = any(${answerIds}::uuid[])
			order by ordinal asc`
		for (const s of secRows) {
			const list = sectionsByAnswer.get(s.answer_id) ?? []
			list.push({ kind: s.kind, markdown: s.content })
			sectionsByAnswer.set(s.answer_id, list)
		}
	}

	const citationsByAnswer = new Map<string, TurnCitation[]>()
	if (answerIds.length > 0) {
		const citRows = await sql<
			{
				answer_id: string
				ordinal: number
				source_id: string
				source_revision_id: string
				span_id: string
				quote: string | null
				source_title: string | null
				source_author: string | null
				source_type: string | null
				rights_status: string | null
			}[]
		>`select c.answer_id, c.ordinal, c.source_id, c.source_revision_id, c.span_id, c.quote,
				s.title as source_title, s.author as source_author,
				s.source_type as source_type, s.rights_status as rights_status
			from citations c
			join sources s on s.id = c.source_id
			where c.answer_id = any(${answerIds}::uuid[])
			order by c.ordinal asc`
		for (const c of citRows) {
			const list = citationsByAnswer.get(c.answer_id) ?? []
			list.push({
				ordinal: c.ordinal,
				sourceId: c.source_id,
				sourceRevisionId: c.source_revision_id,
				spanId: c.span_id,
				quote: c.quote ?? '',
				sourceTitle: c.source_title ?? undefined,
				sourceAuthor: c.source_author ?? undefined,
				sourceType: c.source_type ?? undefined,
				rightsStatus: c.rights_status ?? undefined,
			})
			citationsByAnswer.set(c.answer_id, list)
		}
	}

	const decisionsByTrace = new Map<
		string,
		{ decision: string; rationale: string; assessmentStatus: string }
	>()
	if (traceIds.length > 0) {
		const decRows = await sql<
			{
				trace_id: string
				decision: string
				rationale: string
				assessment_status: string | null
			}[]
		>`select trace_id, decision, rationale, assessment_status
			from response_decisions
			where trace_id = any(${traceIds}::uuid[])`
		for (const d of decRows) {
			decisionsByTrace.set(d.trace_id, {
				decision: d.decision,
				rationale: d.rationale,
				assessmentStatus: d.assessment_status ?? 'sufficient',
			})
		}
	}

	const answerRows =
		answerIds.length > 0
			? await sql<
					{
						id: string
						trace_id: string
						status: string
						provider: string | null
						model: string | null
					}[]
				>`select id, trace_id, status, provider, model
			from answers
			where id = any(${answerIds}::uuid[])`
			: []
	const answersById = new Map(answerRows.map((a) => [a.id, a]))

	return {
		conversationId: conversation.id,
		title: conversation.title,
		messages: messages.map((m) => {
			const ans = m.answer_id ? answersById.get(m.answer_id) : null
			const dec = m.trace_id ? decisionsByTrace.get(m.trace_id) : null
			const sections = m.answer_id
				? (sectionsByAnswer.get(m.answer_id) ?? [])
				: []
			const citations = m.answer_id
				? (citationsByAnswer.get(m.answer_id) ?? [])
				: []

			let answerData = null
			if (ans && (ans.status === 'answered' || sections.length > 0)) {
				answerData = {
					id: ans.id,
					status: ans.status,
					provider: ans.provider,
					model: ans.model,
					sections,
					citations,
					verification: deriveVerification({
						status: 'answered',
						decision: {
							decision: (dec?.decision ??
								'answer') as ResponseDecisionOutcome['decision'],
							rationale: dec?.rationale ?? '',
							languageConstraints: [],
							assessmentStatus: (dec?.assessmentStatus ??
								'sufficient') as ResponseDecisionOutcome['assessmentStatus'],
						},
						assessment: null,
						citationsOk: citations.length > 0,
						citedCount: citations.length,
					}),
					generation: {
						mode:
							ans.provider && ans.provider !== 'builtin-compose'
								? ('llm_rag' as const)
								: ('deterministic_rag' as const),
						provider: ans.provider ?? '',
						model: ans.model ?? '',
						// exact fallback reasons are live-turn surface only until
						// OPS-AI-001 persists them per answer
						fallbackReason: null,
					},
				}
			}

			let decisionData = null
			if (dec) {
				decisionData = {
					decision: dec.decision,
					rationale: dec.rationale,
					userOutcome:
						dec.decision === 'escalate'
							? 'needs_scholar_review'
							: dec.decision === 'abstain'
								? 'insufficient_evidence'
								: 'answered',
				}
			}

			return {
				id: m.id,
				ordinal: m.ordinal,
				role: m.role,
				content: m.content,
				createdAt: m.created_at,
				answerId: m.answer_id,
				traceId: m.trace_id,
				answerStatus: m.answer_status,
				answer: answerData,
				decision: decisionData,
			}
		}),
	}
}
