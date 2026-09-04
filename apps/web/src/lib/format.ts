/**
 * Shared display formatting. Timestamps render in Indonesian in UTC so a
 * given instant reads identically in every browser and in SSR tests; the
 * full ISO string stays available via title attributes for operators.
 */
const DATE_TIME = new Intl.DateTimeFormat('id-ID', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
})

export function formatTimestampId(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return DATE_TIME.format(date)
}
