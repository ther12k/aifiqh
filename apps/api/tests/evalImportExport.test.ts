import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	type ExportedCase,
	type ExportedSetVersion,
	SEED_CATEGORIES,
	SEED_METRIC_MAP,
	diffSetVersions,
	exportSetVersion,
	exportSetVersionCsv,
	importCases,
	parseCsvRows,
	parseExportedCasesCsv,
	seedLaunchSuite,
	seedSetVersion,
} from '../src/eval/evalImportExport'
import {
	type EvalSetError,
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
	getSetVersion,
	publishSetVersion,
} from '../src/eval/evalSetService'
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
	SESSION_SECRET: 'test-secret-evalio',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let editorPrincipal: Principal
let reviewerPrincipal: Principal
let editorUserId: string
let reviewerUserId: string
let sourceRevisionId: string
let spanId: string

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`evalio-t-${suffix}`}, 'EvalIO Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`

	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`evalio-${roleKey}-${crypto.randomUUID().slice(0, 8)}@test.local`}, ${roleKey})
			returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenantId}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id)
			values (${mem.id}::uuid, ${role.id}::uuid)`
		return user.id
	}
	editorUserId = await mk('editor')
	reviewerUserId = await mk('reviewer')
	editorPrincipal = {
		userId: editorUserId,
		tenantId,
		roles: ['editor'],
		permissions: ['knowledge:read', 'knowledge:draft'],
		scopes: [scope.id],
		actorType: 'user',
	}
	reviewerPrincipal = {
		userId: reviewerUserId,
		tenantId,
		roles: ['reviewer'],
		permissions: ['knowledge:read', 'review:publish'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'EvalIO Kitab', 'x', 'book', 'ar', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	sourceRevisionId = rev.id
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'evalio-1', 'Air musta''mal dalam kitab ini.')
		returning id`
	spanId = span.id
})

async function makeSet(): Promise<{ setId: string }> {
	const set = await createEvaluationSet(sql, editorPrincipal, {
		key: `evalio-${crypto.randomUUID().slice(0, 8)}`,
	})
	return { setId: set.setId }
}

function sampleCases(): ExportedCase[] {
	return [
		{
			caseKey: 'import-exact',
			category: 'exact_lookup',
			queryText: 'Definisi air musta\u2019mal',
			language: 'id',
			riskLevel: 'normal',
			conversation: null,
			expectedBehavior: { expectedUnit: 'span:evalio-1' },
			ownerUserId: editorUserId,
			reviewerUserId,
			expectedEvidence: [{ sourceRevisionId, spanId, mustInclude: true }],
		},
		{
			caseKey: 'import-sensitive',
			category: 'sensitive',
			queryText: 'Dosis obat bayi',
			language: 'id',
			riskLevel: 'sensitive',
			conversation: { priorTurns: 1 },
			expectedBehavior: { expectedDecision: 'escalate' },
			ownerUserId: editorUserId,
			reviewerUserId: null,
			expectedEvidence: [],
		},
	]
}

