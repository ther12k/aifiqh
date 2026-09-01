import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { normalizeText } from './queryNormalization'

/**
 * Retrieval candidate lanes (RAG-003..006).
 *
 * Each lane is an independent, deterministic retrieval strategy over ONE
 * pinned index release. Candidates always carry their lineage pins
 * (source_span / knowledge_revision) so downstream citation rendering can
 * point at canonical evidence, never at the derived index row alone.
 */

export interface RetrievalCandidate {
	unitId: string
	logicalUnitId: string
	unitKind: string
	/** canonical lineage pin: the source span this unit was compiled from */
	sourceSpanId: string | null
	/** canonical lineage pin: the knowledge revision this unit was compiled from */
	knowledgeRevisionId: string | null
	originalText: string
	score: number
	/** why this candidate matched — lane-specific metadata */
	matchMetadata: Record<string, unknown>
}

export interface LaneFilterReason {
	code: string
	detail: string
}

/** Classified lane failure — carried to HTTP responses as { error, lane }. */
export class LaneError extends Error {
	readonly code: string
	readonly lane: string

	constructor(code: string, lane: string, message: string) {
		super(message)
		this.name = 'LaneError'
		this.code = code
		this.lane = lane
	}
}

/** MVP convention: retrieval_embeddings vectors are fixed at 768 dims. */
export const EMBEDDING_DIMENSIONS = 768

// ---------------------------------------------------------------------------
// RAG-003: exact identifier lookup lane
// ---------------------------------------------------------------------------

export interface IdentifierRef {
	kind: 'kitab' | 'hadits' | 'page' | 'section' | 'qs' | 'juz' | 'span'
	/** raw matched text */
	raw: string
	/** extracted number or key when present */
	value?: string
}

