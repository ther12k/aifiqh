/**
 * Auth + session routes: /auth/login, /auth/callback, /auth/logout, /auth/me.
 * Handlers return standard Response objects so redirects and cookies are
 * framework-independent. Login states and revocations live in PostgreSQL
 * (auth/sessionStore) so they survive restarts and work across instances.
 */
import { Elysia } from 'elysia'
import type { Config } from '../config'
import { type Sql, db } from '../db/client'
import type { Logger } from '../logger'
import { type OidcClient, upsertIdentity } from './oidc'
import { loadPrincipal } from './policy'
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
} from './session'
import {
	consumeLoginState,
	createLoginState,
	isSessionRevoked,
	issueSession,
	revokeSession,
} from './sessionStore'

export interface AuthDeps {
	cfg: Config
	log: Logger
	oidc: OidcClient
	/** injected client from the composition root (HARD-005) */
	sql: Sql
}

export function authPlugin(deps: AuthDeps) {
	const { cfg, log, oidc, sql } = deps

	return new Elysia({ name: 'auth' })
		.get('/auth/login', async ({ set }) => {
			const ep = await oidc.discovery()
			const state = crypto.randomUUID()
			const nonce = crypto.randomUUID()
			await createLoginState(sql, state, nonce)
			const url = new URL(ep.authorization_endpoint)
			url.searchParams.set('response_type', 'code')
			url.searchParams.set('client_id', oidc.clientId)
			url.searchParams.set('redirect_uri', `${cfg.publicBaseUrl}/auth/callback`)
			url.searchParams.set('scope', 'openid email profile')
			url.searchParams.set('state', state)
			url.searchParams.set('nonce', nonce)
			set.status = 302
			set.headers.location = url.toString()
		})
		.get('/auth/callback', async ({ request, set }) => {
			const query = Object.fromEntries(
				new URL(request.url).searchParams.entries(),
			) as Record<string, string>
			// single-use consume: replayed or expired states return nothing
			const nonce = query.state
				? await consumeLoginState(sql, query.state)
				: null
			if (!nonce) {
				set.status = 400
				return 'invalid state'
			}
			try {
				const ep = await oidc.discovery()
				// provider declares client_secret_basic: secret travels in an
				// HTTP Basic auth header, never in the form body
				const basic = Buffer.from(
					`${oidc.clientId}:${cfg.oidcClientSecret}`,
				).toString('base64')
				const tokenRes = await fetch(ep.token_endpoint, {
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						authorization: `Basic ${basic}`,
					},
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code: query.code,
						redirect_uri: `${cfg.publicBaseUrl}/auth/callback`,
					}),
				})
				if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`)
				const tokens = (await tokenRes.json()) as { id_token?: string }
				if (!tokens.id_token) throw new Error('no id_token')
				const claims = await oidc.verifyIdToken(tokens.id_token)
				// we always send a nonce; a missing or mismatched claim is a replay
				if (claims.nonce !== nonce) throw new Error('nonce missing or mismatch')
				const user = await upsertIdentity(
					sql,
					cfg.oidcIssuer,
					claims.sub,
					claims.email ?? `${claims.sub}@unknown.invalid`,
					claims.name ?? claims.preferred_username ?? claims.sub,
					claims.email_verified === true,
				)
				// Single-tenant MVP: attach the user's first active membership.
				const [firstTenant] = await sql<{ tenant_id: string }[]>`
					select tenant_id from tenant_memberships
					where user_id = ${user.id}::uuid and status = 'active' limit 1
				`
				const now = Math.floor(Date.now() / 1000)
				const expiresAt = new Date((now + cfg.sessionTtlSeconds) * 1000)
				const session = {
					sessionId: crypto.randomUUID(),
					userId: user.id,
					issuer: cfg.oidcIssuer,
					subject: claims.sub,
					expiresAt: expiresAt.toISOString(),
					tenantId: firstTenant?.tenant_id ?? '',
				}
				await issueSession(sql, { ...session, expiresAt })
				const secure = cfg.env === 'production'
				set.headers['set-cookie'] = [
					sessionCookieHeader(
						signSession(session, cfg.sessionSecret),
						cfg.sessionTtlSeconds,
						secure,
					),
					csrfCookieHeader(newCsrfToken(), cfg.sessionTtlSeconds, secure),
				]
				set.headers.location = '/'
				set.status = 302
				log.info('login succeeded', { userId: user.id })
			} catch (err) {
				log.warn('login failed', {
					error: err instanceof Error ? err.message : 'unknown',
				})
				set.status = 401
				return 'authentication failed'
			}
		})
		.post('/auth/logout', async ({ request, set }) => {
			const cookies = parseCookies(request.headers.get('cookie'))
			const session = verifySession(cookies.aifiqh_session, cfg.sessionSecret)
			// a valid session may only be cleared with the matching CSRF token
			if (
				session &&
				!verifyCsrf(request.headers.get('x-csrf-token'), cookies.aifiqh_csrf)
			) {
				set.status = 403
				return { error: 'forbidden', reasonCode: 'CSRF_TOKEN_INVALID' }
			}
			if (session) revokeSession(sql, session.sessionId)
			set.headers['set-cookie'] = [
				clearSessionCookieHeader(),
				clearCsrfCookieHeader(),
			]
			set.status = 204
		})
		.get('/auth/me', async ({ request, set }) => {
			const session = verifySession(
				parseCookies(request.headers.get('cookie')).aifiqh_session,
				cfg.sessionSecret,
			)
			if (!session || (await isSessionRevoked(sql, session.sessionId))) {
				set.status = 401
				return { error: 'unauthorized' }
			}
			// tenant + permissions resolve from the database at request time
			// (same trust path as requirePermission); the shell uses them as
			// UI permission hints only — the server stays authoritative
			const me: Record<string, unknown> = {
				userId: session.userId,
				issuer: session.issuer,
				expiresAt: session.expiresAt,
			}
			const tenantId = session.tenantId
			if (tenantId) {
				const principal = await loadPrincipal(sql, session.userId, tenantId)
				if (principal) {
					me.tenantId = principal.tenantId
					me.permissions = principal.permissions
				}
			}
			return me
		})
}