describe('EVAL-002: import/export, diff and seed suite', () => {
	test('JSON round-trip preserves cases, evidence, behavior, owner, reviewer', async () => {
		const { setId } = await makeSet()
		const outcome = await importCases(
			sql,
			editorPrincipal,
			setId,
			sampleCases(),
			{
				ownerUserId: editorUserId,
				reviewerUserId,
			},
		)
		expect(outcome.imported).toBe(2)
		expect(outcome.contentHash).toMatch(/^[a-f0-9]{64}$/)

		const detail = await getSetVersion(sql, editorPrincipal, outcome.versionId)
		const exported = exportSetVersion(detail)
		expect(exported.format).toBe('aifiqh-eval-set')

		// re-importing the exported JSON yields the same content hash
		const again = await importCases(
			sql,
			editorPrincipal,
			setId,
			exported.cases,
			{ ownerUserId: editorUserId, reviewerUserId },
		)
		expect(again.contentHash).toBe(outcome.contentHash)

		const detail2 = await getSetVersion(sql, editorPrincipal, again.versionId)
		const byKey2 = new Map(detail2.cases.map((c) => [c.caseKey, c]))
		const original = detail.cases.find((c) => c.caseKey === 'import-exact')!
		const round = byKey2.get('import-exact')!
		// everything survives: evidence pins, behavior, owner, reviewer
		expect(round.expectedEvidence).toEqual(original.expectedEvidence)
		expect(round.expectedBehavior).toEqual(original.expectedBehavior)
		expect(round.ownerUserId).toBe(original.ownerUserId)
		expect(round.reviewerUserId).toBe(original.reviewerUserId)
		expect(round.riskLevel).toBe('normal')
		const sensitive = byKey2.get('import-sensitive')!
		expect(sensitive.riskLevel).toBe('sensitive')
		expect(sensitive.conversation).toEqual({ priorTurns: 1 })
	})

	test('CSV round-trip preserves cases incl. quoted JSON columns', async () => {
		const { setId } = await makeSet()
		const outcome = await importCases(
			sql,
			editorPrincipal,
			setId,
			sampleCases(),
			{
				ownerUserId: editorUserId,
			},
		)
		const detail = await getSetVersion(sql, editorPrincipal, outcome.versionId)
		const csv = exportSetVersionCsv(detail)
		expect(csv.split('\n')[0]).toContain('case_key,category')

		// parse back and re-import
		const parsed = parseExportedCasesCsv(csv)
		expect(parsed).toHaveLength(2)
		expect(parsed[0].expectedEvidence).toHaveLength(1)
		const reimport = await importCases(sql, editorPrincipal, setId, parsed, {
			ownerUserId: editorUserId,
			reviewerUserId,
		})
		const detail2 = await getSetVersion(
			sql,
			editorPrincipal,
			reimport.versionId,
		)
		const original = detail.cases.find((c) => c.caseKey === 'import-exact')!
		const round = detail2.cases.find((c) => c.caseKey === 'import-exact')!
		expect(round.expectedEvidence).toEqual(original.expectedEvidence)
		expect(round.expectedBehavior).toEqual(original.expectedBehavior)
		expect(round.queryText).toBe(original.queryText)

		// broken CSV is rejected with coded errors
		let thrown: unknown
		try {
			parseExportedCasesCsv('wrong,header\n1,2')
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalSetError).code).toBe('CSV_HEADER_INVALID')
		thrown = undefined
		try {
			parseExportedCasesCsv(
				'case_key,category,language,risk_level,query_text,conversation,expected_behavior,expected_evidence\n' +
					'k,retrieval,id,normal,q,,,"not json"',
			)
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalSetError).code).toBe('CSV_ROW_INVALID')
		// quotes with embedded commas/escapes parse correctly
		const rows = parseCsvRows('"a, b","c""d",e')
		expect(rows[0]).toEqual(['a, b', 'c"d', 'e'])
	})

	test('invalid refs abort the whole import; duplicate keys rejected', async () => {
		const { setId } = await makeSet()
		const badCases: ExportedCase[] = [
			...sampleCases(),
			{
				caseKey: 'bad-ref',
				category: 'exact_lookup',
				queryText: 'q',
				language: 'id',
				riskLevel: 'normal',
				conversation: null,
				expectedBehavior: {},
				ownerUserId: editorUserId,
				reviewerUserId: null,
				expectedEvidence: [
					{ sourceRevisionId: crypto.randomUUID(), mustInclude: true },
				],
			},
		]
		let thrown: unknown
		try {
			await importCases(sql, editorPrincipal, setId, badCases, {
				ownerUserId: editorUserId,
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalSetError).code).toBe('SOURCE_REVISION_NOT_FOUND')
		// the aborted import must not leave a version with partial cases
		const versions = await sql<{ n: string }[]>`
			select count(*) as n from evaluation_set_versions v
			join evaluation_sets s on s.id = v.set_id
			where s.id = ${setId}::uuid`
		expect(Number(versions[0].n)).toBe(1) // only the failed import's empty version

		const dupCases = [...sampleCases(), sampleCases()[0]]
		thrown = undefined
		try {
			await importCases(sql, editorPrincipal, setId, dupCases, {
				ownerUserId: editorUserId,
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalSetError).code).toBe('CASE_KEY_DUPLICATE')
	})

	test('edits create a NEW version; diff reports added/removed/changed', async () => {
		const { setId } = await makeSet()
		const v1 = await importCases(sql, editorPrincipal, setId, sampleCases(), {
			ownerUserId: editorUserId,
		})
		// edits = import again (new version), with a change
		const edited = sampleCases().map((c) =>
			c.caseKey === 'import-exact'
				? { ...c, queryText: 'pertanyaan yang direvisi' }
				: c,
		)
		edited.push({
			caseKey: 'import-abstain',
			category: 'abstention',
			queryText: 'q',
			language: 'id',
			riskLevel: 'normal',
			conversation: null,
			expectedBehavior: { expectedDecision: 'abstain' },
			ownerUserId: editorUserId,
			reviewerUserId: null,
			expectedEvidence: [],
		})
		const v2 = await importCases(sql, editorPrincipal, setId, edited, {
			ownerUserId: editorUserId,
		})
		expect(v2.version).toBe(v1.version + 1)

		// remove a case in v3
		const v3Cases = edited.filter((c) => c.caseKey !== 'import-sensitive')
		const v3 = await importCases(sql, editorPrincipal, setId, v3Cases, {
			ownerUserId: editorUserId,
		})

		const from = await getSetVersion(sql, editorPrincipal, v1.versionId)
		const to = await getSetVersion(sql, editorPrincipal, v2.versionId)
		const diff = diffSetVersions(from, to)
		expect(diff.added).toEqual(['import-abstain'])
		expect(diff.removed).toEqual([])
		expect(diff.changed).toEqual([
			{ caseKey: 'import-exact', fields: ['queryText'] },
		])

		const to3 = await getSetVersion(sql, editorPrincipal, v3.versionId)
		const diff3 = diffSetVersions(to, to3)
		expect(diff3.removed).toEqual(['import-sensitive'])
		expect(diff3.added).toEqual([])
		expect(diff3.changed).toEqual([])
	})

	test('published versions are never import targets — new draft version instead', async () => {
		const { setId } = await makeSet()
		const v1 = await importCases(sql, editorPrincipal, setId, sampleCases(), {
			ownerUserId: editorUserId,
		})
		await publishSetVersion(sql, reviewerPrincipal, v1.versionId)
		const v2 = await importCases(sql, editorPrincipal, setId, sampleCases(), {
			ownerUserId: editorUserId,
		})
		expect(v2.version).toBe(2)
		const [status] = await sql<{ status: string }[]>`
			select status from evaluation_set_versions where id = ${v2.versionId}::uuid`
		expect(status.status).toBe('draft')
	})

	test('seed launch suite covers six categories mapped to gate metrics', async () => {
		const templates = seedLaunchSuite()
		expect(templates).toHaveLength(6)
		expect([...new Set(templates.map((t) => t.category))].sort()).toEqual(
			[...SEED_CATEGORIES].sort(),
		)
		// every category maps to at least one launch_v1 gate metric
		for (const category of SEED_CATEGORIES) {
			expect(SEED_METRIC_MAP[category].length).toBeGreaterThan(0)
		}
		// sensitive cases carry sensitive risk labels
		expect(templates.find((t) => t.category === 'sensitive')?.riskLevel).toBe(
			'sensitive',
		)

		// seeding lands all six cases in a fresh version
		const { setId } = await makeSet()
		const seeded = await seedSetVersion(sql, editorPrincipal, setId, {
			ownerUserId: editorUserId,
			reviewerUserId,
		})
		expect(seeded.imported).toBe(6)
		const detail = await getSetVersion(sql, editorPrincipal, seeded.versionId)
		expect(detail.cases.map((c) => c.category).sort()).toEqual(
			[...SEED_CATEGORIES].sort(),
		)
		for (const c of detail.cases) {
			expect(Object.keys(c.expectedBehavior).length).toBeGreaterThan(0)
		}
	})
})

