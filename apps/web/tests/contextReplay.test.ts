/**
 * Final-context replay view tests (INS-003).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ContextReplayView } from '../src/chat/ContextReplayView'
import { buildContextReplayView } from '../src/lib/contextReplay'
import type { ContextItemLike, ReplayPackLike } from '../src/lib/contextReplay'

const MANIFEST = {
	manifestHash: 'a'.repeat(64),
	tokenBudget: 4000,
	tokenTotal: 320,
	profile: 'standard',
}

function itemsFixture(): ContextItemLike[] {
	return [
		{
			ordinal: 1,
			unitId: '11111111-1111-4111-8111-111111111111',
			relation: 'primary',
			tokenEstimate: 80,
			included: true,
			selectionReason: 'selected evidence rank 1',
		},
		{
			ordinal: 2,
			unitId: '22222222-2222-4222-8222-222222222222',
			relation: 'exception',
			tokenEstimate: 40,
			included: true,
			selectionReason: 'exception context for span:seed',
		},
		{
			ordinal: 3,
			unitId: '33333333-3333-4333-8333-333333333333',
			relation: 'adjacent',
			tokenEstimate: 200,
			included: false,
			truncationNote: 'dropped whole to fit token budget 4000',
		},
	]
}

function packFixture(): ReplayPackLike {
	return {
		indexReleaseId: '99999999-9999-4999-8999-999999999999',
		manifestHash: 'a'.repeat(64),
		packHash: 'b'.repeat(64),
		items: [
			{
				ordinal: 1,
				unitId: '11111111-1111-4111-8111-111111111111',
				text: 'teks',
				contentHash: 'h1',
				present: true,
			},
			{
				ordinal: 2,
				unitId: '22222222-2222-4222-8222-222222222222',
				text: 'kecuali',
				contentHash: 'h2',
				present: true,
			},
			{
				ordinal: 3,
				unitId: '33333333-3333-4333-8333-333333333333',
				text: 'tetangga',
				contentHash: 'h3',
				present: true,
			},
		],
	}
}

describe('INS-003: rerank/expansion/exclusion visualization + context replay', () => {
	test('final order and budget visible; every item carries its reason', () => {
		const view = buildContextReplayView(MANIFEST, itemsFixture(), packFixture())
		expect(view.profile).toBe('standard')
		expect(view.tokenBudget).toBe(4000)
		expect(view.tokenTotal).toBe(320)
		expect(view.includedCount).toBe(2)
		expect(view.droppedCount).toBe(1)
		expect(view.pinned).toBeTrue()
		// reasons: selection reason for primaries/expansions, truncation note
		// for the budget drop
		expect(view.items[0].reason).toBe('selected evidence rank 1')
		expect(view.items[1].reason).toContain('exception context')
		expect(view.items[2].reason).toContain('dropped whole to fit token budget')
		// protected relation flagged
		expect(view.items[1].isProtected).toBeTrue()
		expect(view.items[0].isProtected).toBeFalse()
	})

	test('replay is pinned: reproducible when hashes and archive agree', () => {
		const view = buildContextReplayView(MANIFEST, itemsFixture(), packFixture())
		expect(view.reproducible).toBeTrue()
		expect(view.flags).toEqual([])
		expect(view.packHash).toBe('b'.repeat(64))
	})

	test('differences flagged: manifest mismatch and missing archive', () => {
		const tamperedPack: ReplayPackLike = {
			...packFixture(),
			manifestHash: 'c'.repeat(64),
			items: packFixture().items.map((i) =>
				i.ordinal === 2 ? { ...i, present: false } : i,
			),
		}
		const view = buildContextReplayView(MANIFEST, itemsFixture(), tamperedPack)
		expect(view.reproducible).toBeFalse()
		expect(
			view.flags.some((f) => f.code === 'MANIFEST_HASH_MISMATCH'),
		).toBeTrue()
		expect(
			view.flags.some((f) => f.code === 'MISSING_ARCHIVE' && f.ordinal === 2),
		).toBeTrue()
		// the affected item is visibly not 'included'
		const item2 = view.items.find((i) => i.ordinal === 2)
		expect(item2?.state).toBe('missing_archive')
	})

	test('component renders budget, counts, flags and per-item reasons', () => {
		const view = buildContextReplayView(MANIFEST, itemsFixture(), packFixture())
		const html = renderToString(
			createElement(ContextReplayView, { replay: view }),
		)
		const clean = html.replace(/<!-- -->/g, '')
		expect(clean).toContain('320/4000 token')
		expect(clean).toContain('2 masuk, 1 dibuang')
		expect(clean).toContain('manifest terkunci')
		expect(clean).toContain('reproducible')
		expect(clean).toContain('selected evidence rank 1')
		expect(clean).toContain('dropped whole to fit token budget')
		expect(clean).toContain('data-protected="true"')
	})

	test('flagged replay surfaces an alert block with codes', () => {
		const tamperedPack: ReplayPackLike = {
			...packFixture(),
			manifestHash: 'c'.repeat(64),
		}
		const view = buildContextReplayView(MANIFEST, itemsFixture(), tamperedPack)
		const html = renderToString(
			createElement(ContextReplayView, { replay: view }),
		)
		expect(html).toContain('role="alert"')
		expect(html).toContain('MANIFEST_HASH_MISMATCH')
		expect(html).toContain('ada perbedaan')
	})
})
