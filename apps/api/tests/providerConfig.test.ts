import { describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-cfg',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)

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

const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: { tenantId: string; adminId: string; editorId: string }

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`cfg-t-${suffix}`}, ${`Config Tenant ${suffix}`})
		returning id`

	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${`${roleKey} user`})
			returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid)
			returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		return user.id
	}

	fixtures = {
		tenantId: tenant.id,
		adminId: await mk('tenant_admin'),
		editorId: await mk('editor'),
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
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=test-csrf-token`,
	}
	if (withCsrf) headers['x-csrf-token'] = 'test-csrf-token'
	return headers
}

describe('model/provider configuration with secret references (CFG-001)', () => {
	test('raw secrets are rejected; only external secret refs are stored and masked', async () => {
		const { tenantId, adminId } = await setupFixtures()
		const auth = await authHeaders(adminId, tenantId, true)

		// raw API key without a secret-manager scheme is rejected
		const raw = await testApp.handle(
			new Request('http://localhost/config/providers', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					key: `raw-${crypto.randomUUID().slice(0, 6)}`,
					provider: 'openai',
					baseUrl: 'https://api.openai.com/v1',
					secretRef: 'sk-live-abc123def456ghi789',
				}),
			}),
		)
		expect(raw.status).toBe(400)
		expect((await raw.json()).error).toBe('SECRET_REF_REJECTED')

		// an external ref is accepted, stored, and never echoed back in full
		const key = `vault-${crypto.randomUUID().slice(0, 6)}`
		const secretRef = 'vault://kv/llm/openai#api-key'
		const created = await testApp.handle(
			new Request('http://localhost/config/providers', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					key,
					provider: 'openai',
					baseUrl: 'https://api.openai.com/v1',
					secretRef,
				}),
			}),
		)
		expect(created.status).toBe(201)

		const list = await testApp.handle(
			new Request('http://localhost/config/providers', { headers: auth }),
		)
		const listJson = (await list.json()) as Array<{
			key: string
			secretRefMasked: string | null
		}>
		const mine = listJson.find((p) => p.key === key)
		expect(mine).toBeDefined()
		expect(mine?.secretRefMasked).toBe(
			'vault://••••#key'.replace('#key', secretRef.slice(-4)),
		)
		// secret scan: the full ref must not appear anywhere in the payload
		expect(JSON.stringify(listJson)).not.toContain(secretRef)

		// the DB stores only the reference; a secret scan of the row agrees
		const [row] = await sql<{ secret_ref: string }[]>`
			select psr.secret_ref from provider_secret_refs psr
			join provider_configs pc on pc.id = psr.provider_config_id
			where pc.key = ${key}`
		expect(row.secret_ref).toBe(secretRef)
	})

	test('invalid config cannot promote: disabled providers rejected from aliases', async () => {
		const { tenantId, adminId } = await setupFixtures()
		const auth = await authHeaders(adminId, tenantId, true)

		// invalid baseUrl rejected outright
		const badUrl = await testApp.handle(
			new Request('http://localhost/config/providers', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					key: `bad-${crypto.randomUUID().slice(0, 6)}`,
					provider: 'local_vllm',
					baseUrl: 'not-a-url',
				}),
			}),
		)
		expect(badUrl.status).toBe(400)

		// create provider, then disable it
		const key = `promote-${crypto.randomUUID().slice(0, 6)}`
		const created = await testApp.handle(
			new Request('http://localhost/config/providers', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					key,
					provider: 'local_ollama',
					baseUrl: 'http://localhost:11434/v1',
				}),
			}),
		)
		const { id: providerId } = await created.json()

		await testApp.handle(
			new Request(`http://localhost/config/providers/${providerId}/enabled`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: false }),
			}),
		)

		// disabled provider cannot be promoted to the routing alias
		const alias = `llm-default-${crypto.randomUUID().slice(0, 6)}`
		const denied = await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				method: 'PUT',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					targetType: 'provider',
					targetId: providerId,
					changeReason: 'try promoting disabled provider',
				}),
			}),
		)
		expect(denied.status).toBe(400)
		expect((await denied.json()).error).toBe('ALIAS_TARGET_INVALID')
	})

	test('connection test hits the endpoint and is audited', async () => {
		const { tenantId, adminId } = await setupFixtures()
		const auth = await authHeaders(adminId, tenantId, true)

		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === '/models') {
					return Response.json({ data: [] })
				}
				return new Response('nf', { status: 404 })
			},
		})

		try {
			const created = await testApp.handle(
				new Request('http://localhost/config/providers', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						key: `probe-${crypto.randomUUID().slice(0, 6)}`,
						provider: 'local_vllm',
						baseUrl: `http://localhost:${mockServer.port}`,
					}),
				}),
			)
			const { id: providerId } = await created.json()

			const test = await testApp.handle(
				new Request(`http://localhost/config/providers/${providerId}/test`, {
					method: 'POST',
					headers: auth,
				}),
			)
			expect(test.status).toBe(200)
			const testJson = await test.json()
			expect(testJson.ok).toBeTrue()
			expect(testJson.statusCode).toBe(200)

			// test result audited
			const audits = await sql<
				{ action: string; after_ref: { ok?: boolean } | null }[]
			>`
				select action, after_ref from audit_events
				where entity_type = 'provider_config' and entity_id = ${providerId}
				order by occurred_at`
			const tested = audits.find((a) => a.action === 'config.provider_tested')
			expect(tested).toBeDefined()
			expect(tested?.after_ref?.ok).toBeTrue()
		} finally {
			mockServer.stop()
		}
	})

	test('alias changes routing and rollback restores the previous target', async () => {
		const { tenantId, adminId } = await setupFixtures()
		const auth = await authHeaders(adminId, tenantId, true)

		const mkProvider = async (keyPrefix: string) => {
			const created = await testApp.handle(
				new Request('http://localhost/config/providers', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						key: `${keyPrefix}-${crypto.randomUUID().slice(0, 6)}`,
						provider: 'local_ollama',
						baseUrl: 'http://localhost:11434/v1',
					}),
				}),
			)
			return (await created.json()).id as string
		}

		const providerA = await mkProvider('route-a')
		const providerB = await mkProvider('route-b')
		const alias = `llm-primary-${crypto.randomUUID().slice(0, 6)}`

		// point alias at A
		await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				method: 'PUT',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					targetType: 'provider',
					targetId: providerA,
					changeReason: 'initial routing to A',
				}),
			}),
		)
		let resolved = await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				headers: auth,
			}),
		)
		expect((await resolved.json()).targetId).toBe(providerA)

		// re-point at B: routing follows the alias
		await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				method: 'PUT',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					targetType: 'provider',
					targetId: providerB,
					changeReason: 'switch to B',
				}),
			}),
		)
		resolved = await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				headers: auth,
			}),
		)
		expect((await resolved.json()).targetId).toBe(providerB)

		// rollback restores A
		const rollback = await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}/rollback`, {
				method: 'POST',
				headers: auth,
			}),
		)
		expect(rollback.status).toBe(200)
		expect((await rollback.json()).restoredTargetId).toBe(providerA)
		resolved = await testApp.handle(
			new Request(`http://localhost/config/aliases/${alias}`, {
				headers: auth,
			}),
		)
		expect((await resolved.json()).targetId).toBe(providerA)

		// alias trail is fully audit-logged
		const trail = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_type = 'configuration_alias' and entity_id = ${alias}
			order by occurred_at`
		expect(trail.map((t) => t.action)).toEqual([
			'config.alias_changed',
			'config.alias_changed',
			'config.alias_rolled_back',
		])
	})

	test('config management is permission-gated (editor denied)', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)

		const denied = await testApp.handle(
			new Request('http://localhost/config/providers', { headers: editorAuth }),
		)
		expect(denied.status).toBe(403)

		const deniedWrite = await testApp.handle(
			new Request('http://localhost/config/providers', {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					key: 'x',
					provider: 'openai',
					baseUrl: 'https://x.dev',
				}),
			}),
		)
		expect(deniedWrite.status).toBe(403)
	})

	test('runtime role can write config tables (migration 0027 grants)', async () => {
		const appUrl = DB_URL.replace(/:\/\/[^@]+@/, '://aifiqh_app:aifiqh_app@')
		const appSql = postgres(appUrl, { max: 1 })
		try {
			const grants = await appSql<
				{ privilege_type: string; table_name: string }[]
			>`
				select privilege_type, table_name from information_schema.role_table_grants
				where grantee = 'aifiqh_app'
					and table_name in ('provider_configs', 'provider_secret_refs', 'model_configs', 'configuration_aliases')
				order by table_name, privilege_type`
			const byTable = new Map<string, Set<string>>()
			for (const g of grants) {
				if (!byTable.has(g.table_name)) byTable.set(g.table_name, new Set())
				byTable.get(g.table_name)!.add(g.privilege_type)
			}
			for (const table of [
				'provider_configs',
				'provider_secret_refs',
				'model_configs',
				'configuration_aliases',
			]) {
				expect(byTable.get(table)).toBeDefined()
				expect(byTable.get(table)!.has('INSERT')).toBeTrue()
				expect(byTable.get(table)!.has('UPDATE')).toBeTrue()
				expect(byTable.get(table)!.has('DELETE')).toBeFalse()
			}
		} finally {
			await appSql.end({ timeout: 1 })
		}
	})
})
