/** Browser-local conversation organization: pins, groups, and stable ordering. */

export const CONVERSATION_ORGANIZATION_STORAGE_KEY =
	'aifiqh.conversation-organization'

export interface ConversationOrganizationPreferences {
	pinnedIds: string[]
	groups: Record<string, string[]>
}

export interface ConversationListItem {
	id: string
	updatedAt?: string | number | Date | null
	createdAt?: string | number | Date | null
	title?: string | null
}

export interface ConversationPartition<T> {
	pinned: T[]
	recent: T[]
}

export const EMPTY_CONVERSATION_ORGANIZATION: ConversationOrganizationPreferences =
	{
		pinnedIds: [],
		groups: {},
	}

function copyPreferences(
	value: ConversationOrganizationPreferences,
): ConversationOrganizationPreferences {
	return {
		pinnedIds: [...value.pinnedIds],
		groups: Object.fromEntries(
			Object.entries(value.groups).map(([name, ids]) => [name, [...ids]]),
		),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalize(value: unknown): ConversationOrganizationPreferences {
	if (!isRecord(value)) return copyPreferences(EMPTY_CONVERSATION_ORGANIZATION)
	const pinnedIds = Array.isArray(value.pinnedIds)
		? [
				...new Set(
					value.pinnedIds.filter(
						(id): id is string => typeof id === 'string' && id.length > 0,
					),
				),
			]
		: []
	const groups: Record<string, string[]> = {}
	if (isRecord(value.groups)) {
		for (const [name, ids] of Object.entries(value.groups)) {
			if (typeof name !== 'string' || !Array.isArray(ids)) continue
			groups[name] = [
				...new Set(
					ids.filter(
						(id): id is string => typeof id === 'string' && id.length > 0,
					),
				),
			]
		}
	}
	return { pinnedIds, groups }
}

export function loadConversationOrganization(
	storage: Storage | undefined = typeof window !== 'undefined'
		? window.localStorage
		: undefined,
	key = CONVERSATION_ORGANIZATION_STORAGE_KEY,
): ConversationOrganizationPreferences {
	try {
		const raw = storage?.getItem(key)
		return raw
			? normalize(JSON.parse(raw))
			: copyPreferences(EMPTY_CONVERSATION_ORGANIZATION)
	} catch {
		return copyPreferences(EMPTY_CONVERSATION_ORGANIZATION)
	}
}

export function saveConversationOrganization(
	preferences: ConversationOrganizationPreferences,
	storage: Storage | undefined = typeof window !== 'undefined'
		? window.localStorage
		: undefined,
	key = CONVERSATION_ORGANIZATION_STORAGE_KEY,
): boolean {
	try {
		if (!storage) return false
		storage.setItem(key, JSON.stringify(normalize(preferences)))
		return true
	} catch {
		return false
	}
}

export function toggleConversationPin(
	preferences: ConversationOrganizationPreferences,
	conversationId: string,
): ConversationOrganizationPreferences {
	const pinned = new Set(preferences.pinnedIds)
	if (pinned.has(conversationId)) pinned.delete(conversationId)
	else pinned.add(conversationId)
	return { ...copyPreferences(preferences), pinnedIds: [...pinned] }
}

export function createConversationGroup(
	preferences: ConversationOrganizationPreferences,
	groupName: string,
): ConversationOrganizationPreferences {
	const name = groupName.trim()
	if (!name) return copyPreferences(preferences)
	return {
		...copyPreferences(preferences),
		groups: {
			...preferences.groups,
			[name]: [...(preferences.groups[name] ?? [])],
		},
	}
}

export function assignConversationToGroup(
	preferences: ConversationOrganizationPreferences,
	conversationId: string,
	groupName: string | null,
): ConversationOrganizationPreferences {
	const next = copyPreferences(preferences)
	for (const name of Object.keys(next.groups))
		next.groups[name] = next.groups[name].filter((id) => id !== conversationId)
	const name = groupName?.trim()
	if (name) next.groups[name] = [...(next.groups[name] ?? []), conversationId]
	return normalize(next)
}

export function cleanupStaleConversationIds(
	preferences: ConversationOrganizationPreferences,
	validIds: Iterable<string>,
): ConversationOrganizationPreferences {
	const valid = new Set(validIds)
	return {
		pinnedIds: preferences.pinnedIds.filter((id) => valid.has(id)),
		groups: Object.fromEntries(
			Object.entries(preferences.groups).map(([name, ids]) => [
				name,
				ids.filter((id) => valid.has(id)),
			]),
		),
	}
}

function timestamp(value: string | number | Date | null | undefined): number {
	if (value instanceof Date) return value.getTime()
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0
	if (typeof value === 'string') {
		const parsed = Date.parse(value)
		return Number.isNaN(parsed) ? 0 : parsed
	}
	return 0
}

export function sortConversations<T extends ConversationListItem>(
	items: readonly T[],
): T[] {
	return [...items].sort(
		(a, b) =>
			timestamp(b.updatedAt ?? b.createdAt) -
				timestamp(a.updatedAt ?? a.createdAt) || a.id.localeCompare(b.id),
	)
}

export function filterConversations<T extends ConversationListItem>(
	items: readonly T[],
	query: string,
): T[] {
	const needle = query.trim().toLocaleLowerCase()
	return needle
		? items.filter((item) =>
				`${item.title ?? ''} ${item.id}`.toLocaleLowerCase().includes(needle),
			)
		: [...items]
}

export function partitionConversations<T extends ConversationListItem>(
	items: readonly T[],
	preferences: ConversationOrganizationPreferences,
): ConversationPartition<T> {
	const pinned = new Set(preferences.pinnedIds)
	return {
		pinned: sortConversations(items.filter((item) => pinned.has(item.id))),
		recent: sortConversations(items.filter((item) => !pinned.has(item.id))),
	}
}
