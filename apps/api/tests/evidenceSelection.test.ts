import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	HashEmbeddingProvider,
	embedIndexRelease,
} from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import {
	type EvidenceCandidate,
	type EvidencePolicy,
	applyEvidencePolicy,
	selectEvidence,
} from '../src/retrieval/evidenceSelector'
import { executeLanePlan } from '../src/retrieval/laneFusion'
import type { RetrievalCandidate } from '../src/retrieval/retrievalLanes'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

function ev(
	unitId: string,
	text: string,
	madhhab: string[],
	sourceKey: string,
): EvidenceCandidate {
	return {
		unitId,
		logicalUnitId: `span:${unitId}`,
		unitKind: 'source_span',
		sourceSpanId: null,
		knowledgeRevisionId: null,
		originalText: text,
		score: 1,
		matchMetadata: {},
		madhhab,
		sourceKey,
	}
}

const POLICY: EvidencePolicy = {
	topK: 6,
	maxPerSource: 2,
	maxPerMadhhab: 3,
	overlapThreshold: 0.8,
}

describe('EVD-002: evidence selection policy (pure)', () => {
	beforeAll(ensureMigrations)

	test('overlapping spans collapse to the highest-ranked representative', () => {
		const ranked = [
			ev('a', 'hukum air mutlak adalah suci', ['syafii'], 'src1'),
			ev(
				'b',
				'hukum air mutlak adalah suci dan menyucikan',
				['syafii'],
				'src1',
			),
			ev(
				'c',
				'waktu shalat subud dimulai dari terbit fajar',
				['hanafi'],
				'src2',
			),
		]
		const sel = applyEvidencePolicy(ranked, POLICY)
		expect(sel.selected.map((c) => c.unitId)).toEqual(['a', 'c'])
		const collapse = sel.exclusions.find((e) => e.unitId === 'b')
		expect(collapse?.code).toBe('OVERLAP_COLLAPSED')
		expect(collapse?.detail).toContain('a')
	})

	test('per-source cap stops one book flooding the evidence set', () => {
		const topics = [
			'puasa ramadan hukum berbuka',
			'zakat fitrah pembayaran dengan makanan',
			'haji tamattut ihram rangkap',
			'shalat jumat syarat khutbah',
			'wudhu batal menyentuh kulit',
		]
		const ranked = topics.map((text, i) =>
			ev(`u${i}`, text, ['syafii'], 'src1'),
		)
		const sel = applyEvidencePolicy(ranked, POLICY)
		expect(sel.selected).toHaveLength(2)
		const capped = sel.exclusions.filter((e) => e.code === 'SOURCE_CAP')
		expect(capped).toHaveLength(3)
		expect(capped.every((e) => e.detail.includes('src1'))).toBeTrue()
	})

	test('per-madhhab cap recorded, other schools unaffected', () => {
		const capPolicy: EvidencePolicy = { ...POLICY, maxPerMadhhab: 2 }
		const ranked = [
			ev('s1', 'qurban sapi pendapat pertama', ['syafii'], 'src1'),
			ev('s2', 'qurban kambing dalil kedua berbeda', ['syafii'], 'src2'),
			ev('s3', 'qurban unta aturan ketiga tersendiri', ['syafii'], 'src3'),
			ev('s4', 'qurban hukum madzhab lain jelas', ['hanafi'], 'src4'),
		]
		const sel = applyEvidencePolicy(ranked, capPolicy)
		expect(sel.selected.map((c) => c.unitId)).toEqual(['s1', 's2', 's4'])
		expect(sel.exclusions.find((e) => e.unitId === 's3')?.code).toBe(
			'MADHHAB_CAP',
		)
	})

	test('requested madhhab represented when available, even beyond the cut', () => {
		const ranked = [
			ev('k1', 'hukum qurban sapi', ['syafii'], 'src1'),
			ev('k2', 'hukum qurban kambing', ['syafii'], 'src2'),
			ev('h1', 'qurban menurut hanafi sah', ['hanafi'], 'src3'),
		]
		const tightPolicy: EvidencePolicy = { ...POLICY, topK: 2 }
		// hanafi sits at rank 3, beyond topK=2 — representation pulls it back
		const sel = applyEvidencePolicy(ranked, tightPolicy, ['hanafi'])
		expect(sel.selected.map((c) => c.unitId)).toEqual(['k1', 'k2', 'h1'])
		expect(sel.notes).toEqual([
			{ madhhab: 'hanafi', action: 'added_for_representation', unitId: 'h1' },
		])
		// its truncation exclusion is withdrawn, not double-recorded
		expect(sel.exclusions.find((e) => e.unitId === 'h1')).toBeUndefined()
	})

	test('requested madhhab unavailable in pool is recorded deterministically', () => {
		const ranked = [ev('k1', 'hukum qurban sapi', ['syafii'], 'src1')]
		const sel = applyEvidencePolicy(ranked, POLICY, ['hanafi'])
		expect(sel.notes).toEqual([{ madhhab: 'hanafi', action: 'unavailable' }])
		expect(
			sel.exclusions.find((e) => e.code === 'MADHHAB_UNAVAILABLE')?.detail,
		).toContain('hanafi')
	})

	test('policy is deterministic: identical inputs give identical outputs', () => {
		const ranked = [
			ev('a', 'teks satu tentang najis mughallazhah', ['syafii'], 'src1'),
			ev('b', 'teks dua tentang najis mutawassithah', ['hanafi'], 'src1'),
			ev('c', 'teks dua tentang najis mutawassithah lagi', ['hanafi'], 'src2'),
			ev('d', 'teks tiga istinja dengan air', ['maliki'], 'src3'),
		]
		const run1 = applyEvidencePolicy(ranked, POLICY, ['maliki'])
		const run2 = applyEvidencePolicy(ranked, POLICY, ['maliki'])
		expect(run1).toEqual(run2)
	})

	test('below-cut candidates are recorded as TOPK_TRUNCATED, never silent', () => {
		const topics = [
			'najis mughallazhah cara mensucikan',
			'istinja dengan batu bersih',
			'tayammum debu suci pengganti',
			'siwak menyegarkan mulut',
			'mandi wajib sebab junub',
			'bersiwak waktu berbuka puasa',
			'mengusap khuf batas waktu',
			'shalat tarawih jumlah rakaat',
			'witir doa qunut posisi',
			'idul fitri khutbah sunnah',
		]
		const ranked = topics.map((text, i) => ev(`t${i}`, text, [], `s${i}`))
		const sel = applyEvidencePolicy(ranked, { ...POLICY, topK: 3 })
		expect(sel.selected).toHaveLength(3)
		expect(
			sel.exclusions.filter((e) => e.code === 'TOPK_TRUNCATED'),
		).toHaveLength(7)
	})
})