describe('EVAL-002 HTTP surface', () => {
	async function authHeaders(userId: string) {
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
		return {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
			'x-csrf-token': csrfToken,
			'content-type': 'application/json',
		}
	}

	test('export (json+csv), import, seed and diff over HTTP', async () => {
		const headers = await authHeaders(editorUserId)

		const createRes = await testApp.handle(
			new Request('http://localhost/eval/sets', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					key: `evalio-http-${crypto.randomUUID().slice(0, 8)}`,
				}),
			}),
		)
		const set = await createRes.json()

		// seed via HTTP
		const seedRes = await testApp.handle(
			new Request(`http://localhost/eval/sets/${set.setId}/seed`, {
				method: 'POST',
				headers,
			}),
		)
		expect(seedRes.status).toBe(200)
		const seeded = await seedRes.json()
		expect(seeded.imported).toBe(6)
		expect(seeded.contentHash).toMatch(/^[a-f0-9]{64}$/)

		// export JSON
		const exportRes = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${seeded.versionId}/export`,
				{
					headers,
				},
			),
		)
		expect(exportRes.status).toBe(200)
		const exported: ExportedSetVersion = await exportRes.json()
		expect(exported.cases).toHaveLength(6)

		// export CSV
		const csvRes = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${seeded.versionId}/export?format=csv`,
				{ headers },
			),
		)
		expect(csvRes.status).toBe(200)
		expect(csvRes.headers.get('content-type')).toContain('text/csv')
		const csv = await csvRes.text()
		expect(csv).toContain('seed-grounded-001')

		// import the exported JSON as a new version via HTTP
		const importRes = await testApp.handle(
			new Request(`http://localhost/eval/sets/${set.setId}/import`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ cases: exported.cases }),
			}),
		)
		expect(importRes.status).toBe(200)
		const imported = await importRes.json()
		expect(imported.imported).toBe(6)
		// determinism: importing the same payload again → same hash
		expect(imported.contentHash).toBe(seeded.contentHash)

		// diff over HTTP
		const diffRes = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${seeded.versionId}/diff/${imported.versionId}`,
				{ headers },
			),
		)
		expect(diffRes.status).toBe(200)
		const diff = await diffRes.json()
		expect(diff.added).toEqual([])
		expect(diff.removed).toEqual([])
		expect(diff.changed).toEqual([])

		// invalid import → 422 with code
		const badRes = await testApp.handle(
			new Request(`http://localhost/eval/sets/${set.setId}/import`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ cases: [] }),
			}),
		)
		expect(badRes.status).toBe(422)
		const badBody = await badRes.json()
		expect(badBody.error).toBe('IMPORT_EMPTY')
	})
})
