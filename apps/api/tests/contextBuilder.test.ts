import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	CONTEXT_BUILDER_VERSION,
	CONTEXT_PROFILES,
	buildContext,
	storeContextManifest,
} from '../src/retrieval/contextBuilder'
import type { ExpansionOutcome } from '../src/retrieval/evidenceExpansion'
import { applyEvidencePolicy } from '../src/retrieval/evidenceSelector'
import type { EvidenceCandidate } from '../src/retrieval/evidenceSelector'
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
	SESSION_SECRET: 'test-secret-ctx',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

function ev(
	unitId: string,
	text: string,
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
		madhhab: [],
		sourceKey,
	}
}

function expansionOf(
	items: Array<{
		unitId: string
		logicalUnitId: string
		text: string
		relation: string
	}>,
): ExpansionOutcome {
	return {
		items: items.map((i) => ({
			unitId: i.unitId,
			logicalUnitId: i.logicalUnitId,
			unitKind: 'source_span',
			originalText: i.text,
			relation: i.relation,
			via: 'span:seed',
			reason: `${i.relation} context for span:seed`,
			tokenEstimate: Math.ceil(i.text.length / 4),
			depth: 1,
		})),
		skipped: [],
		policy: {
			relations: ['adjacent', 'footnote', 'evidence'],
			maxDepth: 2,
			maxPerSeed: 3,
			maxItems: 12,
		},
		version: 'evidence-expansion-v1',
	}
}

describe('CTX-001: adaptive context profiles (pure)', () => {
	beforeAll(ensureMigrations)

	test('default profile is standard — never the max budget', () => {
		expect(CONTEXT_PROFILES.standard.tokenBudget).toBeLessThan(
			CONTEXT_PROFILES.research.tokenBudget,
		)
		expect(CONTEXT_PROFILES.research.tokenBudget).toBeLessThan(
			CONTEXT_PROFILES.document_audit.tokenBudget,
		)
		expect(CONTEXT_PROFILES.exact.tokenBudget).toBeLessThan(
			CONTEXT_PROFILES.standard.tokenBudget,
		)
		// exact profile refuses expansion entirely
		expect(CONTEXT_PROFILES.exact.includeExpansion).toBeFalse()
	})

	test('items ordered with ordinals implied, every item has reason + token estimate', () => {
		const evidence = applyEvidencePolicy([
			ev('p1', 'pendapat pertama tentang qurban'.padEnd(80, 'x'), 's1'),
			ev('p2', 'pendapat kedua dari sumber lain'.padEnd(80, 'y'), 's2'),
		])
		const expansion = expansionOf([
			{
				unitId: 'e1',
				logicalUnitId: 'span:e1',
				text: 'teks adjacent'.padEnd(40, 'z'),
				relation: 'adjacent',
			},
		])
		const ctx = buildContext(CONTEXT_PROFILES.standard, evidence, expansion)
		expect(ctx.items.map((i) => i.unitId)).toEqual(['p1', 'p2', 'e1'])
		expect(ctx.items[0].relation).toBe('primary')
		expect(ctx.items[0].selectionReason).toBe('selected evidence rank 1')
		expect(ctx.items[2].relation).toBe('adjacent')
		for (const item of ctx.items) {
			expect(item.selectionReason).toBeTruthy()
			expect(item.tokenEstimate).toBeGreaterThan(0)
		}
		expect(ctx.tokenTotal).toBe(
			ctx.items.reduce((sum, i) => sum + i.tokenEstimate, 0),
		)
		expect(ctx.version).toBe(CONTEXT_BUILDER_VERSION)
		expect(ctx.manifestHash).toMatch(/^[a-f0-9]{64}$/)
	})

	test('over-budget drops unprotected expansion items whole, last first', () => {
		const evidence = applyEvidencePolicy([
			ev('p1', 'primary evidence text'.padEnd(200, 'a'), 's1'),
		])
		const expansion = expansionOf([
			{
				unitId: 'e1',
				logicalUnitId: 'span:e1',
				text: 'adjacent satu'.padEnd(100, 'b'),
				relation: 'adjacent',
			},
			{
				unitId: 'e2',
				logicalUnitId: 'span:e2',
				text: 'adjacent dua'.padEnd(100, 'c'),
				relation: 'adjacent',
			},
		])
		const tight = { ...CONTEXT_PROFILES.standard, tokenBudget: 80 }
		const ctx = buildContext(tight, evidence, expansion)
		// primaries survive; late unprotected expansions dropped whole
		expect(ctx.items.find((i) => i.unitId === 'p1')?.included).toBeTrue()
		expect(ctx.items.find((i) => i.unitId === 'e2')?.included).toBeFalse()
		expect(ctx.items.find((i) => i.unitId === 'e2')?.truncationNote).toContain(
			'dropped whole',
		)
		expect(ctx.downgraded).toBeFalse()
	})

	test('conditions/exceptions are protected from truncation — no orphan cuts', () => {
		const evidence = applyEvidencePolicy([
			ev('p1', 'hukum asal qurban'.padEnd(200, 'a'), 's1'),
		])
		const expansion = expansionOf([
			// a huge unprotected neighbor and a small protected exception
			{
				unitId: 'big',
				logicalUnitId: 'span:big',
				text: 'adjacent panjang'.padEnd(400, 'b'),
				relation: 'adjacent',
			},
			{
				unitId: 'exc',
				logicalUnitId: 'span:exc',
				text: 'kecuali bagi musafir'.padEnd(40, 'c'),
				relation: 'exception',
			},
		])
		const tight = { ...CONTEXT_PROFILES.standard, tokenBudget: 120 }
		const ctx = buildContext(tight, evidence, expansion)
		const exc = ctx.items.find((i) => i.unitId === 'exc')
		expect(exc?.protectedItem).toBeTrue()
		// the exception survives; the big unprotected neighbor is dropped
		expect(exc?.included).toBeTrue()
		expect(ctx.items.find((i) => i.unitId === 'big')?.included).toBeFalse()
	})

	test('protected + primary overflow downgrades safely instead of shredding', () => {
		const evidence = applyEvidencePolicy([
			ev('p1', 'primary evidence'.padEnd(600, 'a'), 's1'),
		])
		const expansion = expansionOf([
			{
				unitId: 'exc',
				logicalUnitId: 'span:exc',
				text: 'kecuali'.padEnd(60, 'c'),
				relation: 'exception',
			},
		])
		const tiny = {
			...CONTEXT_PROFILES.exact,
			tokenBudget: 10,
			includeExpansion: true,
		}
		const ctx = buildContext(tiny, evidence, expansion)
		// nothing was cut mid-flight; overflow surfaced as a downgrade
		expect(ctx.downgraded).toBeTrue()
		for (const item of ctx.items) {
			expect(item.included).toBeTrue()
			expect(item.truncationNote).toBeNull()
		}
		expect(ctx.tokenTotal).toBeGreaterThan(ctx.tokenBudget)
	})

	test('build is deterministic', () => {
		const evidence = applyEvidencePolicy([
			ev('p1', 'teks primary'.padEnd(100, 'a'), 's1'),
		])
		const expansion = expansionOf([
			{
				unitId: 'e1',
				logicalUnitId: 'span:e1',
				text: 'tetangga'.padEnd(50, 'b'),
				relation: 'adjacent',
			},
		])
		const a = buildContext(CONTEXT_PROFILES.standard, evidence, expansion)
		const b = buildContext(CONTEXT_PROFILES.standard, evidence, expansion)
		expect(a).toEqual(b)
	})
})

