/**
 * Studio dashboard view logic (STU-003). Pure — no framework code.
 *
 *  - every card shows its authorized counts and last refresh;
 *  - ZERO / ERROR / LOADING are distinct render states per card;
 *  - drill-down links preserve the dashboard filter context via query
 *    params so returning keeps the operator's place.
 */

export interface StudioCardLike {
	key: string
	label: string
	counts: Record<string, number>
	drilldown: Array<{ kind: string; label: string; href: string }>
}

export interface StudioDashboardLike {
	version: string
	generatedAt: string
	cards: StudioCardLike[]
}

export type CardState = 'loading' | 'error' | 'zero' | 'data'

/**
 * A card is 'zero' when EVERY count is 0 — actionable records may exist
 * per count, so a card with any nonzero count is 'data'.
 */
export function cardState(
	card: StudioCardLike | undefined,
	fetchError?: string | null,
	isLoading?: boolean,
): CardState {
	if (isLoading) return 'loading'
	if (fetchError) return 'error'
	if (!card) return 'error'
	const values = Object.values(card.counts)
	return values.length > 0 && values.every((v) => v === 0) ? 'zero' : 'data'
}

export const CARD_LABELS: Record<string, string> = {
	source_health: 'Kesehatan Sumber',
	open_work: 'Pekerjaan Terbuka',
	failed_jobs: 'Pekerjaan Gagal',
	broken_links: 'Tautan Rusak',
	open_feedback: 'Umpan Balik Terbuka',
	release_health: 'Kesehatan Rilis',
}

const COUNT_LABELS: Record<string, string> = {
	revisions_processing: 'revisi diproses',
	revisions_active: 'revisi aktif',
	revisions_deprecated: 'revisi pensiun',
	sources_unknown_rights: 'hak cipta tidak diketahui',
	changesets_draft: 'changeset draf',
	changesets_submitted: 'changeset diajukan',
	changesets_changes_requested: 'changeset diminta revisi',
	stale_concepts: 'konsep basi',
	failed: 'gagal',
	broken: 'rusak',
	total: 'terbuka',
	helpful: 'membantu',
	citation_issue: 'masalah sitasi',
	doctrinal_issue: 'masalah doktrin',
	translation_issue: 'masalah terjemahan',
	other: 'lainnya',
	knowledge_releases_published: 'rilis pengetahuan terbit',
	index_releases_promoted: 'rilis indeks produksi',
	failed_gates: 'gate gagal',
}

export function countLabel(key: string): string {
	return COUNT_LABELS[key] ?? key
}

export interface CardView {
	key: string
	label: string
	state: CardState
	entries: Array<{ key: string; label: string; value: number }>
	drilldown: Array<{ kind: string; label: string; href: string }>
}

/**
 * Drill-down hrefs carry the dashboard context (card + filter window) so
 * the target page can link back with the filter preserved.
 */
export function buildCardViews(
	dashboard: StudioDashboardLike | null,
	options: { loading?: boolean; error?: string | null } = {},
): CardView[] {
	const keys = dashboard?.cards.map((c) => c.key) ?? Object.keys(CARD_LABELS)
	return keys.map((key) => {
		const card = dashboard?.cards.find((c) => c.key === key)
		const label = card?.label ?? CARD_LABELS[key] ?? key
		const state = cardState(card, options.error, options.loading)
		const entries = Object.entries(card?.counts ?? {})
			.filter(([, value]) => Number.isFinite(value))
			.map(([countKey, value]) => ({
				key: countKey,
				label: countLabel(countKey),
				value,
			}))
		const drilldown = (card?.drilldown ?? []).map((d) => ({
			...d,
			href: `${d.href}?from=studio&card=${key}`,
		}))
		return { key, label, state, entries, drilldown }
	})
}
