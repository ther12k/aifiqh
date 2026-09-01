import { createHash } from 'node:crypto'
import type {
	CanonicalFootnote,
	CanonicalPage,
	CanonicalSection,
	CanonicalSpan,
	ProcessorOutput,
} from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Generate a deterministic, stable span key based on content and location.
 */
export function generateStableSpanKey(
	pageNumber: number | null | undefined,
	sectionOrdinal: number | null | undefined,
	ordinal: number,
	text: string,
): string {
	const contentHash = createHash('sha256')
		.update(text.trim())
		.digest('hex')
		.slice(0, 12)
	const pagePart = pageNumber ? `p${pageNumber}` : 'pX'
	const secPart = sectionOrdinal ? `s${sectionOrdinal}` : 'sX'
	return `${pagePart}-${secPart}-${ordinal.toString().padStart(4, '0')}-${contentHash}`
}

export interface SpanResolutionResult {
	sourceId: string
	sourceRevisionId: string
	revisionNumber: number
	revisionStatus: string
	span: {
		id: string
		spanKey: string
		originalText: string
		startOffset: number | null
		endOffset: number | null
	}
	page: {
		id: string | null
		pageNumber: number | null
		imageStorageKey: string | null
	} | null
	section: {
		id: string | null
		ordinal: number | null
		heading: string | null
		parentSectionId: string | null
	} | null
	coordinates: Array<{
		box: Record<string, unknown>
		ordinal: number
	}>
	footnotes: Array<{
		marker: string
		noteText: string | null
	}>
}

/**
 * Materialize canonical pages, sections, spans, coordinates, and footnotes into PostgreSQL.
 */
export async function materializeExtraction(
	sql: Sql,
	sourceRevisionId: string,
	output: ProcessorOutput,
): Promise<{
	pagesCount: number
	sectionsCount: number
	spansCount: number
	footnotesCount: number
}> {
	return await sql.begin(async (tx) => {
		// 1. Pages map
		const pageMap = new Map<number, string>()
		for (const page of output.pages) {
			const [p] = await tx<{ id: string }[]>`
				insert into source_pages (source_revision_id, page_number, image_storage_key)
				values (${sourceRevisionId}::uuid, ${page.pageNumber}, ${page.imageStorageKey ?? null})
				on conflict (source_revision_id, page_number) do update
					set image_storage_key = excluded.image_storage_key
				returning id`
			pageMap.set(page.pageNumber, p.id)
		}

		// 2. Sections map (pass 1: insert roots and sections)
		const sectionMap = new Map<number, string>()
		for (const sec of output.sections) {
			const [s] = await tx<{ id: string }[]>`
				insert into source_sections (source_revision_id, ordinal, heading)
				values (${sourceRevisionId}::uuid, ${sec.ordinal}, ${sec.heading ?? null})
				on conflict (source_revision_id, ordinal) do update
					set heading = excluded.heading
				returning id`
			sectionMap.set(sec.ordinal, s.id)
		}

		// (pass 2: link parent sections)
		for (const sec of output.sections) {
			if (sec.parentOrdinal && sectionMap.has(sec.parentOrdinal)) {
				const parentId = sectionMap.get(sec.parentOrdinal)!
				const secId = sectionMap.get(sec.ordinal)!
				await tx`
					update source_sections
					set parent_section_id = ${parentId}::uuid
					where id = ${secId}::uuid`
			}
		}

		// 3. Spans map
		const spanMap = new Map<string, string>()
		let spanOrdinal = 0
		for (const span of output.spans) {
			spanOrdinal++
			const pageId = span.pageNumber ? pageMap.get(span.pageNumber) ?? null : null
			const sectionId = span.sectionOrdinal
				? sectionMap.get(span.sectionOrdinal) ?? null
				: null
			const spanKey =
				span.spanKey ||
				generateStableSpanKey(
					span.pageNumber,
					span.sectionOrdinal,
					spanOrdinal,
					span.originalText,
				)

			const [sp] = await tx<{ id: string }[]>`
				insert into source_spans (
					source_revision_id,
					section_id,
					page_id,
					span_key,
					original_text,
					start_offset,
					end_offset
				)
				values (
					${sourceRevisionId}::uuid,
					${sectionId ? sql`${sectionId}::uuid` : null},
					${pageId ? sql`${pageId}::uuid` : null},
					${spanKey},
					${span.originalText},
					${span.startOffset ?? null},
					${span.endOffset ?? null}
				)
				on conflict (source_revision_id, span_key) do update
					set start_offset = excluded.start_offset, end_offset = excluded.end_offset
				returning id`
			spanMap.set(spanKey, sp.id)
		}

		// 4. Footnotes
		let footnotesCount = 0
		if (output.footnotes) {
			for (const fn of output.footnotes) {
				const anchorId = spanMap.get(fn.anchorSpanKey)
				const noteId = spanMap.get(fn.noteSpanKey)
				if (anchorId && noteId) {
					await tx`
						insert into source_footnotes (
							source_revision_id,
							marker,
							anchor_span_id,
							note_span_id
						)
						values (
							${sourceRevisionId}::uuid,
							${fn.marker},
							${anchorId}::uuid,
							${noteId}::uuid
						)`
					footnotesCount++
				}
			}
		}

		return {
			pagesCount: output.pages.length,
			sectionsCount: output.sections.length,
			spansCount: output.spans.length,
			footnotesCount,
		}
	})
}

