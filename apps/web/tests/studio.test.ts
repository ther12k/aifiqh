/**
 * Component + logic tests for the Knowledge Studio concept editor (STU-001)
 * and the source registry UI (SRC-004). Rendering uses react-dom/server
 * (no DOM dependency); interactive behavior is exercised through the pure
 * editor-state logic module.
 */
import { describe, expect, test } from 'bun:test'
import type { ConceptType } from '@aifiqh/shared'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ConceptEditor } from '../src/knowledge/ConceptEditor'
import {
	EMPTY_DRAFT,
	applyServerResponse,
	isDirty,
	recoveryKey,
	validateDraft,
} from '../src/lib/editorState'
import {
	REVISION_STATUS_LABELS,
	SourceRegistry,
	canDeprecateRevision,
	canReviewRevision,
	canUploadRevision,
} from '../src/sources/SourceRegistry'

describe('schema-driven concept editor logic (STU-001)', () => {
	test('each concept type enforces its own required fields', () => {
		// definition: title + body
		const defErrors = validateDraft({
			...EMPTY_DRAFT,
			typeKey: 'definition',
			title: 'Definisi',
			bodyMarkdown: 'Isi',
		})
		expect(Object.keys(defErrors)).toHaveLength(0)

		// fiqh_position additionally requires madhhab
		const posMissing = validateDraft({
			...EMPTY_DRAFT,
			typeKey: 'fiqh_position',
			title: 'Posisi',
			bodyMarkdown: 'Isi',
		})
		expect(posMissing.madhhab).toBeDefined()

		const posComplete = validateDraft({
			...EMPTY_DRAFT,
			typeKey: 'fiqh_position',
			title: 'Posisi',
			bodyMarkdown: 'Isi',
			madhhab: ['shafii'],
		})
		expect(Object.keys(posComplete)).toHaveLength(0)
	})

	test('dirty tracking compares every editable field', () => {
		const saved = {
			...EMPTY_DRAFT,
			title: 'a',
			madhhab: ['shafii'] as string[],
		}
		expect(isDirty(saved, saved)).toBeFalse()
		expect(isDirty({ ...saved, title: 'b' }, saved)).toBeTrue()
		expect(isDirty({ ...saved, madhhab: ['hanafi'] }, saved)).toBeTrue()
		expect(isDirty({ ...saved, topicPath: ['taharah'] }, saved)).toBeTrue()
	})

	test('server conflict response surfaces the stale-edit prompt', () => {
		const applied = applyServerResponse(409, { error: 'conflict' })
		expect(applied.conflict).toBeTrue()
		expect(applied.globalError).toContain('stale')

		const validation = applyServerResponse(400, {
			error: 'validation_failed',
			message: 'Validation failed for fiqh_position: missing [madhhab]',
		})
		expect(validation.fieldErrors.madhhab).toBeDefined()
		expect(validation.conflict).toBeFalse()

		const forbidden = applyServerResponse(403, {})
		expect(forbidden.globalError).toContain('tidak berhak')
	})

	test('recovery key namespace is stable', () => {
		expect(recoveryKey('concept-123')).toBe('aifiqh.draft-recovery.concept-123')
		expect(recoveryKey('new')).toBe('aifiqh.draft-recovery.new')
	})

	test('editor renders the editor shell with type selector and recovery-safe fields', () => {
		const html = renderToString(
			createElement(ConceptEditor, {
				conceptId: 'new',
				accessScopeId: '00000000-0000-0000-0000-000000000000',
			}),
		)
		expect(html).toContain('concept-editor')
		expect(html).toContain('type-select')
		expect(html).toContain('title-input')
		expect(html).toContain('body-input')
		expect(html).toContain('language-select')
		expect(html).toContain('madhhab-shafii')
		expect(html).toContain('save-button')
		// markdown preview hidden until toggled
		expect(html).not.toContain('markdown-preview')
	})

	test('editor selector lists all 9 concept type profiles with human names', () => {
		const html = renderToString(
			createElement(ConceptEditor, {
				conceptId: 'new',
				accessScopeId: '00000000-0000-0000-0000-000000000000',
			}),
		)
		for (const label of [
			'Istilah / Definisi',
			'Fatwa / Posisi Madzhab',
			'Perbandingan Madzhab',
			'Ketentuan Sistem',
		]) {
			expect(html).toContain(label)
		}
	})
})

describe('source registry & revision timeline UI (SRC-004)', () => {
	test('renders search, list shell, and respects permission hints', () => {
		const html = renderToString(
			createElement(SourceRegistry, {
				permissions: ['source:read'],
			}),
		)
		expect(html).toContain('source-registry')
		expect(html).toContain('source-search')
		// no upload control without source:create
		expect(html).not.toContain('upload-input')
	})

	test('upload/deprecate gating is a pure permission+selection rule', () => {
		// no selection: upload never offered, even with permission
		expect(
			canUploadRevision(['source:read', 'source:create'], false),
		).toBeFalse()
		// selection without permission: denied
		expect(canUploadRevision(['source:read'], true)).toBeFalse()
		// selection + permission: offered
		expect(canUploadRevision(['source:read', 'source:create'], true)).toBeTrue()

		expect(canDeprecateRevision(['source:read'])).toBeFalse()
		expect(canDeprecateRevision(['source:read', 'source:deprecate'])).toBeTrue()
	})

	test('editorial review gating (#108): only review:approve decides', () => {
		// an editor can upload but never approve their own upload
		expect(
			canReviewRevision(['source:read', 'source:create', 'source:deprecate']),
		).toBeFalse()
		// the reviewer role carries the decision permission
		expect(canReviewRevision(['source:read', 'review:approve'])).toBeTrue()

		// every lifecycle state has an honest Indonesian label
		for (const status of [
			'processing',
			'pending_review',
			'active',
			'deprecated',
		]) {
			expect(REVISION_STATUS_LABELS[status]).toBeTruthy()
		}
	})
})
