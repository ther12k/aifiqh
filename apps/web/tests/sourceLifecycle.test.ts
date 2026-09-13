import { describe, expect, test } from 'bun:test'
import {
	PUBLICATION_LABELS,
	type RevisionPublicationState,
	publicationLabel,
	publicationTone,
} from '../src/lib/sourceLifecycle'

/**
 * M6-013 (FR-10) — the review/publication lifecycle copy. One function
 * derives what the badge says from the SourceOverview read model; the
 * review scenarios map exactly:
 *   R1 in production while R2 is pending → R1 keeps its production label
 *   (a newer revision never rewrites an older one's status);
 *   approved-but-not-in-production → its own honest label;
 *   upload landed, extraction running → processing, never "ready to answer".
 */

const R1: RevisionPublicationState = {
	reviewState: 'active',
	publishedReleaseIds: ['release-1'],
	publishedInProduction: true,
}
const R2: RevisionPublicationState = {
	reviewState: 'pending_review',
	publishedReleaseIds: [],
	publishedInProduction: false,
}

describe('publicationLabel — the five lifecycle scenarios', () => {
	test('R1 in the production release says so, even with R2 pending behind it', () => {
		expect(publicationLabel(R1)).toBe(PUBLICATION_LABELS.inProduction)
		// R2's existence does not rewrite R1's label
		expect(publicationLabel(R1)).not.toContain('Menunggu')
		expect(publicationTone(R1)).toBe('ok')
	})

	test('approved but not in production is its own distinct state', () => {
		const approved: RevisionPublicationState = {
			reviewState: 'active',
			publishedReleaseIds: [],
			publishedInProduction: false,
		}
		expect(publicationLabel(approved)).toBe(
			PUBLICATION_LABELS.approvedNotPublished,
		)
		expect(publicationTone(approved)).toBe('neutral')
	})

	test('pending review and processing stay warning-toned, never "ready"', () => {
		expect(publicationLabel(R2)).toBe(PUBLICATION_LABELS.pendingReview)
		expect(publicationTone(R2)).toBe('warn')
		const processing: RevisionPublicationState = {
			reviewState: 'processing',
			publishedReleaseIds: [],
			publishedInProduction: false,
		}
		expect(publicationLabel(processing)).toBe(PUBLICATION_LABELS.processing)
		// the copy never promises answerability
		for (const rev of [R2, processing]) {
			expect(publicationLabel(rev).toLowerCase()).not.toContain('siap')
		}
	})

	test('deprecated and unknown states render neutral, non-misleading labels', () => {
		expect(
			publicationLabel({
				...R1,
				publishedInProduction: false,
				reviewState: 'deprecated',
			}),
		).toBe(PUBLICATION_LABELS.deprecated)
		expect(
			publicationLabel({
				reviewState: 'mystery',
				publishedReleaseIds: [],
				publishedInProduction: false,
			}),
		).toBe(PUBLICATION_LABELS.unknown)
	})

	test('membership in a non-production release alone is NOT production use', () => {
		const candidate: RevisionPublicationState = {
			reviewState: 'active',
			publishedReleaseIds: ['candidate-release-b'],
			publishedInProduction: false,
		}
		expect(publicationLabel(candidate)).toBe(
			PUBLICATION_LABELS.approvedNotPublished,
		)
	})
})

describe('detail integration pins (verified against the live component)', () => {
	test('detail renders publication from the overview model and offers no publish action', async () => {
		const fs = await import('node:fs')
		const path = new URL('../src/sources/SourceRegistry.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		// the badge is fed by the overview fetch, not recomputed client-side
		expect(src).toContain('fetch(`/sources/${source.id}/overview`)')
		expect(src).toContain('revision-publication-')
		expect(src).toContain('publicationLabel(pub)')
		// revoked access shows the unavailable state, no content echo
		expect(src).toContain('source-access-denied')
		// no publish button bypassing the release workflow exists
		expect(src).not.toContain('Publish</button>')
		expect(src).not.toContain('Terbitkan')
		// the registration journey owns "Tambah Sumber" everywhere
		expect(src.match(/#\/studio/g)?.length).toBe(1) // only the separate Studio task link
		expect(src).toContain('href="#/sources/register"')
	})

	test('deep-link consistency: open param drives selection, no auto-jump to latest', async () => {
		const fs = await import('node:fs')
		const path = new URL('../src/sources/SourceRegistry.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		// hashchange handler opens the pinned source id from the link
		expect(src).toContain("params.get('open')")
		// the timeline renders EVERY revision with its own status — the view
		// never silently swaps the reader onto the newest revision
		expect(src).toContain('revision-timeline')
	})
})
