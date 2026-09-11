import type { Principal, StructuredAnswer } from '@aifiqh/shared'
import type postgres from 'postgres'
import type { Sql } from '../db/client'

/**
 * Complete answer trace persistence with revision pins (TRACE-001).
 *
 * An answer is only as trustworthy as the graph around it: the final
 * write is ONE transaction covering message, answer, sections, claims,
 * evidence links, citations and the retrieval-trace close — a crash
 * leaves no half-persisted answer.
 *
 * Publishing additionally verifies the PIN SET: a published answer must
 * carry its retrieval trace (completed), query plan, context manifest and
 * citations; a missing pin is a classified failure, never a silent gap.
 * Failed/abstained attempts are preserved verbatim for audit — retried
 * answers live on their own message with their own trace.
 */

export const ANSWER_TRACE_VERSION = 'answer-trace-v1'

export class AnswerTraceError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'AnswerTraceError'
		this.code = code
	}
}

/** OPS-AI-001: one real model call of this turn (provider latency / tokens series) */
export interface TurnInvocationRecord {
	provider: string
	model: string
	promptTokens: number | null
	completionTokens: number | null
	latencyMs: number | null
}

/**
 * OPS-AI-001: turn-level generation summary stored on answers.metadata and
 * aggregated by the ops dashboard. The fallback vocabulary is AI-002's.
 */
export interface AnswerTurnMetadata {
	/** AI-002 structured fallback reason (null when a model produced the answer) */
	fallbackReason: string | null
	generationSource: 'model' | 'deterministic_composer' | 'none'
	/** AI-004 chain attempts with their per-attempt outcome */
	attempts: Array<{
		provider: string
		model: string
		source: string
		outcome: string
	}>
	/** middle verification layer: do cited passages support the material claims
	 * (unsupportedLinks = claim-evidence pairs the scorer rejected) */
	claimSupport?: { allSupported: boolean; unsupportedLinks: number }
}

export interface FinalizeAnswerInput {
	conversationId: string
	/** retrieval trace created by the retrieval pipeline (must be running) */
	traceId: string
	answer: StructuredAnswer
	citations: Array<{
		ordinal: number
		sourceId: string
		sourceRevisionId: string
		pageId?: string | null
		sectionId?: string | null
		spanId: string
		quote?: string | null
	}>
	provider?: string
	model?: string
	promptVersionId?: string | null
	modelConfigId?: string | null
	/** LLM-REPAIR-001: the pipeline's single bounded repair attempt trace */
	repairTrace?: {
		attempted: boolean
		result:
			| 'not_needed'
			| 'success'
			| 'failed'
			| 'skipped_gateway_error'
			| 'skipped_incomplete_generation'
		instruction: string | null
	}
	/** OPS-AI-001: model calls to persist (tokens + latency series) */
	invocations?: TurnInvocationRecord[]
	/** OPS-AI-001: turn-level generation summary for the ops dashboard */
	metadata?: AnswerTurnMetadata
}

export interface FinalizeResult {
	messageId: string
	answerId: string
}

