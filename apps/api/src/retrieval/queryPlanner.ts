import type { Principal } from '@aifiqh/shared'
import type postgres from 'postgres'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { normalizeQuery } from './queryNormalization'

export const PLANNER_VERSION = 'query-planner-v1'

export type QueryIntent =
	| 'exact_lookup'
	| 'standard'
	| 'comparison'
	| 'calculation'
	| 'research'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface QueryPlan {
	intent: QueryIntent
	/** retrieval lanes that will run, in execution order */
	lanes: Array<'exact_identifier' | 'exact_quote' | 'lexical' | 'vector'>
	/** filters derived from the query, merged with caller-requested scope */
	filters: {
		madhhab?: string[]
		language?: string
		topicPath?: string[]
	}
	/** caller-requested scope is retained verbatim; planner never narrows it */
	requestedScope: string[]
	mode: 'grounded_only' | 'allow_general_knowledge'
	contextProfile: 'brief' | 'standard' | 'detailed'
	risk: {
		level: RiskLevel
		reasonCodes: string[]
	}
	language: {
		detected: 'id' | 'ar' | 'mixed'
		normalizedQuery: string
	}
	/** rule-first planner reasons; model adapter may append its own */
	plannerReasons: string[]
}

export interface PlanDecision {
	plan: QueryPlan
	reasonCodes: string[]
	confidence: number
}

/**
 * Rule-first query planner (RAG-002). Classifies intent, risk, filters, and
 * retrieval lanes deterministically from the (normalized) query; a model
 * adapter can refine later, but rules always produce a complete plan.
 *
 * Reason codes are machine-readable and surface WHY a decision was made,
 * including low-confidence/risk conditions.
 */
