import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	bucketFor,
	createRolloutRule,
	evaluateFlags,
	killSwitch,
	upsertFlag,
} from '../src/config/flagService'
import {
	PromptConfigError as PCE,
	type PromptConfigError,
	createPromptVersion,
	extractBodyVariables,
	listPromptVersions,
	promotePromptVersion,
	resolvePromptForGeneration,
	rollbackPromptVersion,
	validateVariables,
} from '../src/config/promptService'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'

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
	SESSION_SECRET: 'test-secret-cfg',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SUFFIX = crypto.randomUUID().slice(0, 8)

let adminUser: string
let tenant: string
let adminPrincipal: Principal
let plainPrincipal: Principal

async function ensurePrincipals() {
	if (adminUser) return
	await ensureMigrations()
	const [admin] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cfg-admin-${SUFFIX}@test.local`}, 'Cfg Admin') returning id`
	adminUser = admin.id
	const [plainUser] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cfg-plain-${SUFFIX}@test.local`}, 'Cfg Plain') returning id`
	const [ten] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`cfg-t-${SUFFIX}`}, 'Cfg Tenant') returning id`
	tenant = ten.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant}::uuid, 'root', 'Root') returning id`
	const [adminMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant}::uuid, ${adminUser}::uuid) returning id`
	const [adminRole] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${adminMem.id}::uuid, ${adminRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${adminMem.id}::uuid)`
	adminPrincipal = {
		userId: adminUser,
		tenantId: tenant,
		roles: ['tenant_admin'],
		permissions: ['config:manage', 'knowledge:read', 'review:publish'],
		scopes: [],
		actorType: 'user',
	}
	plainPrincipal = {
		userId: plainUser.id,
		tenantId: tenant,
		roles: ['reader'],
		permissions: ['knowledge:read'],
		scopes: [],
		actorType: 'user',
	}
}

async function authHeaders(userId: string) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId: tenant,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId: tenant,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
		'x-csrf-token': 't-csrf',
		'content-type': 'application/json',
	}
}

