/**
 * Thread presentation helpers (pure): day grouping for the divider pills
 * between turns and per-message clock labels, in Indonesian. Days group in
 * LOCAL calendar time so "Hari ini" matches what the user sees on the clock.
 */

export interface ThreadMessageLike {
	id: string
	/** ISO timestamp from the conversation API (absent on optimistic turns) */
	createdAt?: string | null
}

export type ThreadEntry<T extends ThreadMessageLike> =
	| { kind: 'divider'; key: string; label: string }
	| { kind: 'message'; key: string; message: T }

function startOfDayMs(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** local calendar-day key (YYYY-MM-DD) — '' when the date is unusable */
export function dayKey(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ''
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Hari ini, 7 Sep 2026" / "Kemarin, 6 Sep 2026" / plain "5 Sep 2025" */
export function threadDayLabel(iso: string, now = new Date()): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ''
	const dayDiff = Math.round((startOfDayMs(now) - startOfDayMs(d)) / 86_400_000)
	const date = d.toLocaleDateString('id-ID', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	})
	if (dayDiff === 0) return `Hari ini, ${date}`
	if (dayDiff === 1) return `Kemarin, ${date}`
	return date
}

/** "10:24" — id-ID prefers a dot separator, the thread shows a colon */
export function threadTimeLabel(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ''
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Interleave a divider entry wherever the calendar day changes. Messages
 * without a usable timestamp pass through without introducing a divider.
 */
export function withDayDividers<T extends ThreadMessageLike>(
	messages: T[],
	now = new Date(),
): ThreadEntry<T>[] {
	const entries: ThreadEntry<T>[] = []
	let lastKey = ''
	for (const message of messages) {
		const key = message.createdAt ? dayKey(message.createdAt) : ''
		if (key && key !== lastKey) {
			const label = threadDayLabel(message.createdAt as string, now)
			if (label) {
				entries.push({ kind: 'divider', key: `d-${key}`, label })
				lastKey = key
			}
		}
		entries.push({ kind: 'message', key: `m-${message.id}`, message })
	}
	return entries
}
