import { describe, expect, test } from 'bun:test'
import {
	dayKey,
	threadDayLabel,
	threadTimeLabel,
	withDayDividers,
} from '../src/lib/threadView'

describe('thread day grouping', () => {
	test('dayKey uses the local calendar day', () => {
		// 10:24 local on 2026-09-07 — the key must not drift with UTC offsets
		const d = new Date(2026, 8, 7, 10, 24)
		expect(dayKey(d.toISOString())).toBe('2026-09-07')
		expect(dayKey('not-a-date')).toBe('')
	})

	test('threadDayLabel names today, yesterday, and older days', () => {
		const now = new Date(2026, 8, 7, 15, 0)
		expect(threadDayLabel(new Date(2026, 8, 7, 9, 0).toISOString(), now)).toBe(
			'Hari ini, 7 Sep 2026',
		)
		expect(threadDayLabel(new Date(2026, 8, 6, 22, 0).toISOString(), now)).toBe(
			'Kemarin, 6 Sep 2026',
		)
		expect(threadDayLabel(new Date(2026, 7, 30).toISOString(), now)).toBe(
			'30 Agu 2026',
		)
		expect(threadDayLabel('garbage', now)).toBe('')
	})

	test('threadTimeLabel renders a colon clock', () => {
		expect(threadTimeLabel(new Date(2026, 8, 7, 10, 24).toISOString())).toBe(
			'10:24',
		)
		expect(threadTimeLabel('nope')).toBe('')
	})

	test('withDayDividers inserts one divider per day change', () => {
		const now = new Date(2026, 8, 7, 12, 0)
		const messages = [
			{ id: 'a', createdAt: new Date(2026, 8, 7, 9, 0).toISOString() },
			{ id: 'b', createdAt: new Date(2026, 8, 7, 10, 0).toISOString() },
			{ id: 'c', createdAt: new Date(2026, 8, 6, 18, 0).toISOString() },
			{ id: 'd' }, // optimistic turn without a timestamp
		]
		const entries = withDayDividers(messages, now)
		expect(entries.map((e) => e.kind)).toEqual([
			'divider',
			'message',
			'message',
			'divider',
			'message',
			'message',
		])
		const first = entries[0]
		if (first.kind !== 'divider') throw new Error('expected divider first')
		expect(first.label).toBe('Hari ini, 7 Sep 2026')
		const second = entries[3]
		if (second.kind !== 'divider') throw new Error('expected second divider')
		expect(second.label).toBe('Kemarin, 6 Sep 2026')
	})

	test('withDayDividers keeps an empty thread empty', () => {
		expect(withDayDividers([])).toEqual([])
	})
})

describe('topbar search routing', () => {
	test('searchRouteFor maps keywords to real routes', async () => {
		const { searchRouteFor } = await import('../src/lib/routes')
		expect(searchRouteFor('buka sumber kitab')).toBe('#/sources')
		expect(searchRouteFor('halaman chat')).toBe('#/chat')
		expect(searchRouteFor('xyzzy')).toBeNull()
	})
})
