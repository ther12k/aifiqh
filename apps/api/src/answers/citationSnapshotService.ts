import type { CitationSnapshot, Principal } from '@aifiqh/shared'
import { CITATION_SNAPSHOT_VERSION } from '@aifiqh/shared'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

export class CitationSnapshotError extends Error {
	readonly code:
		| 'ANSWER_NOT_FOUND'
		| 'CONVERSATION_FORBIDDEN'
		| 'CITATION_NOT_FOUND'
		| 'SOURCE_NOT_FOUND'
		| 'SCOPE_DENIED'
		| 'REVISION_NOT_FOUND'
		| 'SPAN_NOT_FOUND'
	readonly reasonCode?: string

	constructor(
		code: CitationSnapshotError['code'],
		message: string,
		reasonCode?: string,
	) {
		super(message)
		this.name = 'CitationSnapshotError'
		this.code = code
		this.reasonCode = reasonCode
	}
}

/**
 * Extract translation text if cleanly separated by standard markers
 * ("Terjemahan:", "Artinya:"), or return null.
 *
 * Never synthesizes or hallucinates translation: if absent in the source record,
 * returns null so the UI can honestly report that no translation is recorded.
 */
function extractTranslation(text: string): {
	originalText: string
	translationText: string | null
} {
	const match = text.match(/\n?(?:Terjemahan|Artinya)\s*:\s*([\s\S]+)$/i)
	if (match && match.index !== undefined) {
		const original = text.slice(0, match.index).trim()
		const translation = match[1].trim()
		return {
			originalText: original.length > 0 ? original : text.trim(),
			translationText: translation.length > 0 ? translation : null,
		}
	}
	return {
		originalText: text.trim(),
		translationText: null,
	}
}

/**
 * Load canonical citation snapshot for an answer.
 *
 * Core invariant (M6-017):
 *  - Resolves the revision PINNED at citation creation time (e.g. R1),
 *    never floating to a newer revision (e.g. R2).
 *  - Enforces permission recheck: if the user lacks `source:read` on the
 *    source's access scope, rejects with SCOPE_DENIED (no content leaked).
 *  - Honest context: if no adjacent spans exist in the pinned revision,
 *    `hasContext` is false.
 *  - No internal leakage: chunk_id, unit_id, retrieval/reranker scores,
 *    and model traces are omitted.
 */
