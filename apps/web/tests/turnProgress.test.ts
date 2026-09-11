import { describe, expect, test } from 'bun:test'
import {
	TURN_STAGE_LABELS,
	type TurnProgressEvent,
	parseProgressEvent,
	progressStageForTurn,
} from '../src/lib/turnProgress'

function event(stage: string, at: string, seq: number): TurnProgressEvent {
	return {
		seq,
		conversationId: 'c1',
		stage: stage as TurnProgressEvent['stage'],
		at,
	}
}

describe('turnProgress stage view (UX-AI-001)', () => {
	test('every stage has an Indonesian label ending with ellipsis except done', () => {
		for (const [stage, label] of Object.entries(TURN_STAGE_LABELS)) {
			expect(label.length).toBeGreaterThan(3)
			if (stage === 'done') expect(label).toBe('Selesai')
			else expect(label.endsWith('…')).toBe(true)
		}
	})

	test('parseProgressEvent accepts valid payloads and rejects garbage', () => {
		const ok = parseProgressEvent(
			JSON.stringify({
				seq: 3,
				conversationId: 'c1',
				stage: 'composing_answer',
				at: new Date().toISOString(),
			}),
		)
		expect(ok?.stage).toBe('composing_answer')

		expect(parseProgressEvent('not json')).toBeNull()
		expect(
			parseProgressEvent(
				JSON.stringify({
					seq: 1,
					conversationId: 'c1',
					stage: 'hacked',
					at: 'x',
				}),
			),
		).toBeNull()
		expect(
			parseProgressEvent(JSON.stringify({ stage: 'done', at: 'x' })),
		).toBeNull()
	})

	test('progressStageForTurn picks the FURTHEST stage, never moves backwards', () => {
		const t = Date.now()
		const events = [
			event('searching_sources', new Date(t).toISOString(), 1),
			event('composing_answer', new Date(t + 1).toISOString(), 3),
			event('checking_evidence', new Date(t + 2).toISOString(), 2), // out of order
		]
		expect(progressStageForTurn(events, 0)?.stage).toBe('composing_answer')
	})

	test('events from previous turns (older than sinceMs) are ignored', () => {
		const old = new Date(Date.now() - 60_000).toISOString()
		const fresh = new Date().toISOString()
		const events = [
			event('verifying_citations', old, 1),
			event('searching_sources', fresh, 2),
		]
		expect(progressStageForTurn(events, Date.now() - 30_000)?.stage).toBe(
			'searching_sources',
		)
	})

	test('done never renders as a stage label', () => {
		const events = [
			event('checking_evidence', new Date().toISOString(), 1),
			event('done', new Date().toISOString(), 2),
		]
		expect(progressStageForTurn(events, 0)?.stage).toBe('checking_evidence')
		expect(
			progressStageForTurn([event('done', new Date().toISOString(), 1)], 0),
		).toBeNull()
	})
})
