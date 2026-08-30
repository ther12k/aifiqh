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
import type { Config } from '../config'
import type { Sql } from '../db/client'

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
/**
 * Identity-first account resolution (HARD-006): lookup starts at
 * (issuer, subject), so an IdP email change never orphans accounts.
 * A brand-new identity links to an existing account only when the IdP
 * asserts the email as verified; otherwise it becomes a separate account.
 */
export async function upsertIdentity(
	sql: Sql,
	issuer: string,
	subject: string,
	email: string,
	displayName: string,
	emailVerified: boolean,
): Promise<UserRow> {
	const existing = await sql<UserRow[]>`
		select u.id, u.primary_email, u.display_name
		from user_identities ui join users u on u.id = ui.user_id
		where ui.issuer = ${issuer} and ui.subject = ${subject}
		limit 1
	`
	if (existing[0]) {
		const [updated] = await sql<UserRow[]>`
			update users set display_name = ${displayName}
			where id = ${existing[0].id}::uuid
			returning id, primary_email, display_name
		`
		if (!updated) throw new Error('identity update failed')
		return updated
	}
	// only a verified email may claim an existing account; unverified emails
	// get a subject-scoped placeholder to prevent account hijack
	let primaryEmail = email
	if (!emailVerified) {
		const clash = await sql<{ exists: boolean }[]>`
			select exists (select 1 from users where primary_email = ${email}) as exists
		`
		if (clash[0]?.exists) primaryEmail = `${subject}@unverified.oidc`
	}
	const linked = await sql<UserRow[]>`
		insert into users (primary_email, display_name)
		values (${primaryEmail}, ${displayName})
		on conflict (primary_email) do update set display_name = excluded.display_name
		returning id, primary_email, display_name
	`
	const user = linked[0]
	if (!user) throw new Error('user upsert failed')
	await sql`
		insert into user_identities (user_id, issuer, subject)
		values (${user.id}, ${issuer}, ${subject})
		on conflict (issuer, subject) do nothing
	`
	return user
}

// Session revocation moved to the PostgreSQL-backed store (auth/sessionStore):
// durable across restarts and correct for multiple API instances.