export async function getCitationSnapshot(
	sql: Sql,
	principal: Principal,
	answerId: string,
	ordinal: number,
): Promise<CitationSnapshot> {
	// 1. Verify answer and conversation tenant
	const [ans] = await sql<
		{
			id: string
			conversation_id: string
			tenant_id: string
		}[]
	>`
		select a.id, cv.id as conversation_id, cv.tenant_id
		from answers a
		join messages m on m.id = a.message_id
		join conversations cv on cv.id = m.conversation_id
		where a.id = ${answerId}::uuid and cv.tenant_id = ${principal.tenantId}::uuid
		limit 1`

	if (!ans) {
		throw new CitationSnapshotError(
			'ANSWER_NOT_FOUND',
			'Jawaban tidak ditemukan pada tenant ini',
		)
	}

	// 2. Conversation membership / access check
	const isPrivileged =
		principal.roles.includes('tenant_admin') ||
		principal.roles.includes('operator') ||
		principal.roles.includes('reviewer')

	if (!isPrivileged) {
		const [member] = await sql<{ user_id: string }[]>`
			select user_id from conversation_members
			where conversation_id = ${ans.conversation_id}::uuid
				and user_id = ${principal.userId}::uuid
			limit 1`
		if (!member) {
			throw new CitationSnapshotError(
				'CONVERSATION_FORBIDDEN',
				'Anda tidak memiliki akses ke percakapan ini',
			)
		}
	}

	// 3. Load citation row
	const [citation] = await sql<
		{
			id: string
			answer_id: string
			ordinal: number
			source_id: string
			source_revision_id: string
			page_id: string | null
			section_id: string | null
			span_id: string
			quote: string | null
			quote_match_status: string | null
		}[]
	>`
		select id, answer_id, ordinal, source_id, source_revision_id,
			page_id, section_id, span_id, quote, quote_match_status
		from citations
		where answer_id = ${answerId}::uuid and ordinal = ${ordinal}::int
		limit 1`

	if (!citation) {
		throw new CitationSnapshotError(
			'CITATION_NOT_FOUND',
			`Kutipan nomor [${ordinal}] tidak ditemukan untuk jawaban ini`,
		)
	}

	// 4. Load source and perform scope access check
	const [src] = await sql<
		{
			id: string
			title: string
			author: string | null
			source_type: string | null
			language: string | null
			rights_status: string | null
			access_scope_id: string
		}[]
	>`
		select id, title, author, source_type, language, rights_status, access_scope_id
		from sources
		where id = ${citation.source_id}::uuid and tenant_id = ${principal.tenantId}::uuid
		limit 1`

	if (!src) {
		throw new CitationSnapshotError(
			'SOURCE_NOT_FOUND',
			'Sumber rujukan tidak ditemukan',
		)
	}

	const accessDecision = await checkAccess(
		sql,
		principal,
		'source:read',
		src.access_scope_id,
	)
	if (!accessDecision.allowed) {
		throw new CitationSnapshotError(
			'SCOPE_DENIED',
			'Akses ke sumber ini tidak diizinkan untuk akun Anda',
			accessDecision.reasonCode,
		)
	}

	// 5. Load the EXACT revision pinned to the citation (R1, not latest R2)
	const [rev] = await sql<
		{
			id: string
			revision_number: number
			status: string
		}[]
	>`
		select id, revision_number, status
		from source_revisions
		where id = ${citation.source_revision_id}::uuid
		limit 1`

	if (!rev) {
		throw new CitationSnapshotError(
			'REVISION_NOT_FOUND',
			'Revisi sumber yang dirujuk jawaban tidak ditemukan',
		)
	}

	// 6. Load the span, page, section
	const [span] = await sql<
		{
			id: string
			span_key: string
			original_text: string
			start_offset: number | null
			end_offset: number | null
			page_id: string | null
			page_number: number | null
			section_id: string | null
			heading: string | null
		}[]
	>`
		select sp.id, sp.span_key, sp.original_text, sp.start_offset, sp.end_offset,
			sp.page_id, p.page_number, sp.section_id, sec.heading
		from source_spans sp
		left join source_pages p on p.id = sp.page_id
		left join source_sections sec on sec.id = sp.section_id
		where sp.id = ${citation.span_id}::uuid
			and sp.source_revision_id = ${citation.source_revision_id}::uuid
		limit 1`

	if (!span) {
		throw new CitationSnapshotError(
			'SPAN_NOT_FOUND',
			'Bagian teks sumber yang dirujuk tidak ditemukan dalam revisi ini',
		)
	}

	// 7. Determine passage text and extract translation if legitimately available
	const quotedText = citation.quote?.trim() || span.original_text.trim()
	const { originalText, translationText } = extractTranslation(quotedText)

	// 8. Find surrounding context in the SAME pinned revision
	let beforeText: string | null = null
	let afterText: string | null = null

	if (span.start_offset !== null && span.end_offset !== null) {
		const [prev] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and id <> ${span.id}::uuid
				and end_offset is not null
				and end_offset <= ${span.start_offset}
			order by end_offset desc limit 1`
		if (prev) beforeText = prev.original_text.trim()

		const [next] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and id <> ${span.id}::uuid
				and start_offset is not null
				and start_offset >= ${span.end_offset}
			order by start_offset asc limit 1`
		if (next) afterText = next.original_text.trim()
	} else if (span.section_id) {
		const [prev] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and section_id = ${span.section_id}::uuid
				and id <> ${span.id}::uuid
				and span_key < ${span.span_key}
			order by span_key desc limit 1`
		if (prev) beforeText = prev.original_text.trim()

		const [next] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and section_id = ${span.section_id}::uuid
				and id <> ${span.id}::uuid
				and span_key > ${span.span_key}
			order by span_key asc limit 1`
		if (next) afterText = next.original_text.trim()
	} else if (span.page_id) {
		const [prev] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and page_id = ${span.page_id}::uuid
				and id <> ${span.id}::uuid
				and span_key < ${span.span_key}
			order by span_key desc limit 1`
		if (prev) beforeText = prev.original_text.trim()

		const [next] = await sql<{ original_text: string }[]>`
			select original_text from source_spans
			where source_revision_id = ${citation.source_revision_id}::uuid
				and page_id = ${span.page_id}::uuid
				and id <> ${span.id}::uuid
				and span_key > ${span.span_key}
			order by span_key asc limit 1`
		if (next) afterText = next.original_text.trim()
	}

	const hasContext = Boolean(beforeText || afterText)

	return {
		version: CITATION_SNAPSHOT_VERSION,
		answerId,
		ordinal: citation.ordinal,
		citationId: citation.id,
		source: {
			id: src.id,
			title: src.title,
			author: src.author,
			sourceType: src.source_type,
			language: src.language,
			rightsStatus: src.rights_status,
		},
		revision: {
			id: rev.id,
			revisionNumber: rev.revision_number,
			status: rev.status,
		},
		location: {
			pageNumber: span.page_number,
			heading: span.heading,
			spanKey: span.span_key,
		},
		passage: {
			quotedText,
			originalText,
			translationText,
		},
		context: {
			before: beforeText,
			after: afterText,
			hasContext,
		},
	}
}