/**
 * Resolve a span by its stable key or UUID, including full lineage, section tree, and coordinates.
 */
export async function resolveSpan(
	sql: Sql,
	sourceId: string,
	revisionId: string,
	spanKeyOrId: string,
): Promise<SpanResolutionResult | null> {
	const isUuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			spanKeyOrId,
		)

	const [row] = await sql<
		{
			source_id: string
			source_revision_id: string
			revision_number: number
			revision_status: string
			span_id: string
			span_key: string
			original_text: string
			start_offset: number | null
			end_offset: number | null
			page_id: string | null
			page_number: number | null
			image_storage_key: string | null
			section_id: string | null
			ordinal: number | null
			heading: string | null
			parent_section_id: string | null
		}[]
	>`select
			sr.source_id,
			sr.id as source_revision_id,
			sr.revision_number,
			sr.status as revision_status,
			sp.id as span_id,
			sp.span_key,
			sp.original_text,
			sp.start_offset,
			sp.end_offset,
			p.id as page_id,
			p.page_number,
			p.image_storage_key,
			sec.id as section_id,
			sec.ordinal,
			sec.heading,
			sec.parent_section_id
		from source_spans sp
		join source_revisions sr on sr.id = sp.source_revision_id
		left join source_pages p on p.id = sp.page_id
		left join source_sections sec on sec.id = sp.section_id
		where sr.source_id = ${sourceId}::uuid
			and sr.id = ${revisionId}::uuid
			and (${isUuid ? sql`sp.id = ${spanKeyOrId}::uuid` : sql`sp.span_key = ${spanKeyOrId}`})
		limit 1`

	if (!row) return null

	// Fetch coordinates if any
	const coords = await sql<
		{
			box: Record<string, unknown>
			ordinal: number
		}[]
	>`select box, ordinal
		from span_coordinates
		where span_id = ${row.span_id}::uuid
		order by ordinal asc`

	// Fetch footnotes where this span is the anchor
	const footnotes = await sql<
		{
			marker: string
			note_text: string | null
		}[]
	>`select fn.marker, note_sp.original_text as note_text
		from source_footnotes fn
		left join source_spans note_sp on note_sp.id = fn.note_span_id
		where fn.anchor_span_id = ${row.span_id}::uuid`

	return {
		sourceId: row.source_id,
		sourceRevisionId: row.source_revision_id,
		revisionNumber: row.revision_number,
		revisionStatus: row.revision_status,
		span: {
			id: row.span_id,
			spanKey: row.span_key,
			originalText: row.original_text,
			startOffset: row.start_offset,
			endOffset: row.end_offset,
		},
		page: row.page_id
			? {
					id: row.page_id,
					pageNumber: row.page_number,
					imageStorageKey: row.image_storage_key,
				}
			: null,
		section: row.section_id
			? {
					id: row.section_id,
					ordinal: row.ordinal,
					heading: row.heading,
					parentSectionId: row.parent_section_id,
				}
			: null,
		coordinates: coords.map((c) => ({
			box: c.box,
			ordinal: c.ordinal,
		})),
		footnotes: footnotes.map((f) => ({
			marker: f.marker,
			noteText: f.note_text,
		})),
	}
}
