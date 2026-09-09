import { describe, expect, test } from 'bun:test'
import {
	type ConversationOrganizationPreferences,
	EMPTY_CONVERSATION_ORGANIZATION,
	assignConversationToGroup,
	cleanupStaleConversationIds,
	createConversationGroup,
	filterConversations,
	loadConversationOrganization,
	partitionConversations,
	saveConversationOrganization,
	toggleConversationPin,
} from '../src/lib/conversationOrganization'

function storage(initial?: string): Storage {
	let value = initial ?? null
	return {
		getItem: () => value,
		setItem: (_key, next) => {
			value = next
		},
		removeItem: () => {
			value = null
		},
		clear: () => {
			value = null
		},
		key: () => null,
		length: 0,
	}
}

describe('conversation organization', () => {
	test('malformed and unavailable storage fall back safely', () => {
		expect(loadConversationOrganization(storage('{bad'))).toEqual(
			EMPTY_CONVERSATION_ORGANIZATION,
		)
		const unavailable = {
			getItem: () => {
				throw new Error('blocked')
			},
		} as unknown as Storage
		expect(loadConversationOrganization(unavailable)).toEqual(
			EMPTY_CONVERSATION_ORGANIZATION,
		)
		expect(
			saveConversationOrganization(EMPTY_CONVERSATION_ORGANIZATION, undefined),
		).toBeFalse()
	})

	test('save and load normalize duplicate and invalid IDs', () => {
		const store = storage()
		saveConversationOrganization(
			{
				pinnedIds: ['a', 'a', ''],
				groups: { Work: ['b', 'b', 3 as unknown as string] },
			},
			store,
		)
		expect(loadConversationOrganization(store)).toEqual({
			pinnedIds: ['a'],
			groups: { Work: ['b'] },
		})
	})

	test('pin toggle adds and removes without mutating input', () => {
		const initial = { pinnedIds: ['a'], groups: {} }
		const added = toggleConversationPin(initial, 'b')
		expect(added.pinnedIds).toEqual(['a', 'b'])
		expect(toggleConversationPin(added, 'a').pinnedIds).toEqual(['b'])
		expect(initial.pinnedIds).toEqual(['a'])
	})

	test('groups create and assignment moves conversation between groups', () => {
		let prefs: ConversationOrganizationPreferences = {
			pinnedIds: [],
			groups: {},
		}
		prefs = createConversationGroup(prefs, ' Work ')
		prefs = createConversationGroup(prefs, 'Personal')
		prefs = assignConversationToGroup(prefs, 'c1', 'Work')
		prefs = assignConversationToGroup(prefs, 'c1', 'Personal')
		expect(prefs.groups).toEqual({ Work: [], Personal: ['c1'] })
		prefs = assignConversationToGroup(prefs, 'c1', null)
		expect(prefs.groups).toEqual({ Work: [], Personal: [] })
	})

	test('stale IDs are removed from pins and groups', () => {
		expect(
			cleanupStaleConversationIds(
				{ pinnedIds: ['a', 'gone'], groups: { Work: ['a', 'gone'] } },
				['a'],
			),
		).toEqual({ pinnedIds: ['a'], groups: { Work: ['a'] } })
	})

	test('partition and filter stay deterministic with pinned first and recent sorting', () => {
		const items = [
			{ id: 'z', title: 'Zeta', updatedAt: '2024-01-01' },
			{ id: 'a', title: 'Alpha', updatedAt: '2024-01-02' },
			{ id: 'b', title: 'Beta', updatedAt: '2024-01-02' },
		]
		const result = partitionConversations(items, {
			pinnedIds: ['z'],
			groups: {},
		})
		expect(result.pinned.map((item) => item.id)).toEqual(['z'])
		expect(result.recent.map((item) => item.id)).toEqual(['a', 'b'])
		expect(
			filterConversations(items, ' alpha ').map((item) => item.id),
		).toEqual(['a'])
		expect(filterConversations(items, '')).toEqual(items)
	})
})