/** Persist the full grounded answer and close the trace — one transaction. */
export async function finalizeGroundedAnswer(
	sql: Sql,
	principal: Principal,
	input: FinalizeAnswerInput,
): Promise<FinalizeResult> {
	return await sql.begin(async (tx) => {
		const [trace] = await tx<{ id: string; status: string }[]>`
			select id, status from retrieval_traces
			where id = ${input.traceId}::uuid and tenant_id = ${principal.tenantId}::uuid`
		if (!trace)
			throw new AnswerTraceError(
				'TRACE_NOT_FOUND',
				'retrieval trace not found in tenant',
			)
		if (trace.status !== 'running')
			throw new AnswerTraceError(
				'TRACE_NOT_OPEN',
				`trace status is ${trace.status}, expected running`,
			)

		const [conv] = await tx<{ id: string }[]>`
			select id from conversations
			where id = ${input.conversationId}::uuid and tenant_id = ${principal.tenantId}::uuid`
		if (!conv)
			throw new AnswerTraceError(
				'CONVERSATION_NOT_FOUND',
				'conversation not found in tenant',
			)

		const [nextOrdinal] = await tx<{ n: number }[]>`
			select coalesce(max(ordinal), 0) + 1 as n from messages
			where conversation_id = ${input.conversationId}::uuid`

		const directAnswer =
			input.answer.sections.find((s) => s.kind === 'direct_answer')?.markdown ??
			''

		const [message] = await tx<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
			values (${input.conversationId}::uuid, ${nextOrdinal.n}, 'assistant', ${directAnswer}, ${input.traceId}::uuid)
			returning id`

		const [answer] = await tx<{ id: string }[]>`
			insert into answers (
				message_id, trace_id, prompt_version_id, model_config_id,
				provider, model, status, metadata
			) values (
				${message.id}::uuid, ${input.traceId}::uuid,
				${input.promptVersionId ? sql`${input.promptVersionId}::uuid` : null},
				${input.modelConfigId ? sql`${input.modelConfigId}::uuid` : null},
				${input.provider ?? null}, ${input.model ?? null}, 'draft',
				${sql.json((input.metadata ?? {}) as never)}
			)
			returning id`
		await tx`update messages set answer_id = ${answer.id}::uuid where id = ${message.id}::uuid`

		// OPS-AI-001: one row per real model call — the provider latency and
		// tokens-per-turn series on the ops dashboard aggregate these
		for (const inv of input.invocations ?? []) {
			await tx`
				insert into model_invocations (
					answer_id, provider, model, prompt_tokens, completion_tokens, latency_ms
				) values (
					${answer.id}::uuid, ${inv.provider}, ${inv.model},
					${inv.promptTokens ?? 0}, ${inv.completionTokens ?? 0}, ${inv.latencyMs ?? null}
				)`
		}

		// LLM-REPAIR-001: persist the single bounded repair attempt — the
		// schema pins attempt_no = 1, so a second repair can never be stored
		if (input.repairTrace?.attempted) {
			await tx`
				insert into repair_attempts (answer_id, attempt_no, instruction, result)
				values (${answer.id}::uuid, 1, ${input.repairTrace.instruction ?? ''},
					${input.repairTrace.result})`
		}

		// each claim persists EXACTLY ONCE, attached to the first section
		// that surfaces it (a claim cited by several sections is still one claim)
		const claimSection = new Map<string, string>()
		for (const [idx, section] of input.answer.sections.entries()) {
			const [sectionRow] = await tx<{ id: string }[]>`
				insert into answer_sections (answer_id, ordinal, kind, content)
				values (${answer.id}::uuid, ${idx + 1}, ${section.kind}, ${section.markdown})
				returning id`
			for (const claimId of section.claimIds ?? []) {
				if (!claimSection.has(claimId)) claimSection.set(claimId, sectionRow.id)
			}
		}
		for (const claim of input.answer.claims) {
			await insertClaim(
				tx,
				answer.id,
				claimSection.get(claim.id) ?? null,
				claim,
			)
		}

		for (const c of input.citations) {
			await tx`
				insert into citations (
					answer_id, ordinal, source_id, source_revision_id,
					page_id, section_id, span_id, quote
				) values (
					${answer.id}::uuid, ${c.ordinal}, ${c.sourceId}::uuid, ${c.sourceRevisionId}::uuid,
					${c.pageId ? sql`${c.pageId}::uuid` : null},
					${c.sectionId ? sql`${c.sectionId}::uuid` : null},
					${c.spanId}::uuid, ${c.quote ?? null}
				)`
		}

		// the trace closes atomically with the answer write
		await tx`update retrieval_traces
			set status = 'completed', completed_at = now()
			where id = ${input.traceId}::uuid`

		return { messageId: message.id, answerId: answer.id }
	})
}

type TxSql = Sql | postgres.TransactionSql

async function insertClaim(
	tx: TxSql,
	answerId: string,
	sectionId: string | null,
	claim: StructuredAnswer['claims'][number],
): Promise<void> {
	const claimKind = claim.evidence.some((l) => l.relation === 'direct')
		? 'direct'
		: 'synthesis'
	const [claimRow] = await tx<{ id: string }[]>`
		insert into answer_claims (answer_id, section_id, ordinal, claim_text, claim_kind)
		values (
			${answerId}::uuid,
			${sectionId ? tx`${sectionId}::uuid` : null},
			0, ${claim.text}, ${claimKind}
		)
		returning id`
	for (const link of claim.evidence) {
		// evidence id is the retrieval unit id (LLM-004/005 contract)
		await tx`
			insert into claim_evidence (claim_id, unit_id)
			values (${claimRow.id}::uuid, ${link.evidenceId}::uuid)`
	}
}

export interface PinCheck {
	pin: string
	present: boolean
}

/** The pin set every published answer must carry. */
export async function checkAnswerPins(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<{ complete: boolean; pins: PinCheck[] }> {
	const [row] = await sql<
		{
			trace_id: string | null
			trace_status: string | null
			has_plan: boolean
			has_manifest: boolean
			citation_count: number
		}[]
	>`select a.trace_id, rt.status as trace_status,
			exists (select 1 from query_plans qp where qp.trace_id = a.trace_id) as has_plan,
			exists (select 1 from context_manifests cm where cm.trace_id = a.trace_id) as has_manifest,
			(select count(*) from citations c where c.answer_id = a.id) as citation_count
		from answers a
		join messages m on m.id = a.message_id
		join conversations cv on cv.id = m.conversation_id
		left join retrieval_traces rt on rt.id = a.trace_id
		where a.id = ${answerId}::uuid and cv.tenant_id = ${principal.tenantId}::uuid`
	if (!row)
		throw new AnswerTraceError('ANSWER_NOT_FOUND', 'answer not found in tenant')

	const pins: PinCheck[] = [
		{ pin: 'retrieval_trace', present: row.trace_id !== null },
		{ pin: 'trace_completed', present: row.trace_status === 'completed' },
		{ pin: 'query_plan', present: row.has_plan },
		{ pin: 'context_manifest', present: row.has_manifest },
		{ pin: 'citations', present: row.citation_count > 0 },
	]
	return { complete: pins.every((p) => p.present), pins }
}

/** Publish an answer only when its pin set is complete. */
export async function publishAnswerWithPins(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<{ published: true; pins: PinCheck[] }> {
	const check = await checkAnswerPins(sql, principal, answerId)
	if (!check.complete) {
		throw new AnswerTraceError(
			'MISSING_PIN',
			`cannot publish: missing pins ${check.pins
				.filter((p) => !p.present)
				.map((p) => p.pin)
				.join(', ')}`,
		)
	}
	// draft → validated → published (trigger-enforced path)
	await sql`update answers set status = 'validated' where id = ${answerId}::uuid`
	await sql`update answers set status = 'published' where id = ${answerId}::uuid`
	return { published: true, pins: check.pins }
}

export interface AnswerGraph {
	answer: {
		id: string
		status: string
		provider: string | null
		model: string | null
		promptVersionId: string | null
		traceId: string
		createdAt: string
		publishedAt: string | null
	}
	message: { id: string; ordinal: number; content: string } | null
	sections: Array<{ ordinal: number; kind: string; content: string }>
	claims: Array<{
		id: string
		text: string
		kind: string
		sectionOrdinal: number | null
		evidence: Array<{ claimEvidenceId: string; unitId: string | null }>
	}>
	citations: Array<{
		ordinal: number
		sourceId: string
		sourceRevisionId: string
		spanId: string
		quote: string | null
		quoteMatchStatus: string | null
	}>
	trace: {
		id: string
		status: string
		query: string
		indexReleaseId: string | null
	} | null
	plan: { plannerVersion: string; reasonCodes: string[] } | null
	manifest: {
		id: string
		profile: string
		tokenBudget: number
		tokenTotal: number
		manifestHash: string
		items: Array<{
			ordinal: number
			unitId: string | null
			relation: string | null
			tokenEstimate: number
			included: boolean
		}>
	} | null
	assessment: { status: string; reasons: unknown } | null
	decision: {
		decision: string
		languageConstraints: string[]
		rationale: string
	} | null
	pins: PinCheck[]
}

/** Authorized lookup returning the full answer graph. */
export async function getAnswerGraph(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<AnswerGraph> {
	const [answer] = await sql<
		{
			id: string
			status: string
			provider: string | null
			model: string | null
			prompt_version_id: string | null
			trace_id: string
			created_at: string
			published_at: string | null
		}[]
	>`select a.id, a.status, a.provider, a.model, a.prompt_version_id,
			a.trace_id, a.created_at, a.published_at
		from answers a
		join messages m on m.id = a.message_id
		join conversations cv on cv.id = m.conversation_id
		where a.id = ${answerId}::uuid and cv.tenant_id = ${principal.tenantId}::uuid`
	if (!answer)
		throw new AnswerTraceError('ANSWER_NOT_FOUND', 'answer not found in tenant')

	const [message] = await sql<
		{ id: string; ordinal: number; content: string }[]
	>`
		select id, ordinal, content from messages where answer_id = ${answerId}::uuid`

	const sections = await sql<
		{ ordinal: number; kind: string; content: string }[]
	>`
		select ordinal, kind, content from answer_sections
		where answer_id = ${answerId}::uuid order by ordinal`

	const claims = await sql<
		{
			id: string
			claim_text: string
			claim_kind: string
			section_ordinal: number | null
		}[]
	>`select ac.id, ac.claim_text, ac.claim_kind, s.ordinal as section_ordinal
		from answer_claims ac
		left join answer_sections s on s.id = ac.section_id
		where ac.answer_id = ${answerId}::uuid`

	const evidenceByClaim = new Map<
		string,
		Array<{ claimEvidenceId: string; unitId: string | null }>
	>()
	const evidenceRows = await sql<
		{ claim_id: string; id: string; unit_id: string | null }[]
	>`select ce.claim_id, ce.id, ce.unit_id from claim_evidence ce
		join answer_claims ac on ac.id = ce.claim_id
		where ac.answer_id = ${answerId}::uuid`
	for (const row of evidenceRows) {
		const list = evidenceByClaim.get(row.claim_id) ?? []
		list.push({ claimEvidenceId: row.id, unitId: row.unit_id })
		evidenceByClaim.set(row.claim_id, list)
	}

	const citations = await sql<
		{
			ordinal: number
			source_id: string
			source_revision_id: string
			span_id: string
			quote: string | null
			quote_match_status: string | null
		}[]
	>`select ordinal, source_id, source_revision_id, span_id, quote, quote_match_status
		from citations where answer_id = ${answerId}::uuid order by ordinal`

	const [trace] = await sql<
		{
			id: string
			status: string
			query_original: string
			index_release_id: string | null
		}[]
	>`select id, status, query_original, index_release_id from retrieval_traces
		where id = ${answer.trace_id}::uuid`

	const [plan] = await sql<
		{ planner_version: string; reason_codes: string[] }[]
	>`
		select planner_version, reason_codes from query_plans
		where trace_id = ${answer.trace_id}::uuid`

	const [manifest] = await sql<
		{
			id: string
			profile: string
			token_budget: number
			token_total: number
			manifest_hash: string
		}[]
	>`select id, profile, token_budget, token_total, manifest_hash
		from context_manifests where trace_id = ${answer.trace_id}::uuid`
	const items = manifest
		? await sql<
				{
					ordinal: number
					unit_id: string | null
					relation: string | null
					token_estimate: number
					included: boolean
				}[]
			>`select ordinal, unit_id, relation, token_estimate, included
				from context_manifest_items where manifest_id = ${manifest.id}::uuid order by ordinal`
		: []

	const [assessment] = await sql<{ status: string; reasons: unknown }[]>`
		select status, reasons from evidence_assessments where trace_id = ${answer.trace_id}::uuid`

	const [decision] = await sql<
		{ decision: string; language_constraints: string[]; rationale: string }[]
	>`select decision, language_constraints, rationale from response_decisions
		where trace_id = ${answer.trace_id}::uuid`

	const { pins } = await checkAnswerPins(sql, principal, answerId)

	return {
		answer: {
			id: answer.id,
			status: answer.status,
			provider: answer.provider,
			model: answer.model,
			promptVersionId: answer.prompt_version_id,
			traceId: answer.trace_id,
			createdAt: answer.created_at,
			publishedAt: answer.published_at,
		},
		message: message ?? null,
		sections,
		claims: claims.map((c) => ({
			id: c.id,
			text: c.claim_text,
			kind: c.claim_kind,
			sectionOrdinal: c.section_ordinal,
			evidence: evidenceByClaim.get(c.id) ?? [],
		})),
		citations: citations.map((c) => ({
			ordinal: c.ordinal,
			sourceId: c.source_id,
			sourceRevisionId: c.source_revision_id,
			spanId: c.span_id,
			quote: c.quote,
			quoteMatchStatus: c.quote_match_status,
		})),
		trace: trace
			? {
					id: trace.id,
					status: trace.status,
					query: trace.query_original,
					indexReleaseId: trace.index_release_id,
				}
			: null,
		plan: plan
			? { plannerVersion: plan.planner_version, reasonCodes: plan.reason_codes }
			: null,
		manifest: manifest
			? {
					id: manifest.id,
					profile: manifest.profile,
					tokenBudget: manifest.token_budget,
					tokenTotal: manifest.token_total,
					manifestHash: manifest.manifest_hash,
					items: items.map((i) => ({
						ordinal: i.ordinal,
						unitId: i.unit_id,
						relation: i.relation,
						tokenEstimate: i.token_estimate,
						included: i.included,
					})),
				}
			: null,
		assessment: assessment ?? null,
		decision: decision
			? {
					decision: decision.decision,
					languageConstraints: decision.language_constraints,
					rationale: decision.rationale,
				}
			: null,
		pins,
	}
}

// ---------------------------------------------------------------------------
// Answer forensics (#114): after a full restore, a historical answer must be
// EXPLAINABLE from the restored database alone — what was answered, from
// which evidence, under which prompt/model/retrieval configuration, and how
// each citation traces back to an identifiable original publication.
// The secret itself is nowhere in the chain (only its external reference).
// ---------------------------------------------------------------------------

export interface AnswerForensics {
	graph: AnswerGraph
	prompt: {
		templateKey: string | null
		version: number | null
		body: string | null
	} | null
	generation: {
		providerKey: string | null
		providerType: string | null
		baseUrl: string | null
		secretRef: string | null
		modelId: string | null
		contextWindow: number | null
	} | null
	retrieval: {
		compilerVersion: string | null
		normalizationProfile: {
			key: string
			version: number
			ruleset: unknown
		} | null
		embeddingModel: {
			provider: string
			modelId: string
			version: string
			dimensions: number
		} | null
		knowledgeReleaseId: string | null
		indexReleaseId: string | null
	} | null
	provenance: Array<{
		citationOrdinal: number
		sourceId: string
		title: string
		author: string
		edition: string | null
		publisher: string | null
		revisionNumber: number
		revisionStatus: string
		spanKey: string
		acquisitionMethod: string | null
		policyReference: string | null
	}>
}

/** Assemble the full forensic explanation for one historical answer. */
export async function buildAnswerForensics(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<AnswerForensics> {
	const graph = await getAnswerGraph(sql, principal, answerId)

	// the exact prompt body that produced the response (pinned version)
	let prompt: AnswerForensics['prompt'] = null
	if (graph.answer.promptVersionId) {
		const [pv] = await sql<
			{ template_key: string | null; version: number; body: string }[]
		>`select pt.key as template_key, pv.version, pv.body
			from prompt_versions pv
			join prompt_templates pt on pt.id = pv.template_id
			where pv.id = ${graph.answer.promptVersionId}::uuid`
		if (pv)
			prompt = {
				templateKey: pv.template_key,
				version: pv.version,
				body: pv.body,
			}
	}

	// what generated the text: provider identity + secret REFERENCE (never
	// a key — none is stored anywhere). modelConfigId null (builtin composer)
	// is itself the honest explanation: the deterministic composer ran.
	let generation: AnswerForensics['generation'] = null
	const [genRow] = await sql<
		{
			model_config_id: string | null
			provider_key: string | null
			provider_type: string | null
			base_url: string | null
			secret_ref: string | null
			model_id: string | null
			context_window: number | null
		}[]
	>`select mc.id as model_config_id, pc.key as provider_key,
			pc.provider as provider_type, pc.base_url, psr.secret_ref,
			mc.model_id, mc.context_window
		from answers a
		left join model_configs mc on mc.id = a.model_config_id
		left join provider_configs pc on pc.id = mc.provider_config_id
		left join provider_secret_refs psr on psr.provider_config_id = pc.id
		where a.id = ${answerId}::uuid`
	if (genRow?.model_config_id) {
		generation = {
			providerKey: genRow.provider_key,
			providerType: genRow.provider_type,
			baseUrl: genRow.base_url,
			secretRef: genRow.secret_ref,
			modelId: genRow.model_id,
			contextWindow: genRow.context_window,
		}
	}

	// the retrieval stack the evidence came from
	let retrieval: AnswerForensics['retrieval'] = null
	if (graph.trace?.indexReleaseId) {
		const [row] = await sql<
			{
				compiler_version: string
				np_key: string | null
				np_version: number | null
				np_ruleset: unknown
				emb_provider: string | null
				emb_model: string | null
				emb_version: string | null
				emb_dimensions: number | null
				knowledge_release_id: string | null
			}[]
		>`select ic.compiler_version,
				np.key as np_key, np.version as np_version, np.ruleset as np_ruleset,
				em.provider as emb_provider, em.model_id as emb_model,
				em.version as emb_version, em.dimensions as emb_dimensions,
				ir.knowledge_release_id
			from index_releases ir
			join index_configurations ic on ic.id = ir.configuration_id
			left join normalization_profiles np on np.id = ic.normalization_profile_id
			left join embedding_models em on em.id = ic.embedding_model_id
			where ir.id = ${graph.trace.indexReleaseId}::uuid`
		if (row)
			retrieval = {
				compilerVersion: row.compiler_version,
				normalizationProfile:
					row.np_key && row.np_version !== null
						? {
								key: row.np_key,
								version: row.np_version,
								ruleset: row.np_ruleset,
							}
						: null,
				embeddingModel:
					row.emb_provider && row.emb_model
						? {
								provider: row.emb_provider,
								modelId: row.emb_model,
								version: row.emb_version ?? '',
								dimensions: row.emb_dimensions ?? 0,
							}
						: null,
				knowledgeReleaseId: row.knowledge_release_id,
				indexReleaseId: graph.trace.indexReleaseId,
			}
	}

	// each citation traces to the original publication + acquisition history
	const provenance: AnswerForensics['provenance'] = []
	for (const c of graph.citations) {
		const [row] = await sql<
			{
				title: string
				author: string
				edition: string | null
				publisher: string | null
				revision_number: number
				revision_status: string
				span_key: string
				acquisition_method: string | null
				policy_reference: string | null
			}[]
		>`select s.title, s.author, s.edition, s.publisher,
				sr.revision_number, sr.status as revision_status,
				ss.span_key, s.acquisition_method, s.policy_reference
			from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			join sources s on s.id = sr.source_id
			where ss.id = ${c.spanId}::uuid`
		if (row)
			provenance.push({
				citationOrdinal: c.ordinal,
				sourceId: c.sourceId,
				title: row.title,
				author: row.author,
				edition: row.edition,
				publisher: row.publisher,
				revisionNumber: row.revision_number,
				revisionStatus: row.revision_status,
				spanKey: row.span_key,
				acquisitionMethod: row.acquisition_method,
				policyReference: row.policy_reference,
			})
	}

	return { graph, prompt, generation, retrieval, provenance }
}
