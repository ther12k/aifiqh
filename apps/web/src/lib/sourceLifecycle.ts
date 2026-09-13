/**
 * Source revision lifecycle labels (M6-013 / FR-10).
 *
 * ONE function decides what the publication badge says, derived from the
 * SourceOverview read model (M6-010) — never recomputed in components and
 * never inferred from approval status alone. The exact production-copy
 * scenarios:
 *
 *   R1 in the production release, R2 pending  → R1 stays "Digunakan release
 *     produksi"; a newer revision never changes an older one's label.
 *   approved but not in the production release → "Disetujui — belum
 *     dipublikasikan ke produksi".
 *   upload landed, extraction still running   → "Pemrosesan konten
 *     berjalan" (never "siap menjawab").
 */

export interface RevisionPublicationState {
	reviewState: string
	publishedReleaseIds: string[]
	publishedInProduction: boolean
}

export const PUBLICATION_LABELS = {
	inProduction: 'Digunakan release produksi',
	approvedNotPublished: 'Disetujui — belum dipublikasikan ke produksi',
	pendingReview: 'Menunggu review',
	processing: 'Pemrosesan konten berjalan',
	deprecated: 'Tidak berlaku',
	unknown: 'Status tidak diketahui',
} as const

export function publicationLabel(rev: RevisionPublicationState): string {
	if (rev.publishedInProduction) return PUBLICATION_LABELS.inProduction
	switch (rev.reviewState) {
		case 'active':
			return PUBLICATION_LABELS.approvedNotPublished
		case 'pending_review':
			return PUBLICATION_LABELS.pendingReview
		case 'processing':
			return PUBLICATION_LABELS.processing
		case 'deprecated':
			return PUBLICATION_LABELS.deprecated
		default:
			return PUBLICATION_LABELS.unknown
	}
}

/** badge tone for the publication label (ok / warn / neutral) */
export function publicationTone(rev: RevisionPublicationState): string {
	if (rev.publishedInProduction) return 'ok'
	if (rev.reviewState === 'pending_review' || rev.reviewState === 'processing')
		return 'warn'
	return 'neutral'
}
