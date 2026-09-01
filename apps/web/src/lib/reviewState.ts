/**
 * Reviewer state logic for the changeset review UI (REV-003).
 * Pure functions: action availability, permission gating, stale review
 * detection, and diff view-model shaping.
 */
import { CHANGESET_TRANSITIONS } from '@aifiqh/shared'

export interface ReviewPermissions {
	canSubmit: boolean // knowledge:draft
	canReview: boolean // review:approve
}

export interface ChangesetDetail {
	id: string
	title: string
	state: string
	events: {
		action: string
		actorId: string
		reason: string | null
		createdAt: string
	}[]
	itemCount: number
}

/** Actions offerable from the current state, filtered by permission. */
export function availableActions(
	state: string,
	permissions: ReviewPermissions,
): string[] {
	const next = CHANGESET_TRANSITIONS[state] ?? []
	return next.filter((action) => {
		if (action === 'submitted') return permissions.canSubmit
		// changes_requested/approved/published/rejected are reviewer actions
		return permissions.canReview
	})
}

/** Approval must be disabled when a blocking validation error exists. */
export function approvalBlocked(blockingErrors: number): boolean {
	return blockingErrors > 0
}

/** request-changes always requires a non-empty note (server enforces too). */
export function requiresNote(action: string): boolean {
	return action === 'changes_requested'
}

/**
 * The review is stale when the server reports a newer state than the UI's
 * snapshot (e.g. another reviewer acted first). The prompt asks the reviewer
 * to refresh; no action is allowed until they do.
 */
export function isStaleReview(
	uiState: string,
	serverState: string | undefined,
): boolean {
	return serverState !== undefined && uiState !== serverState
}

export interface FieldDiffView {
	field: string
	changed: boolean
	baseLabel: string
	proposedLabel: string
}

function preview(value: unknown, max = 80): string {
	if (value === null || value === undefined) return '—'
	if (typeof value === 'string') {
		return value.length > max ? `${value.slice(0, max)}…` : value
	}
	const s = JSON.stringify(value)
	return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Shape API field diffs into a view model: changed fields first, unchanged
 * collapsed below; markdown body renders side-by-side.
 */
export function toDiffView(
	fieldDiffs: Array<{
		field: string
		changed: boolean
		base: unknown
		proposed: unknown
	}>,
): { changed: FieldDiffView[]; unchanged: FieldDiffView[] } {
	const toView = (f: {
		field: string
		changed: boolean
		base: unknown
		proposed: unknown
	}): FieldDiffView => ({
		field: f.field,
		changed: f.changed,
		baseLabel: preview(f.base),
		proposedLabel: preview(f.proposed),
	})
	return {
		changed: fieldDiffs.filter((f) => f.changed).map(toView),
		unchanged: fieldDiffs.filter((f) => !f.changed).map(toView),
	}
}

/** Markdown body diff view: base and proposed split into paragraph blocks. */
export function markdownDiff(
	base: string | null,
	proposed: string,
): { baseParagraphs: string[]; proposedParagraphs: string[] } {
	return {
		baseParagraphs: (base ?? '')
			.split(/\n{2,}/)
			.filter((p) => p.trim().length > 0),
		proposedParagraphs: proposed
			.split(/\n{2,}/)
			.filter((p) => p.trim().length > 0),
	}
}
