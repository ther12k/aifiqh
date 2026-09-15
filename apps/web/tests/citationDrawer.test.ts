/**
 * M6-017 / #165 — citation drawer state machine.
 *
 * Acceptance scenarios mirrored from the issue:
 *  - race guard: click citation A, then quickly citation B — a slow
 *    response for A must never overwrite B;
 *  - close regression: open → close leaves the drawer exactly closed —
 *    the machine holds only drawer state, so chat draft/conversation/
 *    scroll cannot be affected by construction;
 *  - error mapping: permission denial reads differently from not-found and
 *    network failure (and none leak content);
 *  - reader copy: attribution carries source/author/location, never
 *    internal ids.
 */
import { describe, expect, test } from 'bun:test'
import type { CitationSnapshot } from '@aifiqh/shared'
import {
	type CitationDrawerState,
	citationCopyText,
	citationErrorMessage,
	citationLocationLabel,
	closeCitation,
	failCitation,
	openCitation,
	resolveCitation,
} from '../src/lib/citationDrawer'

function snapshot(overrides: Partial<CitationSnapshot> = {}): CitationSnapshot {
	return {
		version: 'citation-snapshot-v1',
		answerId: 'ans-1',
		ordinal: 1,
		citationId: 'cit-1',
		source: {
			id: 'src-1',
			title: 'Al-Majmu Syarah Muhadzdzab',
			author: 'Imam An-Nawawi',
			sourceType: 'book',
			language: 'ar',
			rightsStatus: 'public_domain',
		},
		revision: { id: 'rev-r1', revisionNumber: 1, status: 'active' },
		location: {
			pageNumber: 42,
			heading: 'Bab Syarat Sah Wudhu',
			spanKey: 'p42-s1-0001-abc',
		},
		passage: {
			quotedText: 'لا صلاة لمن لا وضوء له',
			originalText: 'لا صلاة لمن لا وضوء له',
			translationText: 'Tidak sah shalat bagi orang yang tidak berwudhu.',
		},
		context: {
			before: 'Konteks sebelum.',
			after: 'Konteks sesudah.',
			hasContext: true,
		},
		...overrides,
	}
}

describe('citation drawer state machine', () => {
	test('open goes to loading with a fresh sequence', () => {
		const state = openCitation(
			{ phase: 'closed' },
			{ answerId: 'a1', ordinal: 1 },
		)
		expect(state).toEqual({
			phase: 'loading',
			target: { answerId: 'a1', ordinal: 1 },
			seq: 1,
		})
	})

	test('resolve succeeds for the current request', () => {
		const loading = openCitation({ phase: 'closed' } as CitationDrawerState, {
			answerId: 'a1',
			ordinal: 1,
		})
		const ready = resolveCitation(
			loading,
			{ answerId: 'a1', ordinal: 1 },
			snapshot(),
			1,
		)
		expect(ready.phase).toBe('ready')
		if (ready.phase === 'ready') {
			expect(ready.snapshot.source.title).toBe('Al-Majmu Syarah Muhadzdzab')
		}
	})

	test('RACE: a slow response for citation A never overwrites citation B', () => {
		let state: CitationDrawerState = { phase: 'closed' }
		// click A
		state = openCitation(state, { answerId: 'a1', ordinal: 1 })
		// click B before A resolves
		state = openCitation(state, { answerId: 'a1', ordinal: 2 })
		expect(state.phase).toBe('loading')
		if (state.phase !== 'loading') return

		// A's slow response arrives LAST — must be ignored
		state = resolveCitation(
			state,
			{ answerId: 'a1', ordinal: 1 },
			snapshot({ ordinal: 1 }),
			1,
		)
		expect(state.phase).toBe('loading')

		// B's response arrives — accepted
		state = resolveCitation(
			state,
			{ answerId: 'a1', ordinal: 2 },
			snapshot({ ordinal: 2 }),
			2,
		)
		expect(state.phase).toBe('ready')
		if (state.phase === 'ready') {
			expect(state.target.ordinal).toBe(2)
			expect(state.snapshot.ordinal).toBe(2)
		}
	})

	test('RACE: a late failure for the previous citation is ignored too', () => {
		let state: CitationDrawerState = { phase: 'closed' }
		state = openCitation(state, { answerId: 'a1', ordinal: 1 })
		state = openCitation(state, { answerId: 'a1', ordinal: 2 })
		state = failCitation(state, { answerId: 'a1', ordinal: 1 }, 'gagal', 1)
		expect(state.phase).toBe('loading')
	})

	test('close regression: open → close returns to the exact closed state', () => {
		let state: CitationDrawerState = { phase: 'closed' }
		state = openCitation(state, { answerId: 'a1', ordinal: 3 })
		state = resolveCitation(
			state,
			{ answerId: 'a1', ordinal: 3 },
			snapshot({ ordinal: 3 }),
			1,
		)
		expect(state.phase).toBe('ready')
		state = closeCitation(state)
		expect(state).toEqual({ phase: 'closed' })
		// an in-flight response for the closed citation must not resurrect it
		state = resolveCitation(
			state,
			{ answerId: 'a1', ordinal: 3 },
			snapshot({ ordinal: 3 }),
			1,
		)
		expect(state).toEqual({ phase: 'closed' })
	})

	test('fail maps to the error phase with the message intact', () => {
		let state: CitationDrawerState = { phase: 'closed' }
		state = openCitation(state, { answerId: 'a1', ordinal: 1 })
		state = failCitation(
			state,
			{ answerId: 'a1', ordinal: 1 },
			'Anda tidak lagi memiliki akses.',
			1,
		)
		expect(state.phase).toBe('error')
		if (state.phase === 'error') {
			expect(state.message).toContain('akses')
		}
	})
})

describe('citation reader copy', () => {
	test('location label shows revision, page and heading — no span keys', () => {
		const label = citationLocationLabel(snapshot())
		expect(label).toBe('Revisi R1 · Hal. 42 · Bab Syarat Sah Wudhu')
		expect(label).not.toContain('p42-s1')
	})

	test('location label omits absent parts instead of showing nulls', () => {
		const label = citationLocationLabel(
			snapshot({ location: { pageNumber: null, heading: null, spanKey: 'k' } }),
		)
		expect(label).toBe('Revisi R1')
	})

	test('copy text carries attribution, not internal ids', () => {
		const text = citationCopyText(snapshot())
		expect(text).toContain('لا صلاة لمن لا وضوء له')
		expect(text).toContain(
			'Artinya: Tidak sah shalat bagi orang yang tidak berwudhu.',
		)
		expect(text).toContain(
			'— Al-Majmu Syarah Muhadzdzab (Imam An-Nawawi), Revisi R1 · Hal. 42 · Bab Syarat Sah Wudhu',
		)
		expect(text).not.toContain('rev-r1')
		expect(text).not.toContain('src-1')
		expect(text).not.toContain('spanKey')
	})

	test('error messages separate denial, missing and network failure', () => {
		expect(citationErrorMessage(403)).toContain('tidak lagi memiliki akses')
		expect(citationErrorMessage(404)).toContain('tidak ditemukan')
		expect(citationErrorMessage(0)).toContain('gagal dimuat')
		expect(citationErrorMessage(500)).not.toContain('akses ke sumber')
	})
})
