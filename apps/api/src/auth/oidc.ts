/**
 * OIDC authentication + short-lived app sessions (SEC-001 / DB-002).
 *
 * Login redirects to the OIDC provider, /auth/callback validates issuer,
 * audience and expiry of the returned id_token (JWKS signature check),
 * upserts the user + identity exactly once per issuer+subject, and issues
 * an HMAC-signed stateless session cookie. Logout clears the cookie and
 * revokes the server-side session id (denylist until cookie expiry).
 */
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose'
import { db } from '../db/client'

const sql = db()
import type { Config } from '../config'

export interface OidcClaims extends JWTPayload {
	sub: string
	email?: string
	preferred_username?: string
	name?: string
}

export interface OidcEndpoints {
	authorization_endpoint: string
	token_endpoint: string
	jwks_uri: string
	issuer: string
}

export interface OidcClient {
	discovery(): Promise<OidcEndpoints>
	verifyIdToken(idToken: string): Promise<OidcClaims>
	clientId: string
}

export function createOidcClient(
	cfg: Config,
	fetchImpl: typeof fetch = fetch,
): OidcClient {
	let endpoints: OidcEndpoints | null = null
	let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

	return {
		clientId: cfg.oidcClientId,
		async discovery() {
			endpoints ??= (await (
				await fetchImpl(`${cfg.oidcIssuer}/.well-known/openid-configuration`)
			).json()) as OidcEndpoints
			return endpoints
		},
		async verifyIdToken(idToken: string) {
			const ep = await this.discovery()
			jwks ??= createRemoteJWKSet(new URL(ep.jwks_uri))
			const { payload } = await jwtVerify(idToken, jwks, {
				issuer: cfg.oidcIssuer,
				audience: cfg.oidcClientId,
				clockTolerance: 30,
			})
			if (!payload.sub) throw new Error('id_token missing sub')
			return payload as OidcClaims
		},
	}
}

export interface UserRow {
	id: string
	primary_email: string
	display_name: string
}

/** Upsert user + identity exactly once per (issuer, subject). */
export async function upsertIdentity(
	issuer: string,
	subject: string,
	email: string,
	displayName: string,
): Promise<UserRow> {
	const rows = await sql<UserRow[]>`
    with new_user as (
      insert into users (primary_email, display_name)
      values (${email}, ${displayName})
      on conflict (primary_email) do update set display_name = excluded.display_name
      returning id, primary_email, display_name
    ), new_identity as (
      insert into user_identities (user_id, issuer, subject)
      select id, ${issuer}, ${subject} from new_user
      on conflict (issuer, subject) do update set issuer = excluded.issuer
      returning user_id
    )
    select u.id, u.primary_email, u.display_name
    from new_user u join new_identity ni on ni.user_id = u.id
  `
	if (!rows[0]) throw new Error('identity upsert failed')
	return rows[0]
}

/** Sessions: signed cookie + server-side revocation registry (in-memory). */
const revoked = new Map<string, number>() // sessionId -> revokedAtEpoch

export function revokeSession(sessionId: string, ttlSeconds: number): void {
	revoked.set(sessionId, Date.now() + ttlSeconds * 1000)
}

export function isRevoked(sessionId: string): boolean {
	const until = revoked.get(sessionId)
	if (until === undefined) return false
	if (Date.now() > until) {
		revoked.delete(sessionId)
		return false
	}
	return true
}