describe('CFG-002: prompt versioning, review and promotion', () => {
	beforeAll(ensurePrincipals)

	test('variable validation: undeclared and unused variables rejected', () => {
		const body = 'Jawab pertanyaan {{question}} dengan konteks {{context}}.'
		const bad = validateVariables(body, [{ name: 'question', required: true }])
		expect(bad.ok).toBeFalse()
		expect(bad.problems[0]).toContain('context')

		const unused = validateVariables('tanpa variabel', [
			{ name: 'question', required: true },
		])
		expect(unused.ok).toBeFalse()
		expect(unused.problems[0]).toContain('unused')

		const ok = validateVariables(body, [
			{ name: 'question', required: true },
			{ name: 'context', required: true },
		])
		expect(ok.ok).toBeTrue()
		expect(extractBodyVariables(body)).toEqual(['question', 'context'])
	})

	test('draft → promote → resolve pins the version; promoted body immutable', async () => {
		const templateKey = `grounded-${SUFFIX}`
		const created = await createPromptVersion(sql, adminPrincipal, {
			templateKey,
			body: 'Jawab: {{question}}',
			variables: [{ name: 'question', required: true }],
		})
		expect(created.version).toBe(1)

		await promotePromptVersion(sql, adminPrincipal, created.id)
		const resolved = await resolvePromptForGeneration(sql, templateKey)
		expect(resolved?.versionId).toBe(created.id)
		expect(resolved?.version).toBe(1)

		// promoted rows are immutable at the DB level
		let immutableBlocked = false
		try {
			await sql`update prompt_versions set body = 'tampered' where id = ${created.id}::uuid`
		} catch {
			immutableBlocked = true
		}
		expect(immutableBlocked).toBeTrue()
	})

	test('promotion of variables-invalid drafts is rejected', async () => {
		const templateKey = `badvars-${SUFFIX}`
		// insert a draft directly with mismatched variables
		const [template] = await sql<{ id: string }[]>`
			insert into prompt_templates (key) values (${templateKey}) returning id`
		const [draft] = await sql<{ id: string }[]>`
			insert into prompt_versions (template_id, version, body, variables, status)
			values (${template.id}::uuid, 1, 'pakai {{missing_var}}', '[{"name":"other","required":true}]'::jsonb, 'draft')
			returning id`
		let err: Error | undefined
		try {
			await promotePromptVersion(sql, adminPrincipal, draft.id)
		} catch (e) {
			err = e instanceof Error ? e : undefined
		}
		expect(err?.message).toContain('missing_var')
	})

	test('unauthorized promote denied; rollback audited with mandatory reason', async () => {
		const templateKey = `authz-${SUFFIX}`
		const created = await createPromptVersion(sql, adminPrincipal, {
			templateKey,
			body: 'Q: {{q}}',
			variables: [{ name: 'q', required: true }],
		})
		// reader lacks config:manage
		let denied: Error | undefined
		try {
			await promotePromptVersion(sql, plainPrincipal, created.id)
		} catch (e) {
			denied = e instanceof Error ? e : undefined
		}
		expect(denied?.message).toContain('config:manage')

		await promotePromptVersion(sql, adminPrincipal, created.id)

		// short reason refused
		let shortErr: Error | undefined
		try {
			await rollbackPromptVersion(sql, adminPrincipal, created.id, 'short')
		} catch (e) {
			shortErr = e instanceof Error ? e : undefined
		}
		expect(shortErr?.message).toContain('reason')

		await import('../src/config/promptService').then((m) =>
			m.rollbackPromptVersion(
				sql,
				adminPrincipal,
				created.id,
				'menyusur setelah temuan evaluasi',
			),
		)
		// rollback audited
		const audit = await sql<
			{ action: string; before_ref: Record<string, unknown> }[]
		>`
			select action, before_ref from audit_events
			where entity_id = ${created.id} and action = 'config.prompt_rolled_back'`
		expect(audit).toHaveLength(1)
		expect(audit[0].before_ref?.status).toBe('promoted')

		// after rollback nothing resolves as promoted
		const resolved = await resolvePromptForGeneration(sql, templateKey)
		expect(resolved).toBeNull()
	})

	test('HTTP: create, list, promote, effective round-trip', async () => {
		const templateKey = `http-${SUFFIX}`
		const auth = await authHeaders(adminUser)
		const created = await testApp.handle(
			new Request(`http://localhost/config/prompts/${templateKey}/versions`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					body: 'Konteks: {{context}}',
					variables: [{ name: 'context', required: true }],
				}),
			}),
		)
		expect(created.status).toBe(200)
		const { id } = (await created.json()) as { id: string }

		const promoted = await testApp.handle(
			new Request(`http://localhost/config/prompts/versions/${id}/promote`, {
				method: 'POST',
				headers: auth,
			}),
		)
		expect(promoted.status).toBe(200)

		const effective = await testApp.handle(
			new Request(`http://localhost/config/prompts/${templateKey}/effective`, {
				headers: auth,
			}),
		)
		expect(effective.status).toBe(200)
		expect(((await effective.json()) as { versionId: string }).versionId).toBe(
			id,
		)

		const list = await testApp.handle(
			new Request(`http://localhost/config/prompts/${templateKey}/versions`, {
				headers: auth,
			}),
		)
		const listBody = (await list.json()) as Array<{ status: string }>
		expect(listBody[0].status).toBe('promoted')
	})
})

