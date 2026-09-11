/**
 * Pin review view logic tests (CAL-008).
 */
import { describe, expect, test } from 'bun:test'
import {
	addCandidates,
	cycleChoice,
	emptyPinSelection,
	originCounts,
	pinPayload,
	selectedCount,
	setChoice,
	worklistProgress,
} from '../src/lib/pinReviewView'

const SUGGESTED = {
	unitId: 'u-suggest',
	text: 'passage dari saran retrieval',
	sourceTitle: 'Kitab Thaharah',
	lane: 'lexical',
	origin: 'suggested' as const,
}
const MANUAL = {
	unitId: 'u-manual',
	text: 'passage dari pencarian korpus reviewer',
	sourceTitle: null,
	lane: 'manual-search',
	origin: 'manual' as const,
}
const SECOND_MANUAL = { ...MANUAL, unitId: 'u-manual-2' }

describe('pin review selection (CAL-008)', () => {
	test('addCandidates merges suggestion + manual batches without duplicates', () => {
		let state = emptyPinSelection()
		state = addCandidates(state, [SUGGESTED])
		state = addCandidates(state, [SUGGESTED, MANUAL])
		expect(state.candidates.map((c) => c.unitId)).toEqual([
			'u-suggest',
			'u-manual',
		])
		expect(state.origins['u-suggest']).toBe('suggested')
		expect(state.origins['u-manual']).toBe('manual')
	})

	test('pinPayload emits only selected candidates with correct flags and origins', () => {
		let state = addCandidates(emptyPinSelection(), [SUGGESTED, MANUAL])
		state = setChoice(state, 'u-suggest', 'must')
		state = setChoice(state, 'u-manual', 'may')
		const payload = pinPayload(state)
		expect(payload.pins).toHaveLength(2)
		expect(payload.pins).toContainEqual({
			unitId: 'u-suggest',
			mustInclude: true,
			origin: 'suggested',
		})
		expect(payload.pins).toContainEqual({
			unitId: 'u-manual',
			mustInclude: false,
			origin: 'manual',
		})
		expect(selectedCount(state)).toBe(2)
	})

	test('unselected (rejected) candidates never reach the payload', () => {
		let state = addCandidates(emptyPinSelection(), [
			SUGGESTED,
			MANUAL,
			SECOND_MANUAL,
		])
		state = setChoice(state, 'u-suggest', 'must')
		// manual + second_manual left unselected = rejected
		expect(pinPayload(state).pins).toEqual([
			{ unitId: 'u-suggest', mustInclude: true, origin: 'suggested' },
		])
	})

	test('cycleChoice walks null → must → may → null', () => {
		let state = addCandidates(emptyPinSelection(), [MANUAL])
		expect(state.choices['u-manual'] ?? null).toBeNull()
		state = cycleChoice(state, 'u-manual')
		expect(state.choices['u-manual']).toBe('must')
		state = cycleChoice(state, 'u-manual')
		expect(state.choices['u-manual']).toBe('may')
		state = cycleChoice(state, 'u-manual')
		expect(state.choices['u-manual'] ?? null).toBeNull()
	})

	test('setChoice back to null clears a decision (reject path)', () => {
		let state = addCandidates(emptyPinSelection(), [MANUAL])
		state = setChoice(state, 'u-manual', 'must')
		state = setChoice(state, 'u-manual', null)
		expect(selectedCount(state)).toBe(0)
	})

	test('originCounts separates reviewer picks from machine suggestions', () => {
		let state = addCandidates(emptyPinSelection(), [SUGGESTED, MANUAL])
		state = setChoice(state, 'u-suggest', 'must')
		state = setChoice(state, 'u-manual', 'must')
		expect(originCounts(state)).toEqual({ suggested: 1, manual: 1 })
	})

	test('worklistProgress counts cases carrying at least one pin', () => {
		const progress = worklistProgress([
			{ pinCount: 2 },
			{ pinCount: 0 },
			{ pinCount: 5 },
			{ pinCount: 0 },
		])
		expect(progress).toEqual({ total: 4, withPins: 2 })
	})
})
