/**
 * PostgreSQL-backed auth state (hardening): OIDC login states and session
 * revocations survive restarts and work across multiple API instances.
 * Expired rows are pruned opportunistically on write.
 */
import type { Sql } from '../db/client'

const LOGIN_STATE_TTL = '10 minutes'
const PRUNE_OLDER_THAN = '1 day'

interface LoginStateRow {
	state: string
	nonce: string
}

export async function createLoginState(
	sql: Sql,
	state: string,
	nonce: string,
): Promise<void> {
	await sql`
		insert into auth_login_states (state, nonce, expires_at)
		values (${state}::uuid, ${nonce}, now() + ${LOGIN_STATE_TTL}::interval)
	`
	await sql`delete from auth_login_states where expires_at < now()`
}

/** Atomic single-use consume: returns the nonce or null (unknown/expired). */
export async function consumeLoginState(
	sql: Sql,
	state: string,
): Promise<string | null> {
	const rows = await sql<LoginStateRow[]>`
		delete from auth_login_states
		where state = ${state}::uuid and expires_at >= now()
		returning nonce
	`
	return rows[0]?.nonce ?? null
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
