/**
 * HMAC-signed, short-lived app session cookies plus CSRF double-submit
 * tokens. The session cookie carries sessionId/userId/tenant hint + expiry;
 * server-side revocation is checked against PostgreSQL (auth/sessionStore).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type AuthSession, SESSION_COOKIE } from '@aifiqh/shared'

export const CSRF_COOKIE = 'aifiqh_csrf'
export const CSRF_HEADER = 'x-csrf-token'

export function signSession(payload: AuthSession, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const mac = createHmac('sha256', secret).update(body).digest('base64url')
	return `${body}.${mac}`
}

export function verifySession(
	token: string | undefined,
	secret: string,
): AuthSession | null {
	if (!token) return null
	const dot = token.lastIndexOf('.')
	if (dot < 1) return null
	const body = token.slice(0, dot)
	const mac = token.slice(dot + 1)
	const expected = createHmac('sha256', secret).update(body).digest('base64url')
	const a = Buffer.from(mac)
	const b = Buffer.from(expected)
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null
	try {
		const session = JSON.parse(
			Buffer.from(body, 'base64url').toString(),
		) as AuthSession
		if (new Date(session.expiresAt).getTime() < Date.now()) return null
		return session
	} catch {
		return null
	}
}

export function sessionCookieHeader(
	token: string,
	ttlSeconds: number,
	secure = false,
): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${ttlSeconds}`
}

export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/**
 * CSRF double-submit token, session-secret-bound (OWASP signed variant):
 * the cookie carries `<random>.<hmac(random, sessionSecret)>` and the
 * x-csrf-token header must present the SAME value. A forged or replayed
 * pair fails because the attacker cannot compute the HMAC, and the check
 * is bound to the deployment secret rather than relying on cookie/header
 * equality alone.
 */
export function newCsrfToken(secret: string): string {
	const value = randomBytes(24).toString('base64url')
	const mac = createHmac('sha256', secret).update(value).digest('base64url')
	return `${value}.${mac}`
}

export function csrfCookieHeader(
	token: string,
	ttlSeconds: number,
	secure = false,
): string {
	return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${ttlSeconds}`
}

export function clearCsrfCookieHeader(): string {
	return `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`
}

/** Signed double-submit check: header must equal the cookie AND the
 * cookie's HMAC must verify against the session secret. Constant-time. */
export function verifyCsrf(
	headerValue: string | null | undefined,
	cookieValue: string | null | undefined,
	secret: string,
): boolean {
	if (!headerValue || !cookieValue) return false
	// equality first (both attacker-controlled strings; length-mismatch
	// short-circuits before the HMAC work)
	const a = Buffer.from(headerValue)
	const b = Buffer.from(cookieValue)
	if (a.length !== b.length || !timingSafeEqual(a, b)) return false

	const dot = cookieValue.lastIndexOf('.')
	if (dot < 1) return false
	const value = cookieValue.slice(0, dot)
	const mac = cookieValue.slice(dot + 1)
	const expected = createHmac('sha256', secret)
		.update(value)
		.digest('base64url')
	const macBuf = Buffer.from(mac)
	const expectedBuf = Buffer.from(expected)
	if (macBuf.length !== expectedBuf.length) return false
	return timingSafeEqual(macBuf, expectedBuf)
}

export function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const idx = part.indexOf('=')
		if (idx < 0) continue
		out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
	}
	return out
}
