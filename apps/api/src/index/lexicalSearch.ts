import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import {
	NORMALIZATION_VERSION,
	normalizeText,
} from '../retrieval/queryNormalization'

export interface LexicalHit {
	unitId: string
	logicalUnitId: string
	unitKind: string
	originalText: string
	rank: number
	matchedVia: 'fts' | 'trigram'
}

export interface LexicalSearchResult {
	query: string
	normalizedQuery: string
	normalizationVersion: string
	profileKey: string | null
	profileVersion: number | null
	hits: LexicalHit[]
}

export class LexicalSearchError extends Error {
	constructor(
		public code: 'RELEASE_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'LexicalSearchError'
	}
}

/**
 * Lexical search projection (IDX-003): FTS over the compiled
 * (profile-normalized) vectors with a trigram-similarity fallback for
 * fuzzy/typo queries. Both lanes operate on one index release; the query is
 * normalized with the same normalization stack as the corpus
 * (`normalizeText`, version-tagged) so vocabulary matches the projection.
 */
export async function searchLexical(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	rawQuery: string,
	options: { limit?: number; minSimilarity?: number } = {},
): Promise<LexicalSearchResult> {
	const limit = options.limit ?? 20
	const minSimilarity = options.minSimilarity ?? 0.3

	const [release] = await sql<
		{ id: string; profile_key: string | null; profile_version: number | null }[]
	>`select ir.id, np.key as profile_key, np.version as profile_version
		from index_releases ir
		join index_configurations ic on ic.id = ir.configuration_id
		join normalization_profiles np on np.id = ic.normalization_profile_id
		where ir.id = ${indexReleaseId}::uuid and ir.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!release)
		throw new LexicalSearchError('RELEASE_NOT_FOUND', 'Index release not found')

	const normalizedQuery = normalizeText(rawQuery)

	// lane 1: full-text search over the compiled fts vectors
	const ftsHits = await sql<
		{
			unit_id: string
			logical_unit_id: string
			unit_kind: string
			original_text: string
			rank: string
		}[]
	>`select u.id as unit_id, u.logical_unit_id, u.unit_kind, u.original_text,
				ts_rank(t.fts, websearch_to_tsquery('simple', ${normalizedQuery})) as rank
			from retrieval_units u
			join retrieval_unit_texts t on t.unit_id = u.id
			where u.index_release_id = ${indexReleaseId}::uuid
				and t.fts @@ websearch_to_tsquery('simple', ${normalizedQuery})
			order by rank desc
			limit ${limit}`

	const seen = new Set(ftsHits.map((h) => h.unit_id))
	const hits: LexicalHit[] = ftsHits.map((h) => ({
		unitId: h.unit_id,
		logicalUnitId: h.logical_unit_id,
		unitKind: h.unit_kind,
		originalText: h.original_text,
		rank: Number(h.rank),
		matchedVia: 'fts',
	}))

	// lane 2 (fallback): trigram similarity for fuzzy matches not already hit
	if (hits.length < limit && normalizedQuery.length >= 3) {
		const trigramHits = await sql<
			{
				unit_id: string
				logical_unit_id: string
				unit_kind: string
				original_text: string
				similarity: string
			}[]
		>`select u.id as unit_id, u.logical_unit_id, u.unit_kind, u.original_text,
					similarity(u.original_text, ${normalizedQuery}) as similarity
				from retrieval_units u
				where u.index_release_id = ${indexReleaseId}::uuid
					and (${seen.size > 0 ? sql`u.id not in ${sql([...seen])}` : sql`true`})
					and similarity(u.original_text, ${normalizedQuery}) >= ${minSimilarity}
				order by similarity desc
				limit ${limit - hits.length}`
		for (const h of trigramHits) {
			hits.push({
				unitId: h.unit_id,
				logicalUnitId: h.logical_unit_id,
				unitKind: h.unit_kind,
				originalText: h.original_text,
				rank: Number(h.similarity),
				matchedVia: 'trigram',
			})
		}
	}

	return {
		query: rawQuery,
		normalizedQuery,
		normalizationVersion: NORMALIZATION_VERSION,
		profileKey: release.profile_key,
		profileVersion: release.profile_version,
		hits,
	}
}

/**
 * Rebuild the lexical projection of one release (IDX-003): recompute
 * normalized_text + fts vectors for every unit under the current
 * normalization stack. Used after a normalization-profile change; original
 * text is never touched.
 */
export async function rebuildLexicalProjection(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
): Promise<{ unitsRebuilt: number }> {
	const [release] = await sql<{ id: string }[]>`
		select id from index_releases
		where id = ${indexReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!release)
		throw new LexicalSearchError('RELEASE_NOT_FOUND', 'Index release not found')

	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${indexReleaseId}::uuid`

	let rebuilt = 0
	for (const u of units) {
		const normalized = normalizeText(u.original_text)
		await sql`update retrieval_units set normalized_text = ${normalized} where id = ${u.id}::uuid`
		await sql`update retrieval_unit_texts set fts = to_tsvector('simple', ${normalized}) where unit_id = ${u.id}::uuid`
		rebuilt++
	}
	return { unitsRebuilt: rebuilt }
}
