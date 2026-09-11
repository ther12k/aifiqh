/**
 * AI/RAG telemetry view logic (OPS-AI-001): the operator panel model
 * built from the /ops/ai-metrics payload. Pure — no framework code.
 *
 *  - rates arrive pre-computed from the API; the view only formats them;
 *  - fallback reasons are shown with Indonesian labels, unknown codes
 *    fall back to the raw code (new telemetry must never render blank);
 *  - provider rows stay in API order (calls desc) — the dashboard does
 *    not re-sort and disagree with the payload.
 */

export interface AiProviderUsageLike {
	provider: string
	model: string
	calls: number
	avgLatencyMs: number | null
	p95LatencyMs: number | null
	promptTokens: number
	completionTokens: number
	priced: boolean
	costUsd: number | null
}

export interface SloEntryLike {
	key: string
	label: string
	target: number
	comparator: '<' | '>' | '='
	unit: 'rate' | 'ms' | 'count'
	actual: number | null
	status: 'met' | 'breached' | 'no_data'
}

export interface AiMetricsReportLike {
	version: string
	generatedAt: string
	windowHours: number
	turns: {
		total: number
		answered: number
		abstained: number
		escalated: number
		failed: number
		generationStage: number
	}
	generation: {
		attempts: number
		successfulAttempts: number
		attemptSuccessRate: number | null
		fallbackTurns: number
		turnFallbackRate: number | null
		fallbackByReason: Record<string, number>
		repair: { attempted: number; succeeded: number }
	}
	understanding: {
		rewriteFallbackByReason: Record<string, number>
		plannerFallbackByReason: Record<string, number>
		rewriteDegradations: number
		plannerDegradations: number
		rewriteDegradationRate?: number | null
		plannerDegradationRate?: number | null
	}
	rerank?: {
		evaluatedPlans: number
		fallbackRate: number | null
	}
	chatP95LatencyMs?: number | null
	citationValidation: {
		attempts: number
		failedAttempts: number
		failureRate: number | null
	}
	claimSupport: {
		evaluated: number
		failedAnswers: number
		failureRate: number | null
	}
	retrievalOffline: {
		runId: string
		setKey: string
		startedAt: string
		finishedAt: string | null
		caseCount: number
		avgRecallAtK: number | null
		hitRate: number | null
		meanFirstHitRank: number | null
		avgLatencyMs: number | null
	} | null
	providers: AiProviderUsageLike[]
	tokens: {
		turns: number
		totalPromptTokens: number
		totalCompletionTokens: number
		avgPromptTokens: number | null
		avgCompletionTokens: number | null
		pricedCalls: number
		unpricedCalls: number
		totalCost: number | null
		currency: string | null
	}
	/** CAL-005: target-vs-actual SLO rows; absent on older API payloads */
	slos?: SloEntryLike[]
}

const REASON_LABELS: Record<string, string> = {
	model_not_configured: 'model tidak terkonfigurasi',
	secret_unavailable: 'secret tidak tersedia',
	ambiguous_model_config: 'konfigurasi model ambigu',
	kill_switch: 'kill switch aktif',
	provider_error: 'galat provider',
	invalid_output: 'keluaran tidak valid',
	citation_validation_failed: 'validasi sitasi gagal',
	no_history: 'tanpa riwayat',
	rewriter_disabled: 'rewriter nonaktif',
	planner_disabled: 'planner nonaktif',
	no_model: 'tidak ada model',
	model_failed: 'model gagal',
}

export function fallbackReasonLabel(reason: string): string {
	return REASON_LABELS[reason] ?? reason
}

/** 0.2345 → "23,5%" (id decimal comma); null → "—" */
export function formatRate(rate: number | null): string {
	if (rate === null) return '—'
	return `${(rate * 100).toFixed(1).replace('.', ',')}%`
}

export function formatCount(value: number | null): string {
	return value === null ? '—' : value.toLocaleString('id-ID')
}

/** deterministic map order for the reason lists: count desc, then key */
export function reasonEntries(
	map: Record<string, number>,
): Array<{ reason: string; count: number }> {
	return Object.entries(map)
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

/** "12.3 rb" style compact tokens (id locale, dot thousands separator) */
export function formatTokens(value: number): string {
	return value.toLocaleString('id-ID')
}

export function formatCost(
	cost: number | null,
	currency: string | null,
): string {
	if (cost === null) return '—'
	const unit = currency ?? 'USD'
	return `${cost.toFixed(4).replace('.', ',')} ${unit}`
}

/** CAL-005: SLO status chips and value formatting (rates %, ms, counts) */
export function sloStatusLabel(status: SloEntryLike['status']): string {
	if (status === 'met') return 'terpenuhi'
	if (status === 'breached') return 'melewati batas'
	return 'belum ada data'
}

export function formatSloValue(
	actual: number | null,
	unit: SloEntryLike['unit'],
): string {
	if (actual === null) return '—'
	if (unit === 'rate') return formatRate(actual)
	if (unit === 'ms') return `${actual.toLocaleString('id-ID')} ms`
	return actual.toLocaleString('id-ID')
}

export function formatSloTarget(
	target: number,
	comparator: SloEntryLike['comparator'],
	unit: SloEntryLike['unit'],
): string {
	const op = comparator === '>' ? '≥' : comparator === '<' ? '<' : '='
	const value =
		unit === 'rate'
			? `${(target * 100).toFixed(1).replace('.', ',')}%`
			: unit === 'ms'
				? `${target.toLocaleString('id-ID')} ms`
				: target.toLocaleString('id-ID')
	return `${op} ${value}`
}
