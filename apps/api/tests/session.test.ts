import { describe, expect, test } from 'bun:test'
import type { AuthSession } from '@aifiqh/shared'
import {
	clearCsrfCookieHeader,
	clearSessionCookieHeader,
	csrfCookieHeader,
	newCsrfToken,
	parseCookies,
	sessionCookieHeader,
	signSession,
	verifyCsrf,
	verifySession,
} from '../src/auth/session'

const SECRET = 'test-secret'
const ttl = 60

function session(overrides: Partial<AuthSession> = {}): AuthSession {
	return {
		sessionId: crypto.randomUUID(),
		userId: crypto.randomUUID(),
		issuer: 'http://localhost:4011',
		subject: 'user@example.com',
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
		...overrides,
	}
}

describe('app sessions (SEC-001)', () => {
	test('round-trips a signed session', () => {
		const s = session()
		const token = signSession(s, SECRET)
		const out = verifySession(token, SECRET)
		expect(out?.userId).toBe(s.userId)
		expect(out?.sessionId).toBe(s.sessionId)
	})

	test('rejects tampered tokens', () => {
		const s = session()
		const token = signSession(s, SECRET)
		const [body] = token.split('.')
		const tampered = `${body}.definitely-wrong-mac`
		expect(verifySession(tampered, SECRET)).toBeNull()
	})

	test('rejects tokens signed with a different secret', () => {
		const token = signSession(session(), SECRET)
		expect(verifySession(token, 'other-secret')).toBeNull()
	})

	test('rejects expired sessions', () => {
		const s = session({ expiresAt: new Date(Date.now() - 1000).toISOString() })
		expect(verifySession(signSession(s, SECRET), SECRET)).toBeNull()
	})

	test('cookie helpers set and clear correctly', () => {
		expect(sessionCookieHeader('tok', 60)).toContain('aifiqh_session=tok')
		expect(sessionCookieHeader('tok', 60)).toContain('HttpOnly')
		expect(clearSessionCookieHeader()).toContain('Max-Age=0')
		expect(parseCookies('a=b; aifiqh_session=tok').aifiqh_session).toBe('tok')
	})

	test('session cookie gains Secure flag when requested', () => {
		expect(sessionCookieHeader('tok', 60, true)).toContain('; Secure')
		expect(sessionCookieHeader('tok', 60, false)).not.toContain('Secure')
	})
})

describe('csrf double-submit (hardening)', () => {
	test('matching header and cookie passes', () => {
		const token = newCsrfToken()
		expect(verifyCsrf(token, token)).toBeTrue()
	})

	test('missing either side fails', () => {
		const token = newCsrfToken()
		expect(verifyCsrf(undefined, token)).toBeFalse()
		expect(verifyCsrf(token, undefined)).toBeFalse()
	})

	test('mismatched or tampered values fail', () => {
		expect(verifyCsrf(newCsrfToken(), newCsrfToken())).toBeFalse()
		const token = newCsrfToken()
		expect(verifyCsrf(`${token}x`, token)).toBeFalse()
	})

	test('csrf cookie helpers behave like session cookies', () => {
		const token = newCsrfToken()
		const header = csrfCookieHeader(token, 60, true)
		expect(header).toContain(`aifiqh_csrf=${token}`)
		expect(header).toContain('; Secure')
		// readable by JS (no HttpOnly) so the SPA can echo the header
		expect(header).not.toContain('HttpOnly')
		expect(clearCsrfCookieHeader()).toContain('Max-Age=0')
	})
})