describe('CTX-001: immutable manifest storage + route', () => {
	beforeAll(ensureMigrations)

	test('manifest stored with items/order/token estimates; replay keeps the original', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`ctx-t-${suffix}`}, 'Ctx Tenant') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`ctx-${suffix}@test.local`}, 'Ctx User') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant.id}::uuid, ${user.id}::uuid, 'konteks', 'running') returning id`

		// context_manifest_items.unit_id references real retrieval units
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const [kRel] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'published', ${user.id}::uuid)
			returning id`
		const [release] = await sql<{ id: string }[]>`
			insert into index_releases (tenant_id, knowledge_release_id, configuration_id, state, manifest_hash)
			select ${tenant.id}::uuid, ${kRel.id}::uuid, ic.id, 'ready', ${crypto.randomUUID()}
			from index_configurations ic limit 1
			returning id`
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, 'Kitab Ctx', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
			returning id`
		const [srcRev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, srcRev.id)
		const mkUnit = async () => {
			const id = crypto.randomUUID()
			const [span] = await sql<{ id: string }[]>`
				insert into source_spans (source_revision_id, span_key, original_text)
				values (${srcRev.id}::uuid, ${`ctx-${id}`}, 'teks unit') returning id`
			await sql`insert into retrieval_units (
					id, index_release_id, logical_unit_id, unit_kind, source_span_id,
					tenant_id, access_scope_id, original_text, language,
					topic_path, madhhab, content_hash, compiler_version
				) values (
					${id}::uuid, ${release.id}::uuid, ${`span:${id}`}, 'source_span', ${span.id}::uuid,
					${tenant.id}::uuid, ${scope.id}::uuid, 'teks unit', 'id',
					'{}', '{}', ${crypto.randomUUID()}, 'test'
				)`
			return id
		}
		const p1 = await mkUnit()
		const p2 = await mkUnit()
		const e1 = await mkUnit()
		const evidence = applyEvidencePolicy([
			ev(p1, 'primary satu'.padEnd(100, 'a'), 's1'),
			ev(p2, 'primary dua beda sumber'.padEnd(100, 'b'), 's2'),
		])
		const expansion = expansionOf([
			{
				unitId: e1,
				logicalUnitId: `span:${e1}`,
				text: 'tetangga'.padEnd(50, 'c'),
				relation: 'adjacent',
			},
		])
		const ctx = buildContext(CONTEXT_PROFILES.standard, evidence, expansion)
		const stored = await storeContextManifest(sql, trace.id, ctx)
		expect(stored.replayed).toBeFalse()
		expect(stored.itemCount).toBe(3)
		expect(stored.manifestHash).toBe(ctx.manifestHash)

		// items stored in order with estimates
		const items = await sql<
			{
				ordinal: number
				relation: string
				token_estimate: number
				selection_reason: string
			}[]
		>`select ordinal, relation, token_estimate, selection_reason
			from context_manifest_items where manifest_id = ${stored.manifestId}::uuid
			order by ordinal`
		expect(items.map((i) => i.relation)).toEqual([
			'primary',
			'primary',
			'adjacent',
		])
		expect(items.every((i) => i.token_estimate > 0)).toBeTrue()

		// replay with a DIFFERENT build: the first manifest is final
		const otherCtx = buildContext(CONTEXT_PROFILES.research, evidence, null)
		const replay = await storeContextManifest(sql, trace.id, otherCtx)
		expect(replay.replayed).toBeTrue()
		expect(replay.manifestHash).toBe(ctx.manifestHash)
		expect(replay.profile).toBe('standard')
		const count = await sql<{ n: string }[]>`
			select count(*) as n from context_manifests where trace_id = ${trace.id}::uuid`
		expect(Number(count[0].n)).toBe(1)
	})

	test('POST /retrieval/search builds and stores the context manifest', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`ctx2-t-${suffix}`}, 'Ctx2 Tenant') returning id`
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`ctx2-${suffix}@test.local`}, 'Ctx2 User') returning id`
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
			values (${`np-ctx-${suffix}`}, 1, '{}') returning id`
		const [model] = await sql<{ id: string }[]>`
			insert into embedding_models (provider, model_id, version, dimensions)
			values ('local', ${`ctx-emb-${suffix}`}, '1', 768) returning id`
		const [config] = await sql<{ id: string }[]>`
			insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
			values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-ctx-${suffix}`}) returning id`

		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, 'Kitab Zakat', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, rev.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'ctx-1', 'Zakat fitrah wajib berupa makanan pokok setiap jiwa.')`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'ctx-2', 'Ukuran zakat fitrah satu sha kurang lebih dua setengah kilogram.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Zakat Fitrah', 'Zakat fitrah wajib berupa makanan pokok setiap jiwa.', 'id',
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

		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: user.id,
			tenantId: tenant.id,
			issuer: 'http://localhost:4011',
			subject: `sub-${user.id}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: user.id,
				tenantId: tenant.id,
				issuer: 'http://localhost:4011',
				subject: `sub-${user.id}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrfToken = newCsrfToken(cfg.sessionSecret)

		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: {
					cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
					'x-csrf-token': csrfToken,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					query: 'zakat fitrah makanan pokok',
					indexReleaseId: compiled.indexReleaseId,
					contextProfile: 'standard',
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.context.profile).toBe('standard')
		expect(body.context.tokenBudget).toBe(CONTEXT_PROFILES.standard.tokenBudget)
		expect(body.context.items.length).toBeGreaterThanOrEqual(1)
		expect(body.contextManifest.itemCount).toBe(body.context.items.length)
		expect(body.contextManifest.replayed).toBeFalse()

		const stored = await sql<{ token_total: number; profile: string }[]>`
			select token_total, profile from context_manifests
			where trace_id = ${body.traceId}::uuid`
		expect(stored).toHaveLength(1)
		expect(stored[0].profile).toBe('standard')
		expect(stored[0].token_total).toBe(body.context.tokenTotal)
	})
})
