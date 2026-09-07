/**
 * OKF v0.2 adapter (#115): export approved revisions as a bundle, import a
 * bundle as a PROPOSED pending_review revision. Round-trip fidelity
 * (byte-identical spans, QUOTE_MISMATCH-compatible), role separation
 * (operational/editorial never become evidence), and trust frontmatter
 * never bypasses the #108 approval gate.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { compileIndexRelease } from '../src/index/indexCompiler'
import {
	OKF_PASSAGE_TYPE,
	exportSourceRevisionToOkf,
	importOkfBundle,
	parseBundle,
	parseYamlSubset,
	quoteMatchesStoredSpan,
} from '../src/sources/okfAdapter'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const PASSAGE_TEXT =
	'Dibeingeratan bagi setiap muslim yang telah sampai padanya izab, yaitu mandi.'
let tenantId = ''
let scopeId = ''
let adminUserId = ''
let principal: Principal
let sourceId = ''
let configurationId = ''
let knowledgeReleaseId = ''

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`okf-t-${suffix}`}, 'OKF Tenant')
		returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`okf-${suffix}@test.local`}, 'okf') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: [
			'source:read',
			'knowledge:read',
			'review:approve',
			'review:publish',
		],
		scopes: [scopeId],
		actorType: 'user',
	}

	// an approved revision with attributed hadith-graded passage
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id, created_by,
			acquisition_method, policy_reference, parser_version)
		values (${tenantId}::uuid, 'Shahih Muslim (Indonesian)', 'Imam Muslim', 'book', 'ar', 'public_domain', ${scope.id}::uuid, ${user.id}::uuid,
			'bulk_file', 'https://example.org/terms', 'okf-test')
		returning id`
	sourceId = src.id
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status, created_by)
		values (${src.id}::uuid, 1, 'pending_review', ${user.id}::uuid) returning id`
	await approveTestRevision(sql, rev.id)
	await sql`
		insert into source_spans (source_revision_id, span_key, original_text, madhhab, stance, grading, grading_by)
		values (${rev.id}::uuid, 'hadith-17', ${PASSAGE_TEXT}, array['syafii'], 'asserts',
			'sahih', 'Imam An-Nawawi')`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-okf-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-okf-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-okf-${suffix}`})
		returning id`
	configurationId = config.id

	// published knowledge release so compileIndexRelease can run
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'OKF', 'isi', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
		returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	knowledgeReleaseId = kRelease.id
})

describe('OKF frontmatter parser (v0.2 subset)', () => {
	test('scalars, inline lists, block maps, and lists of maps parse', () => {
		const fm = parseYamlSubset(
			[
				'type: fiqh-source-passage',
				'title: "Kitab § span-1"',
				'tags: [fiqh, source-passage]',
				'verified:',
				'  by: human:reviewer-1',
				'  at: 2026-09-07T00:00:00+00:00',
				'sources:',
				'  - id: span-1',
				'    resource: "https://example.org/t"',
				'    usage_count: 3',
			].join('\n'),
		)
		expect(fm.type).toBe(OKF_PASSAGE_TYPE)
		expect(fm.title).toBe('Kitab § span-1')
		expect(fm.verified).toEqual({
			by: 'human:reviewer-1',
			at: '2026-09-07T00:00:00+00:00',
		})
		const sources = fm.sources as Array<Record<string, unknown>>
		expect(sources[0].resource).toBe('https://example.org/t')
		expect(sources[0].usage_count).toBe(3)
	})
})

describe('OKF export → import round trip (#115)', () => {
	test('export carries only approved spans with provenance frontmatter', async () => {
		const bundle = await exportSourceRevisionToOkf(sql, principal, sourceId)
		expect(bundle.okfVersion).toBe('0.2')
		expect(Object.keys(bundle.files)).toContain('index.md')
		const doc = bundle.files['spans/1-hadith-17.md']
		expect(doc).toContain(`type: ${OKF_PASSAGE_TYPE}`)
		expect(doc).toContain('x-aifiqh:')
		expect(doc).toContain('grading: "sahih"')
		expect(doc).toContain('stance: asserts')
		// the body is the passage verbatim
		expect(doc).toContain(PASSAGE_TEXT)
	})

	test('importing the bundle reproduces spans byte-identically, pending_review', async () => {
		const bundle = await exportSourceRevisionToOkf(sql, principal, sourceId)
		const outcome = await importOkfBundle(sql, principal, {
			bundle: bundle.files,
			source: {
				title: 'Shahih Muslim (Indonesian) — re-import',
				author: 'Imam Muslim',
				language: 'ar',
				rightsStatus: 'public_domain',
			},
			provider: { name: 'okf-roundtrip' },
			accessScopeId: scopeId,
		})
		if (!outcome.ok) console.log('IMPORT FAILURES', outcome.failures)
		expect(outcome.ok).toBeTrue()
		expect(outcome.revisionStatus).toBe('pending_review')
		expect(outcome.spansImported).toBe(1)

		// BYTE-IDENTICAL body → the QUOTE_MISMATCH gate would pass
		const [span] = await sql<{ original_text: string }[]>`
			select ss.original_text from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			where sr.id = ${outcome.revisionId}::uuid`
		expect(span.original_text).toBe(PASSAGE_TEXT)
		expect(quoteMatchesStoredSpan(PASSAGE_TEXT, span.original_text)).toBeTrue()

		// provenance: the re-imported source records the adapter
		const [src] = await sql<{ parser_version: string | null }[]>`
			select parser_version from sources where id = ${outcome.sourceId}::uuid`
		expect(src.parser_version).toBe('okf-adapter-v1')
	})

	test('trust frontmatter never bypasses the gate — unapproved stays unindexed', async () => {
		const bundle = await exportSourceRevisionToOkf(sql, principal, sourceId)
		// an "authoritative" looking bundle claims human verification
		const doc = bundle.files['spans/1-hadith-17.md'].replace(
			'generated:',
			'verified:\n  by: human:someone\n  at: 2026-09-07T00:00:00+00:00\nstatus: stable\ngenerated:',
		)
		const outcome = await importOkfBundle(sql, principal, {
			bundle: { ...bundle.files, 'spans/1-hadith-17.md': doc },
			source: {
				title: 'Self-Verified Claim Bundle',
				author: 'x',
				language: 'ar',
				rightsStatus: 'unknown',
			},
			provider: { name: 'okf-unapproved' },
			accessScopeId: scopeId,
		})
		expect(outcome.ok).toBeTrue()
		expect(outcome.revisionStatus).toBe('pending_review')

		// the gate holds: the newly-imported bundle added ZERO retrieval units
		// (the 1 compiled unit is the fixture's pre-existing approved span)
		const compiled = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId,
			configurationId,
		})
		expect(compiled.sourceUnits).toBe(1)
		const [compiledSpan] = await sql<{ span_key: string }[]>`
			select ss.span_key from retrieval_units ru
			join source_spans ss on ss.id = ru.source_span_id
			where ru.index_release_id = ${compiled.indexReleaseId}::uuid`
		expect(compiledSpan.span_key).toBe('hadith-17') // the fixture's, not the bundle's
	}, 30_000)

	test('operational and editorial docs never become evidence', async () => {
		const outcome = await importOkfBundle(sql, principal, {
			bundle: {
				'index.md': '# Bundle\n',
				'log.md': '# Log\n\n## 2026-09-07\n\n**Import attempt.**\n',
				'notes/glossary.md':
					'---\ntype: editorial-glossary\n---\n\nIstilah fiqih.\n',
				'spans/1-x.md': `---\ntype: ${OKF_PASSAGE_TYPE}\n---\n\nTeks dalil uji.\n`,
			},
			source: {
				title: 'Role Separation Bundle',
				author: 'x',
				language: 'id',
				rightsStatus: 'public_domain',
			},
			provider: { name: 'okf-roles' },
			accessScopeId: scopeId,
		})
		expect(outcome.ok).toBeTrue()
		expect(outcome.operationalSkipped).toBe(2)
		expect(outcome.editorialSkipped).toBe(1)
		expect(outcome.spansImported).toBe(1)
		const spans = await sql<{ span_key: string }[]>`
			select span_key from source_spans
			where source_revision_id = ${outcome.revisionId}::uuid`
		expect(spans.map((s) => s.span_key)).toEqual(['1-x'])
	})

	test('a concept without frontmatter type fails conformance and imports nothing', async () => {
		const outcome = await importOkfBundle(sql, principal, {
			bundle: {
				'broken.md': '# no frontmatter, just prose\n',
				'spans/1-y.md': `---\ntype: ${OKF_PASSAGE_TYPE}\n---\n\nTeks sah.\n`,
			},
			source: {
				title: 'Broken Conformance Bundle',
				author: 'x',
				language: 'id',
				rightsStatus: 'unknown',
			},
			provider: { name: 'okf-broken' },
			accessScopeId: scopeId,
		})
		// the valid passage still imports; the broken doc is reported
		expect(outcome.spansImported).toBe(1)
		expect(outcome.failures.some((f) => f.path === 'broken.md')).toBeTrue()
	})
})
