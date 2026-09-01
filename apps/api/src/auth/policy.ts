/**
 * Tenant RBAC + access-scope authorization (SEC-002 / HARD-004).
 *
 * The database is the authorization authority: effective permissions are
 * resolved from membership_roles ⋈ role_permissions at request time, so
 * revoking a grant takes effect without a deploy. The TS matrix in
 * @aifiqh/shared is only the seed catalog.
 *
 * All functions take the sql client from the composition root (HARD-005) —
 * no module-scope connections. loadPrincipal runs inside a tenant-scoped
 * transaction because access_scopes/scope_grants carry tenant RLS.
 */
import type {
	AccessDecision,
	Permission,
	Principal,
	RoleKey,
} from '@aifiqh/shared'
import type postgres from 'postgres'
import type { Sql } from '../db/client'
import { scopedTransaction } from '../db/client'

export function hasPermission(
	principal: Principal,
	permission: Permission,
): boolean {
	return principal.permissions.includes(permission)
}

export function checkPermission(
	principal: Principal,
	permission: Permission,
): AccessDecision {
	if (principal.roles.length === 0) {
		return { allowed: false, reasonCode: 'NO_ROLES' }
	}
	if (!hasPermission(principal, permission)) {
		// client-facing code omits the caller's roles; server logs keep full context
		return {
			allowed: false,
			reasonCode: `PERMISSION_DENIED:${permission}`,
		}
	}
	return { allowed: true, reasonCode: 'OK' }
}

/**
 * Scope check: the principal must hold a grant for the resource scope or
 * one of its ancestors. Reads the scope hierarchy from access_scopes.
 */
export async function checkScope(
	sql: Sql | postgres.TransactionSql,
	principal: Principal,
	scopeId: string,
): Promise<AccessDecision> {
	if (principal.scopes.includes(scopeId))
		return { allowed: true, reasonCode: 'OK' }
	const rows = await sql<{ ancestor_id: string }[]>`
		with recursive ancestors as (
			select id, parent_scope_id from access_scopes where id = ${scopeId}::uuid
			union all
			select a.id, a.parent_scope_id
			from access_scopes a join ancestors an on a.id = an.parent_scope_id
		)
		select id as ancestor_id from ancestors
	`
	const allowed = rows.some((r) => principal.scopes.includes(r.ancestor_id))
	return allowed
		? { allowed: true, reasonCode: 'OK' }
		: { allowed: false, reasonCode: `SCOPE_DENIED:${scopeId}` }
}

export async function checkAccess(
	sql: Sql | postgres.TransactionSql,
	principal: Principal,
	permission: Permission,
	scopeId?: string,
): Promise<AccessDecision> {
	const perm = checkPermission(principal, permission)
	if (!perm.allowed) return perm
	if (scopeId) return checkScope(sql, principal, scopeId)
	return { allowed: true, reasonCode: 'OK' }
}

/** Load the effective principal (roles + DB permissions + scope grants). */
export async function loadPrincipal(
	sql: Sql,
	userId: string,
	tenantId: string,
): Promise<Principal | null> {
	return scopedTransaction(sql, tenantId, async (tx) => {
		const membership = await tx<{ id: string }[]>`
			select id from tenant_memberships
			where user_id = ${userId}::uuid and tenant_id = ${tenantId}::uuid and status = 'active'
			limit 1
		`
		if (!membership[0]) return null

		const roles = await tx<{ key: RoleKey }[]>`
			select r.key from membership_roles mr
			join roles r on r.id = mr.role_id
			where mr.membership_id = ${membership[0].id}
		`
		// effective permissions live in the database, not in code
		const permissions = await tx<{ key: Permission }[]>`
			select distinct rp.permission_key as key
			from membership_roles mr
			join role_permissions rp on rp.role_id = mr.role_id
			where mr.membership_id = ${membership[0].id}
		`
		const scopes = await tx<{ scope_id: string }[]>`
			-- grants cover the granted scope and all of its descendants
			with recursive member_scopes as (
				select sg.scope_id from scope_grants sg
				where (sg.principal_type = 'membership' and sg.principal_id = ${membership[0].id}::uuid)
					or (sg.principal_type = 'user' and sg.principal_id = ${userId}::uuid)
			),
			descendants as (
				select id from access_scopes where id in (select scope_id from member_scopes)
				union all
				select c.id from access_scopes c join descendants d on c.parent_scope_id = d.id
			)
			select distinct id as scope_id from descendants
		`
		return {
			userId,
			tenantId,
			roles: roles.map((r) => r.key),
			permissions: permissions.map((p) => p.key),
			scopes: scopes.map((s) => s.scope_id),
			actorType: 'user',
		}
	})
}