export function planQuery(input: {
	originalQuery: string
	requestedScope?: string[]
	requestedMadhhab?: string[]
	mode?: 'grounded_only' | 'allow_general_knowledge'
}): PlanDecision {
	const normalized = normalizeQuery(input.originalQuery)
	const reasonCodes: string[] = []
	const plannerReasons: string[] = []

	// --- intent classification (rule-first) -------------------------------
	const q = normalized.normalized.toLowerCase()
	const hasArabic = /[؀-ۿ]/.test(normalized.normalized)

	let intent: QueryIntent = 'standard'

	// exact identifier: quoted strings, kitab/hadith references with numbers
	const quoted = input.originalQuery.match(/["“”«]([^"”»]{3,})["“”»]/)
	const referenceLike =
		/(?:hr\.|hadits|riwayat|no\.?|juz|hal\.?|halaman)\s*\d+|(?:qs|q\.s\.?|surat)\s+\d+/i.test(
			input.originalQuery,
		)
	if (quoted || referenceLike) {
		intent = 'exact_lookup'
		reasonCodes.push(quoted ? 'EXACT_QUOTE_PRESENT' : 'REFERENCE_PATTERN')
		plannerReasons.push(
			quoted
				? 'quoted text → exact_quote lane priority'
				: 'reference pattern detected',
		)
	}

	// comparison: perbandingan/beda/lebih…dari/perbedaan pendapat
	if (
		/(perbandingan|bandingkan|beda(nya)?|perbedaan|khilafiyah|perbedaan pendapat|mana yang (lebih )?(kuat|benar)|lebih .+ dari)/i.test(
			q,
		)
	) {
		intent = 'comparison'
		reasonCodes.push('COMPARISON_KEYWORDS')
	}

	// calculation: hitung/nisab/berapa/zakat numbers
	if (/(hitung|hitunglah|nisab|berapa|kalkulasi|2\.5\s*%|persen)/i.test(q)) {
		intent = 'calculation'
		reasonCodes.push('CALCULATION_KEYWORDS')
	}

	// research: definisi lengkap/makalah/landasan/jenis-jenis/apa saja
	if (
		intent === 'standard' &&
		/(jenis-jenis|macam-macam|apa saja|landasan hukum|secara lengkap|pembahasan)/i.test(
			q,
		)
	) {
		intent = 'research'
		reasonCodes.push('RESEARCH_BREADTH_KEYWORDS')
	}

	// --- lanes --------------------------------------------------------------
	const lanes: QueryPlan['lanes'] = []
	if (intent === 'exact_lookup') {
		lanes.push(quoted ? 'exact_quote' : 'exact_identifier')
	}
	lanes.push('lexical')
	if (intent !== 'exact_lookup') {
		lanes.push('vector')
	}

	// --- filters --------------------------------------------------------------
	const filters: QueryPlan['filters'] = {}
	const madhhabMentioned: string[] = []
	for (const m of [
		'hanafi',
		'maliki',
		'syafi\u2019i',
		'syafii',
		'shafi\u2019i',
		'shafii',
		'hanbali',
	]) {
		if (new RegExp(m, 'i').test(q)) {
			madhhabMentioned.push(
				m.startsWith('s') || m.startsWith('s')
					? 'shafii'
					: m === 'hanbali'
						? 'hanbali'
						: m.startsWith('h')
							? 'hanafi'
							: 'maliki',
			)
		}
	}
	const uniqueMadhhab = [...new Set(madhhabMentioned)]
	if (uniqueMadhhab.length > 0) {
		filters.madhhab = uniqueMadhhab
		reasonCodes.push('MADHHAB_FILTER_FROM_QUERY')
	}
	if (normalized.detection.language !== 'mixed') {
		filters.language = normalized.detection.language
	}

	// --- risk --------------------------------------------------------------
	let riskLevel: RiskLevel = 'low'
	if (intent === 'comparison') {
		riskLevel = 'high'
		reasonCodes.push('COMPARISON_RISK_MULTI_MADHHAB')
	}
	if (intent === 'calculation') {
		riskLevel = 'medium'
		reasonCodes.push('CALCULATION_REQUIRES_PRECISION')
	}
	if (normalized.normalized.trim().length < 3) {
		riskLevel = 'high'
		reasonCodes.push('QUERY_TOO_SHORT')
	}
	if (normalized.detection.language === 'mixed') {
		if (riskLevel === 'low') riskLevel = 'medium'
		reasonCodes.push('MIXED_LANGUAGE')
	}

	// --- confidence --------------------------------------------------------
	let confidence = 0.9
	if (intent === 'standard') confidence = 0.7
	if (reasonCodes.includes('MIXED_LANGUAGE')) confidence -= 0.1
	if (reasonCodes.includes('QUERY_TOO_SHORT')) confidence = 0.2
	confidence = Math.max(0.05, Math.min(0.95, confidence))

	const plan: QueryPlan = {
		intent,
		lanes,
		filters,
		// caller-requested scope retained verbatim — never narrowed
		requestedScope: input.requestedScope ?? [],
		mode: input.mode ?? 'grounded_only',
		contextProfile:
			intent === 'research' || intent === 'comparison'
				? 'detailed'
				: 'standard',
		risk: { level: riskLevel, reasonCodes: [...new Set(reasonCodes)] },
		language: {
			detected: normalized.detection.language,
			normalizedQuery: normalized.normalized,
		},
		plannerReasons,
	}

	return {
		plan,
		reasonCodes: plan.risk.reasonCodes,
		confidence,
	}
}

export interface PersistedPlanResult {
	traceId: string
	planId: string
	plan: QueryPlan
	reasonCodes: string[]
	confidence: number
}

/**
 * Plan a query and persist the trace + plan (RAG-002). The trace is created
 * `running` and left open for the retrieval lanes to fill; the plan itself
 * is stored immutable next to it.
 */
export async function planAndPersistQuery(
	sql: Sql,
	principal: Principal,
	input: {
		originalQuery: string
		indexReleaseId?: string
		requestedScope?: string[]
		requestedMadhhab?: string[]
		mode?: 'grounded_only' | 'allow_general_knowledge'
		conversationId?: string
	},
	traceId?: string,
): Promise<PersistedPlanResult> {
	const decision = planQuery({
		originalQuery: input.originalQuery,
		requestedScope: input.requestedScope,
		requestedMadhhab: input.requestedMadhhab,
		mode: input.mode,
	})

	return await sql.begin(async (tx) => {
		const [trace] = await tx<{ id: string }[]>`
			insert into retrieval_traces (
				tenant_id, user_id, conversation_id,
				query_original, query_normalized, language_detection,
				index_release_id, status
			)
			values (
				${principal.tenantId}::uuid,
				${principal.userId}::uuid,
				${input.conversationId ? sql`${input.conversationId}::uuid` : null},
				${input.originalQuery},
				${decision.plan.language.normalizedQuery},
				${tx.json(decision.plan.language as unknown as postgres.JSONValue)},
				${input.indexReleaseId ? sql`${input.indexReleaseId}::uuid` : null},
				'running'
			)
			returning id`

		const [planRow] = await tx<{ id: string }[]>`
			insert into query_plans (trace_id, plan, planner_version, reason_codes, confidence)
			values (
				${trace.id}::uuid,
				${tx.json(decision.plan as unknown as postgres.JSONValue)},
				${PLANNER_VERSION},
				${decision.plan.risk.reasonCodes},
				${decision.confidence}
			)
			returning id`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'retrieval.planned',
			entityType: 'query_plan',
			entityId: planRow.id,
			afterRef: {
				traceId: trace.id,
				intent: decision.plan.intent,
				riskLevel: decision.plan.risk.level,
			},
			traceId,
		})

		return {
			traceId: trace.id,
			planId: planRow.id,
			plan: decision.plan,
			reasonCodes: decision.reasonCodes,
			confidence: decision.confidence,
		}
	})
}
