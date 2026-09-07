/**
 * Corpus acquisition roadmap adapters (#117).
 *
 * Tests:
 * 1. Tanzil adapter preserves exact Arabic Quran text and sets authority_type = quran_text.
 * 2. QuranEnc adapter imports translations with footnotes, sets authority_type = quran_translation.
 * 3. HadeethEnc adapter preserves hadith grading, attribution, and sets authority_type = hadith_commentary.
 * 4. Untraceable passages (missing locator/edition) are quarantined with traceability_status = 'restricted_review' and excluded from index compilation.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { compileIndexRelease } from '../src/index/indexCompiler'
import {
	ingestHadeethEncHadiths,
	ingestQuranEncTranslation,
	ingestTanzilQuran,
} from '../src/sources/corpusAdapters'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

let tenantId = ''
let scopeId = ''
let adminUserId = ''
let principal: Principal
let configurationId = ''
let knowledgeReleaseId = ''

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`ca-t-${suffix}`}, 'CorpusAcq Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`ca-${suffix}@test.local`}, 'ca-admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: [
			'source:create',
			'source:read',
			'knowledge:read',
			'review:approve',
			'review:publish',
		],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-ca-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-ca-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-ca-${suffix}`}) returning id`
	configurationId = config.id

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'CA', 'isi', 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	knowledgeReleaseId = kRelease.id
})

describe('corpus acquisition roadmap (#117)', () => {
	test('Tanzil adapter imports Arabic Quran with quran_text authority and pending_review status', async () => {
		const result = await ingestTanzilQuran(sql, principal, {
			edition: 'uthmani-simple',
			accessScopeId: scopeId,
			ayas: [
				{ sura: 2, aya: 275, text: 'وَأَحَلَّ اللَّهُ الْبَيْعَ وَحَرَّمَ الرِّبَا' },
				{ sura: 2, aya: 276, text: 'يَمْحَقُ اللَّهُ الرِّبَا وَيُرْبِي الصَّدَقَاتِ' },
			],
		})

		expect(result.spansCount).toBe(2)
		expect(result.restrictedCount).toBe(0)

		// Verify source and revision
		const [src] = await sql<
			{ acquisition_channel: string; parser_version: string }[]
		>`
			select acquisition_channel, parser_version from sources where id = ${result.sourceId}::uuid`
		expect(src.acquisition_channel).toBe('tanzil_download')
		expect(src.parser_version).toBe('tanzil-adapter-v1')

		const [rev] = await sql<{ status: string }[]>`
			select status from source_revisions where id = ${result.revisionId}::uuid`
		expect(rev.status).toBe('pending_review')

		// Verify authority type
		const spans = await sql<
			{ authority_type: string; traceability_status: string }[]
		>`
			select authority_type, traceability_status from source_spans where source_revision_id = ${result.revisionId}::uuid`
		expect(spans.every((s) => s.authority_type === 'quran_text')).toBeTrue()
		expect(spans.every((s) => s.traceability_status === 'traceable')).toBeTrue()
	})

	test('QuranEnc adapter preserves translator, footnotes, and sets quran_translation', async () => {
		const result = await ingestQuranEncTranslation(sql, principal, {
			translationKey: 'indonesian_kemenag',
			translatorName: 'Kementerian Agama RI',
			accessScopeId: scopeId,
			verses: [
				{
					sura: 2,
					aya: 183,
					translation:
						'Wahai orang-orang yang beriman, diwajibkan atas kamu berpuasa.',
					footnotes: 'Puasa Ramadhan adalah rukun Islam ketiga.',
				},
			],
		})

		expect(result.spansCount).toBe(1)
		const [span] = await sql<
			{ authority_type: string; original_text: string }[]
		>`
			select authority_type, original_text from source_spans where source_revision_id = ${result.revisionId}::uuid`
		expect(span.authority_type).toBe('quran_translation')
		expect(span.original_text).toContain('Catatan kaki:')
	})

	test('HadeethEnc adapter preserves hadith grading and sets hadith_commentary', async () => {
		const result = await ingestHadeethEncHadiths(sql, principal, {
			collectionName: 'Riyadhus Shalihin (Taharah)',
			accessScopeId: scopeId,
			items: [
				{
					id: 'he-001',
					title: 'Niat dalam Ibadah',
					hadithTextArabic: 'إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ',
					hadithTextTranslation: 'Sesungguhnya amal itu tergantung niatnya.',
					explanation: 'Niat adalah syarat sah dan penentu pahala.',
					attribution: 'HR. Bukhari dan Muslim',
					grade: 'Shahih',
					reference: 'Hadits No. 1',
				},
			],
		})

		expect(result.spansCount).toBe(1)
		const [span] = await sql<
			{ authority_type: string; grading: string; grading_by: string }[]
		>`
			select authority_type, grading, grading_by from source_spans where source_revision_id = ${result.revisionId}::uuid`
		expect(span.authority_type).toBe('hadith_commentary')
		expect(span.grading).toBe('Shahih')
	})

	test('untraceable passage is quarantined as restricted_review and omitted from index compilation', async () => {
		// Import with a missing locator (untraceable)
		const result = await ingestTanzilQuran(sql, principal, {
			edition: 'uthmani-test-restricted',
			accessScopeId: scopeId,
			ayas: [
				{ sura: 0, aya: 0, text: 'Teks tanpa nomor surah dan ayat' }, // untraceable!
				{ sura: 1, aya: 1, text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ' }, // traceable
			],
		})

		expect(result.restrictedCount).toBe(1)

		// Approve the revision
		await approveTestRevision(sql, result.revisionId)

		// Compile index: only traceable spans should be compiled into retrieval units
		const compiled = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId,
			configurationId,
		})

		const compiledSpans = await sql<{ original_text: string }[]>`
			select ru.original_text from retrieval_units ru
			join source_spans ss on ss.id = ru.source_span_id
			where ru.index_release_id = ${compiled.indexReleaseId}::uuid
				and ss.source_revision_id = ${result.revisionId}::uuid`

		expect(compiledSpans.length).toBe(1)
		expect(compiledSpans[0].original_text).toContain('بِسْمِ اللَّهِ')
	})
})
