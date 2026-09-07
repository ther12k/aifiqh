import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { INDEX_COMPILER_VERSION } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const fakeOidc = {
	clientId: 'aifiqh-api',
	discovery: async () => ({
		issuer: 'http://localhost:4011',
		authorization_endpoint: 'http://localhost:4011/auth',
		token_endpoint: 'http://localhost:4011/token',
		jwks_uri: 'http://localhost:4011/jwks',
	}),
	verifyIdToken: async () => {
		throw new Error('not used')
	},
}
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-idx2',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
	configId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`ix2-t-${suffix}`}, 'Identity Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${roleKey}) returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
		return user.id
	}
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np2-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb2-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values (${INDEX_COMPILER_VERSION}, ${profile.id}::uuid, ${model.id}::uuid, ${`cfg2-${suffix}`}) returning id`
	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: await mk('editor'),
		reviewerId: await mk('reviewer'),
		configId: config.id,
	}
	return fixtures
}

async function authHeaders(userId: string, tenantId: string, withCsrf = false) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

interface Corpus {
	scopeId: string
	kReleaseId: string
	conceptId: string
	conceptRevId: string
	spanIds: string[]
	sectionId: string
	anchorSpanId: string
	noteSpanId: string
}

/**
 * Corpus: source with 2 adjacent spans in a section + a footnote pair, and a
 * published knowledge release with one concept that links evidence + an
 * exception link to another concept in the same release.
 */
async function makeCorpus(): Promise<Corpus> {
	const { tenantId, scopeId, editorId, reviewerId } = await setupFixtures()
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Rel', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	const [section] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, heading)
		values (${rev.id}::uuid, 1, 'Bab Nikah') returning id`
	const mkSpan = async (key: string, text: string) => {
		const [s] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, section_id, span_key, original_text)
			values (${rev.id}::uuid, ${section.id}::uuid, ${key}, ${text}) returning id`
		return s.id
	}
	const span1 = await mkSpan(
		`a1-${crypto.randomUUID().slice(0, 6)}`,
		'Syarat sah nikah pertama.',
	)
	const span2 = await mkSpan(
		`a2-${crypto.randomUUID().slice(0, 6)}`,
		'Syarat sah nikah kedua.',
	)
	// footnote pair (separate section-less spans)
	const anchor = await mkSpan(
		`an-${crypto.randomUUID().slice(0, 6)}`,
		'Lihat catatan kaki satu.',
	)
	const note = await mkSpan(
		`nt-${crypto.randomUUID().slice(0, 6)}`,
		'1. Yaitu kehadiran wali.',
	)
	await sql`insert into source_footnotes (source_revision_id, marker, anchor_span_id, note_span_id)
		values (${rev.id}::uuid, '1', ${anchor}::uuid, ${note}::uuid)`

	// concepts: rule + exception, both pinned in the release; rule links
	// evidence (span1) and an exception_to link to the exception concept
	const [ruleConcept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'rule', ${scopeId}::uuid) returning id`
	const [ruleRev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${ruleConcept.id}::uuid, 1, 'Kaidah wali', 'Nikah tanpa wali tidak sah.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [excConcept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'exception', ${scopeId}::uuid) returning id`
	const [excRev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${excConcept.id}::uuid, 1, 'Pengecualian', 'Kecuali dalam kondisi darurat.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`

	await sql`insert into concept_source_spans (revision_id, source_span_id, source_revision_id, quotation_text)
		values (${ruleRev.id}::uuid, ${span1}::uuid, ${rev.id}::uuid, 'Syarat sah nikah pertama.')`
	await sql`insert into knowledge_links (from_revision_id, to_concept_id, relationship_type, created_by)
		values (${ruleRev.id}::uuid, ${excConcept.id}::uuid, 'exception_to', ${editorId}::uuid)`
	// a BROKEN link: target concept not in the release
	const [orphanConcept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	await sql`insert into knowledge_links (from_revision_id, to_concept_id, relationship_type, created_by)
		values (${ruleRev.id}::uuid, ${orphanConcept.id}::uuid, 'supports', ${editorId}::uuid)`

	const [changeset] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, 'CS ix2', ${editorId}::uuid) returning id`
	await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
		values (${changeset.id}::uuid, ${ruleConcept.id}::uuid, ${ruleRev.id}::uuid),
		       (${changeset.id}::uuid, ${excConcept.id}::uuid, ${excRev.id}::uuid)`
	await sql`update knowledge_changesets set state = 'submitted', submitted_at = now() where id = ${changeset.id}::uuid`
	await sql`update knowledge_changesets set state = 'approved' where id = ${changeset.id}::uuid`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${ruleConcept.id}::uuid, ${ruleRev.id}::uuid),
		       (${kRelease.id}::uuid, ${excConcept.id}::uuid, ${excRev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	return {
		scopeId: scopeId,
		kReleaseId: kRelease.id,
		conceptId: ruleConcept.id,
		conceptRevId: ruleRev.id,
		spanIds: [span1, span2],
		sectionId: section.id,
		anchorSpanId: anchor,
		noteSpanId: note,
	}
}

async function compile(auth: Record<string, string>, corpus: Corpus) {
	const res = await testApp.handle(
		new Request('http://localhost/index/compile', {
			method: 'POST',
			headers: { ...auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				knowledgeReleaseId: corpus.kReleaseId,
				configurationId: fixtures.configId,
			}),
		}),
	)
	expect(res.status).toBe(200)
	return (await res.json()) as {
		indexReleaseId: string
		manifestHash: string
		sourceUnits: number
		knowledgeUnits: number
	}
}

describe('relationship-index projection (IDX-005)', () => {
	beforeAll(ensureMigrations)

	test('compiles adjacent, footnote, evidence, and typed concept edges; broken links dropped', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const corpus = await makeCorpus()
		const result = await compile(auth, corpus)

		const edges = await sql<
			{
				from_logical_unit_id: string
				to_logical_unit_id: string
				relationship_type: string
				direction: string
				weight: string
			}[]
		>`select from_logical_unit_id, to_logical_unit_id, relationship_type, direction, weight::text
			from retrieval_relationships
			where index_release_id = ${result.indexReleaseId}::uuid
			order by relationship_type, from_logical_unit_id`

		// all edges pin this release and link units that exist in it
		const unitIds = new Set(
			(
				await sql<{ logical_unit_id: string }[]>`
					select logical_unit_id from retrieval_units
					where index_release_id = ${result.indexReleaseId}::uuid`
			).map((u) => u.logical_unit_id),
		)
		for (const e of edges) {
			expect(unitIds.has(e.from_logical_unit_id)).toBeTrue()
			expect(unitIds.has(e.to_logical_unit_id)).toBeTrue()
		}

		const byType = (t: string) => edges.filter((e) => e.relationship_type === t)

		// adjacency: span1→span2 within the section (undirected, weight 0.8)
		const adjacent = byType('adjacent')
		expect(adjacent.length).toBeGreaterThanOrEqual(1)
		expect(adjacent[0].direction).toBe('undirected')

		// footnote: anchor → note
		expect(byType('footnote')).toHaveLength(1)
		expect(byType('footnote')[0].from_logical_unit_id).toBe(
			`source_span:${corpus.anchorSpanId}`,
		)
		expect(byType('footnote')[0].to_logical_unit_id).toBe(
			`source_span:${corpus.noteSpanId}`,
		)

		// evidence: knowledge unit → pinned span
		const evidence = byType('evidence')
		expect(evidence).toHaveLength(1)
		expect(evidence[0].from_logical_unit_id).toBe(
			`knowledge_concept:${corpus.conceptRevId}`,
		)
		expect(evidence[0].to_logical_unit_id).toBe(
			`source_span:${corpus.spanIds[0]}`,
		)

		// typed concept link (exception_to → exception) compiled…
		const exception = byType('exception')
		expect(exception).toHaveLength(1)
		// …while the BROKEN link (target concept not in the release) is absent
		expect(byType('definition')).toHaveLength(0)
	})
})

