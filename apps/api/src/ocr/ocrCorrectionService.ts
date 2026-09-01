import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

export class OcrCorrectionError extends Error {
	constructor(
		public code:
			| 'OCR_OUTPUT_NOT_FOUND'
			| 'EMPTY_CORRECTION'
			| 'SCOPE_DENIED'
			| 'CORRECTION_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'OcrCorrectionError'
	}
}

export interface OcrCorrectionView {
	id: string
	ocrOutputId: string
	correctedText: string
	editorId: string
	editorName: string | null
	reason: string
	createdAt: string
}

/**
 * Side-by-side data for the review UI: raw OCR output + spans, the page, and
 * the current correction (if any) — raw OCR is read-only forever (OCR-002).
 */
export async function getOcrReview(
	sql: Sql,
	principal: Principal,
	ocrOutputId: string,
): Promise<{
	output: {
		id: string
		provider: string
		model: string
		modelVersion: string
		confidence: number | null
		languageHints: string[]
		spans: { ordinal: number; text: string; confidence: number | null }[]
		pageId: string
		sourceId: string
		sourceRevisionId: string
		pageNumber: number | null
		imageStorageKey: string | null
	}
	currentCorrection: OcrCorrectionView | null
	history: OcrCorrectionView[]
} | null> {
	const [output] = await sql<
		{
			id: string
			provider: string
			model: string
			model_version: string
			confidence: string | null
			language_hints: string[]
			source_page_id: string
			source_id: string
			source_revision_id: string
			page_number: number | null
			image_storage_key: string | null
			access_scope_id: string
		}[]
	>`select o.id, o.provider, o.model, o.model_version, o.confidence::text,
			o.language_hints, o.source_page_id,
			sr.source_id, sr.id as source_revision_id, p.page_number, p.image_storage_key,
			s.access_scope_id
		from ocr_outputs o
		join source_pages p on p.id = o.source_page_id
		join source_revisions sr on sr.id = p.source_revision_id
		join sources s on s.id = sr.source_id
		where o.id = ${ocrOutputId}::uuid
			and s.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!output) return null

	const decision = await checkAccess(
		sql,
		principal,
		'source:read',
		output.access_scope_id,
	)
	if (!decision.allowed) {
		throw new OcrCorrectionError(
			'SCOPE_DENIED',
			`Scope denied: ${decision.reasonCode}`,
		)
	}

	const spans = await sql<
		{ ordinal: number; text: string; confidence: string | null }[]
	>`select ordinal, text, confidence::text from ocr_output_spans
		where ocr_output_id = ${ocrOutputId}::uuid order by ordinal asc`

	const corrections = await sql<
		{
			id: string
			ocr_output_id: string
			corrected_text: string
			editor_id: string
			editor_name: string | null
			reason: string
			created_at: string
		}[]
	>`select c.id, c.ocr_output_id, c.corrected_text, c.editor_id, u.display_name as editor_name,
			c.reason, c.created_at::text
		from ocr_correction_revisions c
		left join users u on u.id = c.editor_id
		where c.ocr_output_id = ${ocrOutputId}::uuid
		order by c.created_at asc`

	const toView = (c: (typeof corrections)[number]): OcrCorrectionView => ({
		id: c.id,
		ocrOutputId: c.ocr_output_id,
		correctedText: c.corrected_text,
		editorId: c.editor_id,
		editorName: c.editor_name,
		reason: c.reason,
		createdAt: c.created_at,
	})

	// the page's actual pointer — restores can re-point at older corrections,
	// so "current" is whatever ocr_correction_current says, not the newest row
	const [pointer] = await sql<{ correction_id: string }[]>`
		select cc.correction_id from ocr_correction_current cc
		where cc.source_page_id = ${output.source_page_id}::uuid
		limit 1`
	const current =
		corrections.find((c) => c.id === pointer?.correction_id) ??
		(corrections.length > 0 ? corrections[corrections.length - 1] : null)

	return {
		output: {
			id: output.id,
			provider: output.provider,
			model: output.model,
			modelVersion: output.model_version,
			confidence: output.confidence ? Number(output.confidence) : null,
			languageHints: output.language_hints,
			spans: spans.map((s) => ({
				ordinal: s.ordinal,
				text: s.text,
				confidence: s.confidence ? Number(s.confidence) : null,
			})),
			pageId: output.source_page_id,
			sourceId: output.source_id,
			sourceRevisionId: output.source_revision_id,
			pageNumber: output.page_number,
			imageStorageKey: output.image_storage_key,
		},
		currentCorrection: current ? toView(current) : null,
		history: corrections.map(toView),
	}
}

/**
 * Save an editor correction as a NEW correction revision (never overwrites a
 * prior one) and move the page's current pointer. Audited.
 */
export async function saveCorrection(
	sql: Sql,
	principal: Principal,
	ocrOutputId: string,
	input: { correctedText: string; reason: string },
	traceId?: string,
): Promise<{ id: string }> {
	const correctedText = input.correctedText.trim()
	const reason = input.reason.trim()
	if (!correctedText) {
		throw new OcrCorrectionError(
			'EMPTY_CORRECTION',
			'Corrected text is required',
		)
	}
	if (!reason) {
		throw new OcrCorrectionError(
			'EMPTY_CORRECTION',
			'A reason is required for each correction',
		)
	}

	return await sql.begin(async (tx) => {
		const [output] = await tx<
			{ source_page_id: string; access_scope_id: string }[]
		>`select o.source_page_id, s.access_scope_id
			from ocr_outputs o
			join source_pages p on p.id = o.source_page_id
			join source_revisions sr on sr.id = p.source_revision_id
			join sources s on s.id = sr.source_id
			where o.id = ${ocrOutputId}::uuid
				and s.tenant_id = ${principal.tenantId}::uuid
			limit 1`
		if (!output) {
			throw new OcrCorrectionError(
				'OCR_OUTPUT_NOT_FOUND',
				'OCR output not found',
			)
		}
		const decision = await checkAccess(
			tx,
			principal,
			'source:read',
			output.access_scope_id,
		)
		if (!decision.allowed) {
			throw new OcrCorrectionError(
				'SCOPE_DENIED',
				`Scope denied: ${decision.reasonCode}`,
			)
		}

		const [created] = await tx<{ id: string }[]>`
			insert into ocr_correction_revisions (ocr_output_id, corrected_text, editor_id, reason)
			values (${ocrOutputId}::uuid, ${correctedText}, ${principal.userId}::uuid, ${reason})
			returning id`

		await tx`
			insert into ocr_correction_current (source_page_id, correction_id)
			values (${output.source_page_id}::uuid, ${created.id}::uuid)
			on conflict (source_page_id) do update set
				correction_id = excluded.correction_id,
				updated_at = now()`

		await tx`
			insert into ocr_correction_events (correction_id, action, actor_id)
			values (${created.id}::uuid, 'created', ${principal.userId}::uuid)`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'ocr.correction_saved',
			entityType: 'ocr_correction',
			entityId: created.id,
			afterRef: { ocrOutputId, sourcePageId: output.source_page_id, reason },
			traceId,
		})

		return { id: created.id }
	})
}

/**
 * Restore (re-point the page at) a prior correction revision — the old
 * correction rows are immutable history; restoring creates a new event only.
 */
export async function restoreCorrection(
	sql: Sql,
	principal: Principal,
	ocrOutputId: string,
	correctionId: string,
	traceId?: string,
): Promise<{ restoredToId: string }> {
	return await sql.begin(async (tx) => {
		const [correction] = await tx<
			{ id: string; source_page_id: string; access_scope_id: string }[]
		>`select c.id, o.source_page_id, s.access_scope_id
			from ocr_correction_revisions c
			join ocr_outputs o on o.id = c.ocr_output_id
			join source_pages p on p.id = o.source_page_id
			join source_revisions sr on sr.id = p.source_revision_id
			join sources s on s.id = sr.source_id
			where c.id = ${correctionId}::uuid
				and c.ocr_output_id = ${ocrOutputId}::uuid
				and s.tenant_id = ${principal.tenantId}::uuid
			limit 1`
		if (!correction) {
			throw new OcrCorrectionError(
				'CORRECTION_NOT_FOUND',
				'Correction not found for this OCR output',
			)
		}
		const decision = await checkAccess(
			tx,
			principal,
			'source:read',
			correction.access_scope_id,
		)
		if (!decision.allowed) {
			throw new OcrCorrectionError(
				'SCOPE_DENIED',
				`Scope denied: ${decision.reasonCode}`,
			)
		}

		await tx`
			insert into ocr_correction_current (source_page_id, correction_id)
			values (${correction.source_page_id}::uuid, ${correction.id}::uuid)
			on conflict (source_page_id) do update set
				correction_id = excluded.correction_id,
				updated_at = now()`

		await tx`
			insert into ocr_correction_events (correction_id, action, actor_id)
			values (${correction.id}::uuid, 'restored', ${principal.userId}::uuid)`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'ocr.correction_restored',
			entityType: 'ocr_correction',
			entityId: correction.id,
			beforeRef: { ocrOutputId },
			afterRef: { restoredToId: correction.id },
			traceId,
		})

		return { restoredToId: correction.id }
	})
}
