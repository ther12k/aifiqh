/**
 * Canonical Citation Snapshot DTO (M6-017 / FR-14).
 *
 * Exposes reader-facing provenance for a specific cited passage pinned to an answer:
 *  - source title, author, source type, language, rights status
 *  - immutable pinned revision (never resolves the latest floating revision)
 *  - page number, section heading, span key
 *  - quoted text (exact cited portion) + canonical span original text
 *  - translation text (only if legitimately recorded in source metadata; never faked)
 *  - surrounding context (adjacent passages in the same pinned revision)
 *
 * Internal metadata (chunk_id, unit_id, retrieval/reranker scores, model names,
 * trace_id, claim_id) is deliberately excluded from reader DTOs.
 */

export const CITATION_SNAPSHOT_VERSION = 'citation-snapshot-v1'

export interface CitationSnapshotSource {
	id: string
	title: string
	author: string | null
	sourceType: string | null
	language: string | null
	rightsStatus: string | null
}

export interface CitationSnapshotRevision {
	id: string
	revisionNumber: number
	status: string
}

export interface CitationSnapshotLocation {
	pageNumber: number | null
	heading: string | null
	spanKey: string | null
}

export interface CitationSnapshotPassage {
	quotedText: string
	originalText: string
	translationText: string | null
}

export interface CitationSnapshotContext {
	before: string | null
	after: string | null
	hasContext: boolean
}

export interface CitationSnapshot {
	version: string
	answerId: string
	ordinal: number
	citationId: string
	source: CitationSnapshotSource
	revision: CitationSnapshotRevision
	location: CitationSnapshotLocation
	passage: CitationSnapshotPassage
	context: CitationSnapshotContext
}