describe('stable retrieval-unit identity and structural lineage (IDX-002)', () => {
	beforeAll(ensureMigrations)

	test('unchanged units retain id+hash; changed text bumps hash; deletions tombstone', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const corpus = await makeCorpus()

		// a second source whose revision gets deprecated between compiles
		const [depSrc] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Kitab Dideprekasi', 'x', 'book', 'ar', 'public_domain', ${corpus.scopeId}::uuid)
			returning id`
		const [depRev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${depSrc.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, depRev.id)
		const [depSpan] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${depRev.id}::uuid, ${`dp-${crypto.randomUUID().slice(0, 6)}`}, 'Teks yang akan hilang.') returning id`

		const first = await compile(auth, corpus)

		// deprecate the second source's revision: its spans stop compiling
		await sql`update source_revisions set status = 'deprecated', deprecation_reason = 'ganti cetakan'
			where id = ${depRev.id}::uuid`

		const second = await compile(auth, corpus)

		// simulate a normalization-profile bump: same span, same logical id,
		// recompiled content hash (retrieval_units carries the compiled hash)
		await sql`update retrieval_units
			set content_hash = ${crypto.randomUUID().replaceAll('-', '').slice(0, 64)}
			where index_release_id = ${second.indexReleaseId}::uuid
				and logical_unit_id = ${`source_span:${corpus.spanIds[0]}`}`

		const cmpRes = await testApp.handle(
			new Request(
				`http://localhost/index/releases/${first.indexReleaseId}/compare/${second.indexReleaseId}`,
				{ headers: auth },
			),
		)
		expect(cmpRes.status).toBe(200)
		const cmp = await cmpRes.json()

		// unchanged units retain their identity: footnote pair, knowledge units…
		expect(cmp.unchanged).toContain(`source_span:${corpus.anchorSpanId}`)
		expect(cmp.unchanged).toContain(`knowledge_concept:${corpus.conceptRevId}`)

		// changed text: same logical id, different hash
		const changedSpan = cmp.changed.find(
			(c: { logicalUnitId: string; reason: string }) =>
				c.logicalUnitId === `source_span:${corpus.spanIds[0]}`,
		)
		expect(changedSpan).toBeDefined()
		expect(changedSpan.reason).toBe('content')
		expect(changedSpan.previousHash).not.toBe(changedSpan.nextHash)

		// the deprecated revision's span is tombstoned
		expect(cmp.tombstoned).toContain(`source_span:${depSpan.id}`)
		// still-compiled spans are NOT tombstoned
		expect(cmp.tombstoned).not.toContain(`source_span:${corpus.spanIds[1]}`)

		// new manifest differs
		expect(first.manifestHash).not.toBe(second.manifestHash)

		// comparison audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_id = ${second.indexReleaseId} and action = 'index.compared'`
		expect(audits).toHaveLength(1)
	})

	test('moved section keeps the unit id but reports a parent-lineage change', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const corpus = await makeCorpus()

		const first = await compile(auth, corpus)

		// move the anchor span to a NEW section (text unchanged)
		const [rev] = await sql<{ id: string }[]>`
			select source_revision_id as id from source_spans where id = ${corpus.anchorSpanId}::uuid`
		const [newSection] = await sql<{ id: string }[]>`
			insert into source_sections (source_revision_id, ordinal, heading)
			values (${rev.id}::uuid, 2, 'Bab Pindahan') returning id`
		await sql`update source_spans set section_id = ${newSection.id}::uuid
			where id = ${corpus.anchorSpanId}::uuid`

		const second = await compile(auth, corpus)
		const cmpRes = await testApp.handle(
			new Request(
				`http://localhost/index/releases/${first.indexReleaseId}/compare/${second.indexReleaseId}`,
				{ headers: auth },
			),
		)
		const cmp = await cmpRes.json()

		const moved = cmp.changed.find(
			(c: { logicalUnitId: string }) =>
				c.logicalUnitId === `source_span:${corpus.anchorSpanId}`,
		)
		expect(moved).toBeDefined()
		expect(moved.reason).toBe('parent')
		// content unchanged → same hash despite the move
		expect(moved.previousHash).toBe(moved.nextHash)
	})
})
