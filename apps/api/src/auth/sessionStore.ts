/**
 * PostgreSQL-backed auth state (hardening): OIDC login states and session
 * revocations survive restarts and work across multiple API instances.
 * Expired rows are pruned opportunistically on write.
 */
import type { Sql } from '../db/client'

const LOGIN_STATE_TTL = '10 minutes'
const PRUNE_OLDER_THAN = '1 day'

/**
 * Issuer recorded on sessions created through the email-only dev shortcut.
 * When dev login is disabled these sessions are revoked wholesale at
 * startup: disabling the endpoint must not leave previously issued
 * privileged sessions usable.
 */
export const DEV_SESSION_ISSUER = 'dev-interaction'

export async function revokeDevSessions(sql: Sql): Promise<number> {
	const rows = await sql<{ n: string }[]>`
		update auth_sessions set revoked_at = now()
		where issuer = ${DEV_SESSION_ISSUER} and revoked_at is null
		returning 1 as n
	`
	return rows.length
}

export async function createLoginState(
	sql: Sql,
	state: string,
	nonce: string,
	codeVerifier: string,
): Promise<void> {
	await sql`
		insert into auth_login_states (state, nonce, code_verifier, expires_at)
		values (${state}::uuid, ${nonce}, ${codeVerifier}, now() + ${LOGIN_STATE_TTL}::interval)
	`
	await sql`delete from auth_login_states where expires_at < now()`
}

/** Atomic single-use consume: returns the nonce or null (unknown/expired). */
export async function consumeLoginState(
	sql: Sql,
	state: string,
): Promise<{ nonce: string; codeVerifier: string } | null> {
	const rows = await sql<{ nonce: string; code_verifier: string }[]>`
		delete from auth_login_states
		where state = ${state}::uuid and expires_at >= now()
		returning nonce, code_verifier
	`
	const row = rows[0]
	return row ? { nonce: row.nonce, codeVerifier: row.code_verifier } : null
}

export interface IssuedSession {
	sessionId: string
	userId: string
	tenantId: string
	issuer: string
	subject: string
	expiresAt: Date
}

export async function issueSession(
	sql: Sql,
	session: IssuedSession,
): Promise<void> {
	await sql`
		insert into auth_sessions
			(session_id, user_id, tenant_id, issuer, subject, expires_at)
		values
			(${session.sessionId}::uuid, ${session.userId}::uuid,
			 ${session.tenantId || null}::uuid, ${session.issuer}, ${session.subject},
			 ${session.expiresAt})
	`
	await sql`delete from auth_sessions where expires_at < now() - ${PRUNE_OLDER_THAN}::interval`
}

export async function revokeSession(
	sql: Sql,
	sessionId: string,
): Promise<void> {
	await sql`
		update auth_sessions set revoked_at = now()
		where session_id = ${sessionId}::uuid and revoked_at is null
	`
}

export async function isSessionRevoked(
	sql: Sql,
	sessionId: string,
): Promise<boolean> {
	const rows = await sql<{ revoked: boolean }[]>`
		select revoked_at is not null as revoked
		from auth_sessions
		where session_id = ${sessionId}::uuid
	`
	// unknown session id (pre-migration cookie, evicted row): treat as revoked
	return rows[0] ? (rows[0].revoked ?? false) : true
}
