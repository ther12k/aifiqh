/**
 * HMAC-signed, short-lived app session cookies. The cookie carries
 * sessionId/userId/tenant hint + expiry; server-side revocation is handled
 * by auth/oidc.ts isRevoked(). Secret rotation is out of MVP scope.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { type AuthSession, SESSION_COOKIE } from '@aifiqh/shared'
import { isRevoked as isSessionRevoked } from './oidc'

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
		if (isSessionRevoked(session.sessionId)) return null
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
	return (
		`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` +
		(secure ? '; Secure' : '') +
		`; Max-Age=${ttlSeconds}`
	)
}

export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
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
