import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ReviewChangeset } from '../src/knowledge/ReviewChangeset'
import {
	type ReviewPermissions,
	approvalBlocked,
	availableActions,
	isStaleReview,
	markdownDiff,
	requiresNote,
	toDiffView,
} from '../src/lib/reviewState'

const editorOnly: ReviewPermissions = { canSubmit: true, canReview: false }
const reviewer: ReviewPermissions = { canSubmit: false, canReview: true }
const both: ReviewPermissions = { canSubmit: true, canReview: true }

describe('changeset review, diff and approval UI logic (REV-003)', () => {
	test('permission-aware actions per state', () => {
		// draft: only editors see submit
		expect(availableActions('draft', editorOnly)).toEqual(['submitted'])
		expect(availableActions('draft', reviewer)).toEqual([])

		// submitted: reviewers get the review actions, editors none
		expect(availableActions('submitted', reviewer)).toEqual([
			'changes_requested',
			'approved',
			'rejected',
		])
		expect(availableActions('submitted', editorOnly)).toEqual([])

		// changes_requested: back to editor
		expect(availableActions('changes_requested', editorOnly)).toEqual([
			'submitted',
		])

		// approved: reviewer publishes
		expect(availableActions('approved', reviewer)).toEqual(['published'])

		// terminal states offer nothing to anyone
		expect(availableActions('published', both)).toEqual([])
		expect(availableActions('rejected', both)).toEqual([])
	})

	test('blocking validation disables approval; request-changes needs a note', () => {
		expect(approvalBlocked(0)).toBeFalse()
		expect(approvalBlocked(2)).toBeTrue()
		expect(requiresNote('changes_requested')).toBeTrue()
		expect(requiresNote('approved')).toBeFalse()
	})

	test('stale review detection prompts refresh', () => {
		expect(isStaleReview('submitted', 'submitted')).toBeFalse()
		expect(isStaleReview('submitted', 'approved')).toBeTrue()
		// no server state yet: not stale
		expect(isStaleReview('submitted', undefined)).toBeFalse()
	})

	test('typed diff view separates changed from unchanged with previews', () => {
		const view = toDiffView([
			{ field: 'title', changed: false, base: 'T', proposed: 'T' },
			{
				field: 'body_markdown',
				changed: true,
				base: null,
				proposed: 'x'.repeat(120),
			},
		])
		expect(view.changed).toHaveLength(1)
		expect(view.unchanged).toHaveLength(1)
		expect(view.changed[0].proposedLabel.endsWith('…')).toBeTrue()
		expect(view.changed[0].baseLabel).toBe('—')
	})

	test('markdown diff splits into paragraph blocks both sides', () => {
		const md = markdownDiff('Para satu.\n\nPara dua.', 'Para satu diubah.')
		expect(md.baseParagraphs).toEqual(['Para satu.', 'Para dua.'])
		expect(md.proposedParagraphs).toEqual(['Para satu diubah.'])
		expect(markdownDiff(null, 'Hanya usulan').baseParagraphs).toEqual([])
	})

	test('review component renders pins, diffs, validation, and gated actions', () => {
		const html = renderToString(
			createElement(ReviewChangeset, {
				changesetId: 'cs-1',
				conceptId: 'c-1',
				proposedRevisionId: 'r-2',
				permissions: reviewer,
			}),
		)
		expect(html).toContain('changeset-review')
		// shell renders loading + action area (data loads client-side)
		expect(html).toContain('review-actions')
		expect(html).toContain('review-note')
	})
})