// ---------------------------------------------------------------------------
// integration: selectEvidence over a compiled release
// ---------------------------------------------------------------------------

describe('EVD-002: selectEvidence over a compiled release', () => {
	beforeAll(ensureMigrations)

	test('loads unit madhhab/source metadata and selects with recorded exclusions', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`evd-t-${suffix}`}, 'EVD Tenant') returning id`
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`evd-${suffix}@test.local`}, 'EVD User') returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

		const [profile] = await sql<{ id: string }[]>`
			insert into normalization_profiles (key, version, ruleset)
			values (${`np-evd-${suffix}`}, 1, '{}') returning id`
		const modelId = `evd-emb-${suffix}`
		const [model] = await sql<{ id: string }[]>`
			insert into embedding_models (provider, model_id, version, dimensions)
			values ('local', ${modelId}, '1', 768) returning id`
		const [config] = await sql<{ id: string }[]>`
			insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
			values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-evd-${suffix}`}) returning id`

		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, 'Kitab Najis', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'evd-1', 'Air yang bercampur najis berubah rasa warna atau baunya.')`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'evd-2', 'Air yang bercampur najis berubah rasa warna atau baunya menjadi tidak suci.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Air Tercemar', 'Air tercemar najis hukumnya tidak suci.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`
		const [kRelease] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

		const principal: Principal = {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['review:publish', 'knowledge:read', 'config:manage'],
			scopes: [scope.id],
			actorType: 'user',
		}
		const compiled = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kRelease.id,
			configurationId: config.id,
		})
		// tag the two overlapping spans syafii for diversity assertions
		await sql`update retrieval_units set madhhab = '{syafii}'
			where index_release_id = ${compiled.indexReleaseId}::uuid and unit_kind = 'source_span'`
		await sql`update retrieval_units set madhhab = '{hanafi}'
			where index_release_id = ${compiled.indexReleaseId}::uuid and unit_kind = 'knowledge_concept'`

		await embedIndexRelease(
			sql,
			principal,
			compiled.indexReleaseId,
			new HashEmbeddingProvider(modelId, '1', 768),
		)

		// run the full pipeline with evidence selection requested
		const outcome = await executeLanePlan(sql, principal, {
			query: 'air bercampur najis berubah rasa',
			indexReleaseId: compiled.indexReleaseId,
			vectorProvider: new HashEmbeddingProvider(modelId, '1', 768),
			evidence: { requestedMadhhab: ['hanafi', 'hanbali'] },
		})
		expect(outcome.evidence).not.toBeNull()
		const sel = outcome.evidence
		// the two near-identical spans collapsed to one representative
		const spanUnits =
			sel?.selected.filter((c) => c.unitKind === 'source_span') ?? []
		expect(spanUnits.length).toBe(1)
		expect(
			sel?.exclusions.some((e) => e.code === 'OVERLAP_COLLAPSED'),
		).toBeTrue()
		// madhhab metadata loaded from the release
		expect(spanUnits.every((c) => c.madhhab.includes('syafii'))).toBeTrue()
		expect(spanUnits.every((c) => c.sourceKey === src.id)).toBeTrue()
		// the hanafi concept unit made the evidence set (representation is
		// satisfied in the first pass here — only 3 units exist); the
		// requested-but-absent hanbali is recorded as unavailable
		const conceptUnit =
			sel?.selected.find((c) => c.unitKind === 'knowledge_concept') ?? null
		expect(conceptUnit?.madhhab).toContain('hanafi')
		expect(conceptUnit?.sourceKey).toBe(`rev:${krev.id}`)
		expect(sel?.notes).toEqual([{ madhhab: 'hanbali', action: 'unavailable' }])
	})

	test('candidates with unloadable metadata are excluded, never enriched by guess', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`evd2-t-${suffix}`}, 'EVD2 Tenant') returning id`
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const principal: Principal = {
			userId: crypto.randomUUID(),
			tenantId: tenant.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [scope.id],
			actorType: 'user',
		}
		const phantom: RetrievalCandidate[] = [
			{
				unitId: crypto.randomUUID(),
				logicalUnitId: 'span:phantom',
				unitKind: 'source_span',
				sourceSpanId: null,
				knowledgeRevisionId: null,
				originalText: 'tidak ada unit seperti ini',
				score: 1,
				matchMetadata: {},
			},
		]
		const sel = await selectEvidence(
			sql,
			principal,
			crypto.randomUUID(),
			phantom,
		)
		expect(sel.selected).toEqual([])
		expect(sel.exclusions).toEqual([
			{
				unitId: phantom[0].unitId,
				code: 'TOPK_TRUNCATED',
				detail: 'unit metadata not found under this release/tenant',
			},
		])
	})
})
