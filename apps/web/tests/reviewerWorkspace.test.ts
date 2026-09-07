/**
 * Component and logic tests for the Reviewer Workspace UI (#110 / #119).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ReviewerWorkspace } from '../src/chat/ReviewerWorkspace'

describe('ReviewerWorkspace component (#119)', () => {
	test('unauthorized user without review:approve is shown gate note', () => {
		const html = renderToString(
			createElement(ReviewerWorkspace, { permissions: ['source:read'] }),
		)
		expect(html).toContain('gate-note')
		expect(html).toContain('review:approve')
		expect(html).not.toContain('reviewer-layout')
	})

	test('authorized user with review:approve renders queue and review layout', () => {
		const html = renderToString(
			createElement(ReviewerWorkspace, { permissions: ['review:approve'] }),
		)
		expect(html).toContain('reviewer-workspace')
		expect(html).toContain('reviewer-queue')
		expect(html).toContain('Antrean Jawaban')
	})
})
