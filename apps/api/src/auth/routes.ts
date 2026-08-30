/**
 * Auth + session routes: /auth/login, /auth/callback, /auth/logout, /auth/me.
 * Handlers return standard Response objects so redirects and cookies are
 * framework-independent.
 */
import { Elysia } from 'elysia'
import type { Config } from '../config'
import type { Logger } from '../logger'
import { db } from '../db/client'
import { type OidcClient, revokeSession, upsertIdentity } from './oidc'
import {
	clearSessionCookieHeader,
	parseCookies,
	sessionCookieHeader,
	signSession,
	verifySession,
} from './session'

const sql = db()

export interface AuthDeps {
	cfg: Config
	log: Logger
	oidc: OidcClient
}

interface PendingState {
	state: string
	nonce: string
	createdAt: number
}

/** In-memory OIDC state store (single instance MVP). */
const pendingStates = new Map<string, PendingState>()

export function authPlugin(deps: AuthDeps) {
	const { cfg, log, oidc } = deps

	return new Elysia({ name: 'auth' })
		.get('/auth/login', async ({ set }) => {
			const ep = await oidc.discovery()
			const state = crypto.randomUUID()
			const nonce = crypto.randomUUID()
			pendingStates.set(state, { state, nonce, createdAt: Date.now() })
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
			const state = pendingStates.get(query.state)
			pendingStates.delete(query.state)
			if (!state || Date.now() - state.createdAt > 600_000) {
				set.status = 400
				return 'invalid state'
			}
			try {
				const ep = await oidc.discovery()
				const tokenRes = await fetch(ep.token_endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code: query.code,
						redirect_uri: `${cfg.publicBaseUrl}/auth/callback`,
						client_id: oidc.clientId,
						client_secret: cfg.oidcClientSecret,
					}),
				})
				if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`)
				const tokens = (await tokenRes.json()) as { id_token?: string }
				if (!tokens.id_token) throw new Error('no id_token')
				const claims = await oidc.verifyIdToken(tokens.id_token)
				if (claims.nonce && claims.nonce !== state.nonce)
					throw new Error('nonce mismatch')
				const user = await upsertIdentity(
					cfg.oidcIssuer,
					claims.sub,
					claims.email ?? `${claims.sub}@unknown.invalid`,
					claims.name ?? claims.preferred_username ?? claims.sub,
				)
				// Single-tenant MVP: attach the user's first active membership.
				const [firstTenant] = await sql<{ tenant_id: string }[]>`
					select tenant_id from tenant_memberships
					where user_id = ${user.id}::uuid and status = 'active' limit 1
				`
				const now = Math.floor(Date.now() / 1000)
				const session = {
					sessionId: crypto.randomUUID(),
					userId: user.id,
					issuer: cfg.oidcIssuer,
					subject: claims.sub,
					expiresAt: new Date(
						(now + cfg.sessionTtlSeconds) * 1000,
					).toISOString(),
					tenantId: firstTenant?.tenant_id ?? '',
				}
				set.headers['set-cookie'] = sessionCookieHeader(
					signSession(session, cfg.sessionSecret),
					cfg.sessionTtlSeconds,
				)
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
		.post('/auth/logout', ({ request, set }) => {
			const token = parseCookies(request.headers.get('cookie')).aifiqh_session
			const session = verifySession(token, cfg.sessionSecret)
			if (session) revokeSession(session.sessionId, cfg.sessionTtlSeconds)
			set.headers['set-cookie'] = clearSessionCookieHeader()
			set.status = 204
		})
		.get('/auth/me', ({ request, set }) => {
			const token = parseCookies(request.headers.get('cookie')).aifiqh_session
			const session = verifySession(token, cfg.sessionSecret)
			if (!session) {
				set.status = 401
				return { error: 'unauthorized' }
			}
			return {
				userId: session.userId,
				issuer: session.issuer,
				expiresAt: session.expiresAt,
			}
		})
}
