/**
 * Trust-boundary hardening drills (#111): the boundaries where untrusted
 * material or configuration meets privileged code paths.
 *
 *  - outbound URL guard (SSRF): acquisition fetchers must refuse private
 *    infrastructure, metadata endpoints, credentials, nonstandard ports
 *  - secret-ref confinement: a compromised provider_secret_refs row must
 *    not turn the API into an arbitrary-file reader
 *  - result-cache authorization: cache hits are namespaced by scope
 *    identity, so a revoked or differently-scoped principal can never
 *    inherit another principal's retrieval results
 */
import { describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { resolveSecretRef } from '../src/llm/modelRouter'
import { ScopedResultCache, scopeKeyFor } from '../src/retrieval/accessPolicy'
import { UnsafeUrlError, assertSafeFetchUrl } from '../src/sources/urlGuard'

describe('outbound URL guard (SSRF, #111)', () => {
	test('public https URLs pass through normalized', () => {
		expect(assertSafeFetchUrl('https://api.quranenc.com/api/v1/x')).toBe(
			'https://api.quranenc.com/api/v1/x',
		)
		expect(
			assertSafeFetchUrl('https://cdn.jsdelivr.net/gh/x/y@1/editions.json'),
		).toContain('jsdelivr.net')
	})

	test('private, loopback, and metadata targets are refused', () => {
		const refused: Array<[string, string]> = [
			['http://127.0.0.1:3100/healthz', 'PRIVATE_IP'],
			['http://10.1.2.3/', 'PRIVATE_IP'],
			['http://192.168.1.10/', 'PRIVATE_IP'],
			['http://172.16.0.9/', 'PRIVATE_IP'],
			['http://169.254.169.254/latest/meta-data/', 'PRIVATE_IP'],
			['http://100.64.0.1/', 'PRIVATE_IP'],
			['http://[::1]/', 'PRIVATE_IP'],
			['http://[fd00::1]/', 'PRIVATE_IP'],
			['http://localhost:5174/', 'HOST'],
			['http://metadata.google.internal/computeMetadata/', 'HOST'],
			['http://db.internal:5434/', 'HOST'],
		]
		for (const [url, code] of refused) {
			try {
				assertSafeFetchUrl(url)
				expect.unreachable()
			} catch (err) {
				expect(err).toBeInstanceOf(UnsafeUrlError)
				expect((err as UnsafeUrlError).code).toBe(code)
			}
		}
	})

	test('non-http schemes, embedded credentials, and odd ports are refused', () => {
		for (const [url, code] of [
			['file:///etc/passwd', 'SCHEME'],
			['ftp://example.com/file', 'SCHEME'],
			['https://user:pass@example.com/', 'CREDENTIALS'],
			['https://example.com:2244/', 'PORT'],
			['https://example.com:5432/', 'PORT'],
			['not a url', 'UNPARSEABLE'],
		] as Array<[string, string]>) {
			try {
				assertSafeFetchUrl(url)
				expect.unreachable()
			} catch (err) {
				expect((err as UnsafeUrlError).code).toBe(code)
			}
		}
	})

	test('allow-list constrains fetchers to their configured provider hosts', () => {
		expect(
			assertSafeFetchUrl('https://api.myquran.com/v2/hadits/arbain/semua', {
				allowedHosts: ['api.myquran.com', 'equran.id'],
			}),
		).toContain('myquran')
		try {
			assertSafeFetchUrl('https://evil.example.com/steal', {
				allowedHosts: ['api.myquran.com'],
			})
			expect.unreachable()
		} catch (err) {
			expect((err as UnsafeUrlError).code).toBe('HOST_NOT_ALLOWED')
		}
		// a subdomain of an allowed host is allowed; a lookalike is not
		expect(
			assertSafeFetchUrl('https://v2.api.myquran.com/', {
				allowedHosts: ['myquran.com'],
			}),
		).toBeTruthy()
		try {
			assertSafeFetchUrl('https://api.myquran.com.evil.io/', {
				allowedHosts: ['myquran.com'],
			})
			expect.unreachable()
		} catch (err) {
			expect((err as UnsafeUrlError).code).toBe('HOST_NOT_ALLOWED')
		}
	})
})

describe('secret-ref confinement (#111)', () => {
	test('file:// is refused entirely when no directories are configured', () => {
		const prev = process.env.AIFIQH_SECRET_FILE_DIRS
		delete process.env.AIFIQH_SECRET_FILE_DIRS
		expect(resolveSecretRef('file:///etc/passwd')).toBeNull()
		expect(resolveSecretRef('file:///run/secrets/api_key')).toBeNull()
		if (prev !== undefined) process.env.AIFIQH_SECRET_FILE_DIRS = prev
	})

	test('file:// resolves only inside configured roots, never outside', () => {
		const prev = process.env.AIFIQH_SECRET_FILE_DIRS
		process.env.AIFIQH_SECRET_FILE_DIRS = '/run/aifiqh-secrets'
		// outside the root: refused (the file does not need to exist — the
		// confinement decision happens before any read)
		expect(resolveSecretRef('file:///etc/passwd')).toBeNull()
		// traversal attempts stay outside after resolution
		expect(resolveSecretRef('file:///run/aifiqh-secrets/../passwd')).toBeNull()
		if (prev !== undefined) process.env.AIFIQH_SECRET_FILE_DIRS = prev
	})

	test('env:// keeps working; unknown schemes never resolve', () => {
		process.env.AIFIQH_ROUTER_TEST_KEY = 'sk-test-value'
		expect(resolveSecretRef('env://AIFIQH_ROUTER_TEST_KEY')).toBe(
			'sk-test-value',
		)
		delete process.env.AIFIQH_ROUTER_TEST_KEY
		expect(resolveSecretRef('vault://prod/openai')).toBeNull()
		expect(resolveSecretRef('gcp-sm://projects/x/secrets/y')).toBeNull()
	})
})

describe('result-cache authorization drill (#111)', () => {
	function principalFor(
		tenantId: string,
		scopes: string[],
		userId = 'user-1',
	): Principal {
		return {
			userId,
			tenantId,
			roles: ['reader'],
			permissions: ['source:read'],
			scopes,
			actorType: 'user',
		}
	}

	test('revoked or narrowed scope can never inherit a cached result', () => {
		const cache = new ScopedResultCache<string>(60_000)
		const tenant = 't-1111'
		const admin = principalFor(tenant, ['scope-root', 'scope-child'])
		const entryKey = 'fusion|release-1|air mutlak|{}|hash-rerank|[]'

		cache.set(entryKey, scopeKeyFor(admin), 'ADMIN_RESULT')

		// same identity: hit
		expect(cache.get(entryKey, scopeKeyFor(admin))).toBe('ADMIN_RESULT')

		// the scope grant is REVOKED — identity changes, cache misses
		const narrowed = principalFor(tenant, ['scope-child'])
		expect(cache.get(entryKey, scopeKeyFor(narrowed))).toBeUndefined()

		// a different tenant with IDENTICAL scope uuids still misses
		const foreign = principalFor('t-2222', ['scope-root', 'scope-child'])
		expect(cache.get(entryKey, scopeKeyFor(foreign))).toBeUndefined()
	})
})
