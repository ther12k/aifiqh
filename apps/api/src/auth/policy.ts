/**
 * Tenant RBAC + access-scope authorization (SEC-002 / DB-002, DB-003).
 * Deny-by-default: an action is allowed only when the principal's roles
 * carry the permission AND every required scope is granted.
 */
import type {
	AccessDecision,
	Permission,
	Principal,
	RoleKey,
} from '@aifiqh/shared'
import { ROLE_PERMISSIONS } from '@aifiqh/shared'
import { db } from '../db/client'

const sql = db()

export function hasPermission(
	principal: Principal,
	permission: Permission,
): boolean {
	return principal.roles.some((r) => ROLE_PERMISSIONS[r]?.includes(permission))
}

export function checkPermission(
	principal: Principal,
	permission: Permission,
): AccessDecision {
	if (principal.roles.length === 0) {
		return { allowed: false, reasonCode: 'NO_ROLES' }
	}
	if (!hasPermission(principal, permission)) {
		const roles = principal.roles.join(',')
		return {
			allowed: false,
			reasonCode: `PERMISSION_DENIED:${permission} (roles=${roles})`,
		}
	}
	return { allowed: true, reasonCode: 'OK' }
}

/**
 * Scope check: the principal must hold a grant for the resource scope or
 * one of its ancestors. Reads the scope hierarchy from access_scopes.
 */
export async function checkScope(
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
	principal: Principal,
	permission: Permission,
	scopeId?: string,
): Promise<AccessDecision> {
	const perm = checkPermission(principal, permission)
	if (!perm.allowed) return perm
	if (scopeId) return checkScope(principal, scopeId)
	return { allowed: true, reasonCode: 'OK' }
}

/** Load the effective principal (roles + scope grants) for a membership. */
export async function loadPrincipal(
	userId: string,
	tenantId: string,
): Promise<Principal | null> {
	const membership = await sql<{ id: string }[]>`
    select id from tenant_memberships
    where user_id = ${userId}::uuid and tenant_id = ${tenantId}::uuid and status = 'active'
    limit 1
  `
	if (!membership[0]) return null

	const roles = await sql<{ key: RoleKey }[]>`
    select r.key from membership_roles mr
    join roles r on r.id = mr.role_id
    where mr.membership_id = ${membership[0].id}
  `
	const scopes = await sql<{ scope_id: string }[]>`
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
		scopes: scopes.map((s) => s.scope_id),
		actorType: 'user',
	}
}
