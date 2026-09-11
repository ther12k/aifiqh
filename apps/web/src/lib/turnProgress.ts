/**
 * Pipeline progress stages (UX-AI-001). The client renders STATUS — never
 * model tokens. The final answer still arrives only through the POST
 * response after the full validation stack passes.
 */

export type TurnStage =
	| 'searching_sources'
	| 'checking_evidence'
	| 'composing_answer'
	| 'verifying_citations'
	| 'done'

export interface TurnProgressEvent {
	seq: number
	conversationId: string
	stage: TurnStage
	at: string
}

/** pipeline order — used to never move backwards on out-of-order events */
export const TURN_STAGE_ORDER: TurnStage[] = [
	'searching_sources',
	'checking_evidence',
	'composing_answer',
	'verifying_citations',
	'done',
]

export const TURN_STAGE_LABELS: Record<TurnStage, string> = {
	searching_sources: 'Mencari sumber…',
	checking_evidence: 'Memeriksa dalil…',
	composing_answer: 'Menyusun jawaban…',
	verifying_citations: 'Memverifikasi rujukan…',
	done: 'Selesai',
}

export function isTurnStage(value: unknown): value is TurnStage {
	return (
		typeof value === 'string' && (TURN_STAGE_ORDER as string[]).includes(value)
	)
}

/** parse one SSE `event: progress` payload; tolerant of garbage */
export function parseProgressEvent(data: string): TurnProgressEvent | null {
	try {
		const raw = JSON.parse(data) as Record<string, unknown>
		if (!isTurnStage(raw.stage) || typeof raw.at !== 'string') return null
		if (typeof raw.seq !== 'number' || typeof raw.conversationId !== 'string') {
			return null
		}
		return {
			seq: raw.seq,
			conversationId: raw.conversationId,
			stage: raw.stage,
			at: raw.at,
		}
	} catch {
		return null
	}
}

export interface ProgressView {
	stage: TurnStage
	label: string
}

/**
 * The stage to display: among events from THIS turn only (at >= sinceMs),
 * the FURTHEST in pipeline order — the answer never walks backwards.
 * null → the client keeps its static typing indicator (no-streaming
 * fallback client, per the issue).
 */
export function progressStageForTurn(
	events: TurnProgressEvent[],
	sinceMs: number,
): ProgressView | null {
	let best: TurnProgressEvent | null = null
	for (const event of events) {
		if (new Date(event.at).getTime() < sinceMs) continue
		if (event.stage === 'done') continue
		if (
			!best ||
			TURN_STAGE_ORDER.indexOf(event.stage) >
				TURN_STAGE_ORDER.indexOf(best.stage)
		) {
			best = event
		}
	}
	if (!best) return null
	return { stage: best.stage, label: TURN_STAGE_LABELS[best.stage] }
}
