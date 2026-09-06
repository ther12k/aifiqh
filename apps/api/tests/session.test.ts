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

describe('csrf signed double-submit (hardening)', () => {
	const SECRET = 'test-session-secret'

	test('signed token from the secret passes when echoed', () => {
		const token = newCsrfToken(SECRET)
		expect(verifyCsrf(token, token, SECRET)).toBeTrue()
	})

	test('missing either side fails', () => {
		const token = newCsrfToken(SECRET)
		expect(verifyCsrf(undefined, token, SECRET)).toBeFalse()
		expect(verifyCsrf(token, undefined, SECRET)).toBeFalse()
	})

	test('mismatched values fail', () => {
		expect(
			verifyCsrf(newCsrfToken(SECRET), newCsrfToken(SECRET), SECRET),
		).toBeFalse()
		const token = newCsrfToken(SECRET)
		expect(verifyCsrf(`${token}x`, token, SECRET)).toBeFalse()
	})

	test('attacker-forged token without the secret is rejected', () => {
		// naive double-submit accepts any matching pair; the signed variant
		// must not — the HMAC cannot be computed without the session secret
		const forged = 'attacker-chosen-value.attacker-cannot-compute-mac'
		expect(verifyCsrf(forged, forged, SECRET)).toBeFalse()
	})

	test('token signed under a different secret is rejected', () => {
		const token = newCsrfToken('other-deployment-secret')
		expect(verifyCsrf(token, token, SECRET)).toBeFalse()
	})

	test('tampered payload invalidates the mac', () => {
		const token = newCsrfToken(SECRET)
		const [value, mac] = token.split('.')
		const tampered = `${value!}tampered.${mac}`
		expect(verifyCsrf(tampered, tampered, SECRET)).toBeFalse()
	})

	test('malformed token without mac separator fails', () => {
		expect(verifyCsrf('plainvalue', 'plainvalue', SECRET)).toBeFalse()
	})

	test('csrf cookie helpers behave like session cookies', () => {
		const token = newCsrfToken(SECRET)
		const header = csrfCookieHeader(token, 60, true)
		expect(header).toContain(`aifiqh_csrf=${token}`)
		expect(header).toContain('; Secure')
		// readable by JS (no HttpOnly) so the SPA can echo the header
		expect(header).not.toContain('HttpOnly')
		expect(clearCsrfCookieHeader()).toContain('Max-Age=0')
	})
})