const ID_PATTERNS: Array<{
	kind: IdentifierRef['kind']
	re: RegExp
	group?: number
}> = [
	{
		kind: 'hadits',
		re: /(?:hr\.?|hadits|riwayat)\s*(?:no\.?|nomor)?\s*(\d+(?:[a-z]+)?)/i,
		group: 1,
	},
	{ kind: 'kitab', re: /(?:kitab|bab)\s+([\w\u0600-\u06FF-]+)/i, group: 1 },
	{
		kind: 'qs',
		re: /(?:qs|q\.s\.?|surat)\s*[:(]?\s*(\d+\s*:\s*\d+|\w+)/i,
		group: 1,
	},
	{ kind: 'juz', re: /juz\s*(\d+)/i, group: 1 },
	{ kind: 'page', re: /(?:hal\.?|halaman|hlm\.?)\s*(\d+)/i, group: 1 },
	{ kind: 'section', re: /(?:pasal|section)\s*(\d+)/i, group: 1 },
]

/** Parse bibliographic/corpus identifiers from a raw query (RAG-003). */
export function parseIdentifiers(query: string): IdentifierRef[] {
	const refs: IdentifierRef[] = []
	for (const { kind, re, group } of ID_PATTERNS) {
		const m = query.match(re)
		if (m) {
			refs.push({ kind, raw: m[0], value: group ? m[group] : undefined })
		}
	}
	return refs
}

/**
 * Exact identifier lookup: resolves identifiers deterministically against a
 * pinned index release BEFORE any semantic retrieval runs — no embedding
 * fallback exists for this lane. Ambiguous numbering (one identifier hitting
 * several units) returns the scoped alternatives instead of guessing.
 */
export async function runExactIdentifierLane(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	query: string,
	options: { topK?: number } = {},
): Promise<{
	candidates: RetrievalCandidate[]
	identifiers: IdentifierRef[]
	ambiguous: boolean
}> {
	const topK = options.topK ?? 10
	const identifiers = parseIdentifiers(query)
	if (identifiers.length === 0)
		return { candidates: [], identifiers, ambiguous: false }

	const candidates: RetrievalCandidate[] = []
	for (const ref of identifiers) {
		// deterministic lookup: exact substring of the identifier value in
		// headings/titles of compiled units (original text preserved)
		const needle = (ref.value ?? ref.raw).toLowerCase()
		const rows = await sql<
			{
				id: string
				logical_unit_id: string
				unit_kind: string
				source_span_id: string | null
				knowledge_revision_id: string | null
				original_text: string
			}[]
		>`select id, logical_unit_id, unit_kind, source_span_id, knowledge_revision_id, original_text
			from retrieval_units
			where index_release_id = ${indexReleaseId}::uuid
				and tenant_id = ${principal.tenantId}::uuid
				and access_scope_id = any(${principal.scopes}::uuid[])
				-- match ORIGINAL TEXT only: logical unit ids embed uuids, and a
				-- numeric needle ('12') would substring-match random uuids
				and position(lower(${needle}) in lower(original_text)) > 0
			limit ${topK}`
		const alternatives = rows.length
		for (const r of rows) {
			candidates.push({
				unitId: r.id,
				logicalUnitId: r.logical_unit_id,
				unitKind: r.unit_kind,
				sourceSpanId: r.source_span_id,
				knowledgeRevisionId: r.knowledge_revision_id,
				originalText: r.original_text,
				// exact match: deterministic, top score
				score: 1.0 / (1 + (alternatives - 1) * 0.05),
				matchMetadata: {
					lane: 'exact_identifier',
					identifier: ref.kind,
					identifierValue: ref.value ?? ref.raw,
					// one identifier resolving to several units is surfaced,
					// never silently collapsed to a single guess
					scopedAlternatives: alternatives,
					ambiguous: alternatives > 1,
				},
			})
		}
	}
	return {
		candidates,
		identifiers,
		ambiguous: candidates.some((c) => c.matchMetadata.ambiguous === true),
	}
}

// ---------------------------------------------------------------------------
// RAG-004: exact Arabic quotation lookup lane
// ---------------------------------------------------------------------------

/**
 * Extract a candidate exact-quote phrase: quoted text first, else a longest
 * Arabic-script run in the query.
 */
export function detectQuotePhrase(query: string): string | null {
	const quoted = query.match(/["“”«]([^"”»]{3,})["“”»]/)
	if (quoted) return quoted[1].trim()

	const arabicRun = query.match(/[\u0600-\u06FF][\u0600-\u06FF\s]{6,}/)
	if (arabicRun) return arabicRun[0].trim()

	return null
}

/**
 * Exact Arabic quotation lookup: matches the phrase in ORIGINAL text first
 * (verbatim), then in CONTROLLED-NORMALIZED text (tashkeel/tatweel stripped)
 * so a non-vocalized query finds vocalized nash — the transformation is
 * labeled per candidate, never silent. Verbatim matches rank first; tighter
 * containing units rank above sprawling ones. A phrase hitting more units
 * than can be shown is flagged for disambiguation.
 */
export async function runExactQuoteLane(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	query: string,
	options: { topK?: number } = {},
): Promise<{
	candidates: RetrievalCandidate[]
	phrase: string | null
	needsDisambiguation: boolean
}> {
	const topK = options.topK ?? 10
	const phrase = detectQuotePhrase(query)
	if (!phrase || phrase.length < 3)
		return { candidates: [], phrase: null, needsDisambiguation: false }

	const normalizedPhrase = normalizeText(phrase)

	const rows = await sql<
		{
			id: string
			logical_unit_id: string
			unit_kind: string
			source_span_id: string | null
			knowledge_revision_id: string | null
			original_text: string
			is_verbatim: boolean
			total_matches: string
		}[]
	>`select id, logical_unit_id, unit_kind, source_span_id, knowledge_revision_id, original_text,
				(position(${phrase} in original_text) > 0) as is_verbatim,
				count(*) over () as total_matches
			from retrieval_units
			where index_release_id = ${indexReleaseId}::uuid
				and tenant_id = ${principal.tenantId}::uuid
				and access_scope_id = any(${principal.scopes}::uuid[])
				and (
					position(${phrase} in original_text) > 0
					or position(${normalizedPhrase} in normalized_text) > 0
				)
			limit ${topK}`

	const totalMatches = rows.length > 0 ? Number(rows[0].total_matches) : 0
	const candidates = rows
		.map((r) => ({
			unitId: r.id,
			logicalUnitId: r.logical_unit_id,
			unitKind: r.unit_kind,
			sourceSpanId: r.source_span_id,
			knowledgeRevisionId: r.knowledge_revision_id,
			originalText: r.original_text,
			// verbatim beats normalized; shorter unit = tighter quote context
			score:
				(r.is_verbatim ? 1.0 : 0.8) * (1 / (1 + r.original_text.length / 1000)),
			matchMetadata: {
				lane: 'exact_quote',
				matchType: r.is_verbatim ? 'verbatim' : 'normalized',
				// label the transformation explicitly: normalization here is
				// controlled tashkeel/tatweel removal only (query-norm-v1)
				transformations: r.is_verbatim
					? []
					: ['tashkeel_removed', 'tatweel_removed'],
				phrase,
				commonPhrase: totalMatches > topK,
			} as Record<string, unknown>,
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)

	// a phrase matching more units than we return is a common-phrase ask:
	// surface the ambiguity instead of presenting the top hit as certainty
	return { candidates, phrase, needsDisambiguation: totalMatches > topK }
}

// ---------------------------------------------------------------------------
// RAG-005: lexical retrieval with metadata filtering
// ---------------------------------------------------------------------------

export interface LexicalFilters {
	madhhab?: string[]
	language?: string
	topicPath?: string[]
}

/**
 * Lexical lane: FTS/trigram query over ONE pinned release's compiled units
 * with metadata + tenant filters applied IN the SQL — no out-of-scope
 * candidate ever surfaces to be re-filtered in application code.
 */
export async function runLexicalLane(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	query: string,
	filters: LexicalFilters = {},
	options: { topK?: number } = {},
): Promise<{
	candidates: RetrievalCandidate[]
	filterReasons: LaneFilterReason[]
}> {
	const topK = options.topK ?? 20
	const filterReasons: LaneFilterReason[] = []
	const normalized = normalizeText(query)

	const madhhabFilter =
		filters.madhhab && filters.madhhab.length > 0
			? sql` and ru.madhhab && ${filters.madhhab}`
			: sql``
	const languageFilter = filters.language
		? sql` and ru.language = ${filters.language}`
		: sql``
	const topicFilter =
		filters.topicPath && filters.topicPath.length > 0
			? sql` and ru.topic_path && ${filters.topicPath}`
			: sql``
	if (filters.madhhab && filters.madhhab.length > 0)
		filterReasons.push({
			code: 'FILTER_MADHHAB',
			detail: filters.madhhab.join(','),
		})
	if (filters.language)
		filterReasons.push({ code: 'FILTER_LANGUAGE', detail: filters.language })
	if (filters.topicPath && filters.topicPath.length > 0)
		filterReasons.push({
			code: 'FILTER_TOPIC',
			detail: filters.topicPath.join(','),
		})

	const rows = await sql<
		{
			id: string
			logical_unit_id: string
			unit_kind: string
			source_span_id: string | null
			knowledge_revision_id: string | null
			original_text: string
			rank: string
			similarity: string
		}[]
	>`select ru.id, ru.logical_unit_id, ru.unit_kind, ru.source_span_id, ru.knowledge_revision_id,
			ru.original_text,
			ts_rank(t.fts, websearch_to_tsquery('simple', ${normalized})) as rank,
			similarity(ru.original_text, ${normalized}) as similarity
		from retrieval_units ru
		join retrieval_unit_texts t on t.unit_id = ru.id
		where ru.index_release_id = ${indexReleaseId}::uuid
			and ru.tenant_id = ${principal.tenantId}::uuid
			and ru.access_scope_id = any(${principal.scopes}::uuid[])
			${madhhabFilter}${languageFilter}${topicFilter}
			and (
				t.fts @@ websearch_to_tsquery('simple', ${normalized})
				or similarity(ru.original_text, ${normalized}) >= 0.3
			)
		order by rank desc, similarity desc
		limit ${topK}`

	return {
		candidates: rows.map((r) => ({
			unitId: r.id,
			logicalUnitId: r.logical_unit_id,
			unitKind: r.unit_kind,
			sourceSpanId: r.source_span_id,
			knowledgeRevisionId: r.knowledge_revision_id,
			originalText: r.original_text,
			score: Number(r.rank) + Number(r.similarity) * 0.5,
			matchMetadata: {
				lane: 'lexical',
				rank: Number(r.rank),
				similarity: Number(r.similarity),
			},
		})),
		filterReasons,
	}
}

// ---------------------------------------------------------------------------
// RAG-006: semantic vector retrieval with metadata filtering
// ---------------------------------------------------------------------------

export interface VectorLaneInput {
	queryEmbedding: number[]
	modelId: string
	modelVersion: string
}

/**
 * Semantic vector lane: cosine distance search against the release's
 * model-versioned embeddings, with metadata/tenant prefilter INSIDE the
 * query so scope policy is enforced before any candidate is exposed.
 * Failures are classified (LaneError), never swallowed.
 */
export async function runVectorLane(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	input: VectorLaneInput,
	filters: LexicalFilters = {},
	options: { topK?: number } = {},
): Promise<{
	candidates: RetrievalCandidate[]
	filterReasons: LaneFilterReason[]
}> {
	const topK = options.topK ?? 20
	const filterReasons: LaneFilterReason[] = []

	if (input.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
		throw new LaneError(
			'EMBEDDING_DIMENSION_MISMATCH',
			'vector',
			`query embedding has ${input.queryEmbedding.length} dims, projection is ${EMBEDDING_DIMENSIONS}`,
		)
	}

	const madhhabFilter =
		filters.madhhab && filters.madhhab.length > 0
			? sql` and ru.madhhab && ${filters.madhhab}`
			: sql``
	const languageFilter = filters.language
		? sql` and ru.language = ${filters.language}`
		: sql``
	if (filters.madhhab && filters.madhhab.length > 0)
		filterReasons.push({
			code: 'FILTER_MADHHAB',
			detail: filters.madhhab.join(','),
		})
	if (filters.language)
		filterReasons.push({ code: 'FILTER_LANGUAGE', detail: filters.language })

	const vectorLiteral = `[${input.queryEmbedding.join(',')}]`

	const rows = await sql<
		{
			id: string
			logical_unit_id: string
			unit_kind: string
			source_span_id: string | null
			knowledge_revision_id: string | null
			original_text: string
			distance: string
		}[]
	>`select ru.id, ru.logical_unit_id, ru.unit_kind, ru.source_span_id, ru.knowledge_revision_id,
			ru.original_text,
			(re.embedding <=> ${vectorLiteral}::vector) as distance
		from retrieval_embeddings re
		join retrieval_units ru on ru.id = re.unit_id
		where ru.index_release_id = ${indexReleaseId}::uuid
			and ru.tenant_id = ${principal.tenantId}::uuid
			and ru.access_scope_id = any(${principal.scopes}::uuid[])
			and re.model_id = ${input.modelId}
			and re.model_version = ${input.modelVersion}
			${madhhabFilter}${languageFilter}
		order by re.embedding <=> ${vectorLiteral}::vector
		limit ${topK}`

	return {
		candidates: rows.map((r) => ({
			unitId: r.id,
			logicalUnitId: r.logical_unit_id,
			unitKind: r.unit_kind,
			sourceSpanId: r.source_span_id,
			knowledgeRevisionId: r.knowledge_revision_id,
			originalText: r.original_text,
			// cosine distance → similarity score (1 - distance, clamped ≥ 0)
			score: Math.max(0, 1 - Number(r.distance)),
			matchMetadata: {
				lane: 'vector',
				distance: Number(r.distance),
				modelId: input.modelId,
				modelVersion: input.modelVersion,
			},
		})),
		filterReasons,
	}
}