describe('CFG-003: feature flags + safe rollout controls', () => {
	beforeAll(ensurePrincipals)

	test('bucketing is deterministic per subject', () => {
		const b1 = bucketFor('flag-x', tenant, adminUser)
		const b2 = bucketFor('flag-x', tenant, adminUser)
		const other = bucketFor('flag-x', tenant, crypto.randomUUID())
		expect(b1).toBe(b2)
		expect(b1).toBeGreaterThanOrEqual(0)
		expect(b1).toBeLessThanOrEqual(99)
		void other
	})

	test('rollout: 100% enables, 0% disables, kill switch immediate', async () => {
		await upsertFlag(
			sql,
			adminPrincipal,
			`roll-${SUFFIX}`,
			'uji rollout',
			false,
		)

		// 0% rule → off
		await createRolloutRule(sql, adminPrincipal, {
			flagKey: `roll-${SUFFIX}`,
			percentage: 0,
			priority: 10,
		})
		let eff = await evaluateFlags(sql, adminPrincipal)
		expect(eff.flags[`roll-${SUFFIX}`]).toBeFalse()

		// 100% rule at higher priority → on
		await createRolloutRule(sql, adminPrincipal, {
			flagKey: `roll-${SUFFIX}`,
			percentage: 100,
			priority: 20,
		})
		eff = await evaluateFlags(sql, adminPrincipal)
		expect(eff.flags[`roll-${SUFFIX}`]).toBeTrue()

		// kill switch (priority 100) → immediately off
		await killSwitch(sql, adminPrincipal, `roll-${SUFFIX}`)
		eff = await evaluateFlags(sql, adminPrincipal)
		expect(eff.flags[`roll-${SUFFIX}`]).toBeFalse()
		expect(eff.killSwitched).toContain(`roll-${SUFFIX}`)
	})

	test('invalid targeting rejected: bad percentage and unknown role', async () => {
		await upsertFlag(sql, adminPrincipal, `bad-${SUFFIX}`, 'uji', false)
		let pct: Error | undefined
		try {
			await createRolloutRule(sql, adminPrincipal, {
				flagKey: `bad-${SUFFIX}`,
				percentage: 150,
			})
		} catch (e) {
			pct = e instanceof Error ? e : undefined
		}
		expect(pct?.message).toContain('percentage')

		let role: Error | undefined
		try {
			await createRolloutRule(sql, adminPrincipal, {
				flagKey: `bad-${SUFFIX}`,
				percentage: 50,
				segment: { roles: ['grand_wizard'] },
			})
		} catch (e) {
			role = e instanceof Error ? e : undefined
		}
		expect(role?.message).toContain('grand_wizard')
	})

	test('effective flags stored in trace; changes audited', async () => {
		const { storeEffectiveFlags } = await import('../src/config/flagService')
		const flagKey = `trace-${SUFFIX}`
		await upsertFlag(sql, adminPrincipal, flagKey, 'uji trace', false)
		await createRolloutRule(sql, adminPrincipal, {
			flagKey,
			percentage: 100,
			priority: 5,
		})
		const eff = await evaluateFlags(sql, adminPrincipal)
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant}::uuid, ${adminUser}::uuid, 'flag', 'running') returning id`
		await storeEffectiveFlags(sql, trace.id, eff)
		const [row] = await sql<{
			effective_flags: { flags: Record<string, boolean> }
		}[]>`select effective_flags from retrieval_traces where id = ${trace.id}::uuid`
		expect(row.effective_flags.flags[flagKey]).toBeTrue()

		// rule creation audited
		const audit = await sql<{ action: string }[]>`
			select action from audit_events
			where action = 'config.rollout_rule_created'
			order by occurred_at desc limit 1`
		expect(audit).toHaveLength(1)
	})

	test('HTTP: flag upsert, rule, kill switch round-trip', async () => {
		const auth = await authHeaders(adminUser)
		const key = `http-flag-${SUFFIX}`
		const up = await testApp.handle(
			new Request(`http://localhost/config/flags/${key}`, {
				method: 'PUT',
				headers: auth,
				body: JSON.stringify({ description: 'http', enabledByDefault: false }),
			}),
		)
		expect(up.status).toBe(200)

		const rule = await testApp.handle(
			new Request(`http://localhost/config/flags/${key}/rules`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ percentage: 50, priority: 5 }),
			}),
		)
		expect(rule.status).toBe(200)

		const invalid = await testApp.handle(
			new Request(`http://localhost/config/flags/${key}/rules`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ percentage: 200 }),
			}),
		)
		expect(invalid.status).toBe(422)

		const kill = await testApp.handle(
			new Request(`http://localhost/config/flags/${key}/kill`, {
				method: 'POST',
				headers: auth,
			}),
		)
		expect(kill.status).toBe(200)
	})
})
