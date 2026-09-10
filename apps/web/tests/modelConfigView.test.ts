import { describe, expect, test } from 'bun:test'
import {
	chainAdd,
	chainFromServer,
	chainMove,
	chainPayload,
	chainRemove,
} from '../src/lib/modelConfigView'

const server = () =>
	chainFromServer([
		{
			position: 1,
			targetType: 'model',
			targetId: 'm-1',
			resolvedLabel: 'openai-main / glm-4.6',
		},
		{
			position: 2,
			targetType: 'model',
			targetId: 'm-2',
			resolvedLabel: 'openai-main / glm-4.5-air',
		},
	])

describe('fallback chain editor (AI-004)', () => {
	test('chainFromServer renumbers 1..n', () => {
		const s = server()
		expect(s.entries.map((e) => e.position)).toEqual([1, 2])
		expect(s.dirty).toBe(false)
	})

	test('chainMove swaps and renumbers', () => {
		const s = chainMove(server(), 1, 1)
		expect(s.entries.map((e) => e.targetId)).toEqual(['m-2', 'm-1'])
		expect(s.dirty).toBe(true)
		// boundary moves are no-ops
		expect(chainMove(s, 2, 1).entries.length).toBe(2)
	})

	test('chainRemove renumbers the rest', () => {
		const s = chainRemove(server(), 1)
		expect(s.entries.map((e) => e.position)).toEqual([1])
		expect(s.entries[0].targetId).toBe('m-2')
	})

	test('chainAdd appends and rejects duplicates', () => {
		const s = chainAdd(server(), {
			targetType: 'model',
			targetId: 'm-3',
			label: 'x',
		})
		expect(s.entries.length).toBe(3)
		expect(s.entries[2].position).toBe(3)
		expect(
			chainAdd(s, { targetType: 'model', targetId: 'm-3' }).entries.length,
		).toBe(3)
	})

	test('chainPayload emits exactly the API shape', () => {
		expect(chainPayload(server())).toEqual({
			entries: [
				{ targetType: 'model', targetId: 'm-1' },
				{ targetType: 'model', targetId: 'm-2' },
			],
		})
	})
})
