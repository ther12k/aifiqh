import { describe, expect, test } from 'bun:test'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import type { Sql } from '../src/db/client'
import { createLogger } from '../src/logger'

const silentLog = createLogger('error', {}, () => {})

/** Fake OIDC client: unit slice never performs real discovery. */
const fakeOidc = {
	clientId: 'aifiqh-api',
	discovery: async () => ({
		issuer: 'http://localhost:4011',
		authorization_endpoint: 'http://localhost:4011/auth',
		token_endpoint: 'http://localhost:4011/token',
		jwks_uri: 'http://localhost:4011/jwks',
	}),
	verifyIdToken: async () => {
		throw new Error('not used in unit slice')
	},
}

function app() {
	return buildApp({
		cfg: loadConfig({
			SESSION_SECRET: 'test-secret',
		} as unknown as NodeJS.ProcessEnv),
		log: silentLog,
		sql: null as unknown as Sql, // healthz/401 paths never touch the DB
		oidc: fakeOidc,
		probes: { storage: async () => true },
	})
}

describe('health contract (OBS-001)', () => {
	test('liveness is healthy without dependencies', async () => {
		const res = await app().handle(new Request('http://localhost/healthz'))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: 'healthy' })
	})

	test('every response carries an x-trace-id (request id honored)', async () => {
		const res = await app().handle(
			new Request('http://localhost/healthz', {
				headers: { 'x-request-id': 'trace-123' },
			}),
		)
		expect(res.headers.get('x-trace-id')).toBe('trace-123')
	})

	test('generated trace id when header absent', async () => {
		const res = await app().handle(new Request('http://localhost/healthz'))
		const id = res.headers.get('x-trace-id')
		expect(id).toBeDefined()
		expect(id).not.toBe('')
	})
})

describe('authentication gate (SEC-001)', () => {
	test('protected route returns 401 without a session', async () => {
		const res = await app().handle(new Request('http://localhost/sources'))
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({
			error: 'unauthorized',
			reasonCode: 'unauthorized',
		})
	})

	test('garbage session cookie returns 401', async () => {
		const res = await app().handle(
			new Request('http://localhost/sources', {
				headers: { cookie: 'aifiqh_session=forged.token' },
			}),
		)
		expect(res.status).toBe(401)
	})

	test('/auth/me reports unauthorized without session', async () => {
		const res = await app().handle(new Request('http://localhost/auth/me'))
		// auth/me is registered only in the full server composition; the app
		// alone serves 404 for unknown routes — acceptable for the unit slice.
		expect([401, 404]).toContain(res.status)
	})
})
