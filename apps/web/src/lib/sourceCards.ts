/**
 * Source cards + deep-link routing (CHAT-005).
 *
 * Every citation renders as a card. Clicking builds a deep link to the
 * pinned revision/span in the source viewer with the exact quote marked
 * for highlighting. Access is handled safely: a card the viewer cannot
 * open (foreign/removed source) surfaces a typed unavailability state —
 * the link is still rendered (so users see what WAS cited) but the
 * verification status stays visible from the card itself.
 */

export interface CitationCard {
	ordinal: number
	sourceId: string
	sourceRevisionId: string
	spanId: string
	quote: string | null
	/** VAL-002 status persisted on the citation */
	quoteMatchStatus: 'exact' | 'normalized' | 'mismatch' | null
}

export interface SourceMeta {
	title: string
	author: string | null
}

/** Deep-link route to the pinned revision + span in the source viewer. */
export function evidenceDeepLink(card: {
	sourceId: string
	sourceRevisionId: string
	spanId: string
}): string {
	return `#/sources/${card.sourceId}/revisions/${card.sourceRevisionId}?span=${card.spanId}`
}

/** Parse a viewer deep-link back into its parts (round-trip safe). */
export function parseEvidenceDeepLink(
	hash: string,
): { sourceId: string; revisionId: string; spanId: string | null } | null {
	const m = hash.match(
		/^#\/sources\/([0-9a-f-]{36})\/revisions\/([0-9a-f-]{36})(?:\?span=([0-9a-f-]{36}))?$/,
	)
	if (!m) return null
	return { sourceId: m[1], revisionId: m[2], spanId: m[3] ?? null }
}

/** Human label for the persisted quote match status. */
export function quoteMatchLabel(
	status: CitationCard['quoteMatchStatus'],
): string {
	switch (status) {
		case 'exact':
			return 'Kutipan persis'
		case 'normalized':
			return 'Kutipan setelah normalisasi'
		case 'mismatch':
			return 'Kutipan tidak cocok'
		default:
			return 'Status kutipan belum diverifikasi'
	}
}

export function quoteMatchTone(
	status: CitationCard['quoteMatchStatus'],
): string {
	switch (status) {
		case 'exact':
			return 'ok'
		case 'normalized':
			return 'warn'
		case 'mismatch':
			return 'bad'
		default:
			return 'unknown'
	}
}

export interface CardViewModel extends CitationCard {
	meta: SourceMeta | null
	deepLink: string
	matchLabel: string
	matchTone: string
	/** true when the source registry lookup failed (foreign/removed) */
	unavailable: boolean
}

/**
 * Build card view models. `lookupMeta` returns null when the caller
 * cannot see the source — the card still renders (cited evidence is a
 * fact about the answer) but marked unavailable and non-navigable.
 */
export function buildSourceCards(
	citations: CitationCard[],
	lookupMeta: (sourceId: string) => SourceMeta | null,
): CardViewModel[] {
	return citations.map((c) => {
		const meta = lookupMeta(c.sourceId)
		return {
			...c,
			meta,
			deepLink: evidenceDeepLink(c),
			matchLabel: quoteMatchLabel(c.quoteMatchStatus),
			matchTone: quoteMatchTone(c.quoteMatchStatus),
			unavailable: meta === null,
		}
	})
}
