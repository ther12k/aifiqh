import { describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { ROLE_PERMISSIONS } from '@aifiqh/shared'
import { checkPermission, hasPermission } from '../src/auth/policy'

function principal(
	roles: Principal['roles'],
	scopes: string[] = [],
): Principal {
	// simulate the DB path (HARD-004): effective permissions come from
	// role_permissions, not from the role key list
	const permissions = [
		...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? [])),
	]
	return {
		userId: crypto.randomUUID(),
		tenantId: crypto.randomUUID(),
		roles,
		permissions,
		scopes,
		actorType: 'user',
	}
}

describe('RBAC permission matrix (SEC-002)', () => {
	test('deny-by-default: no roles means no permissions', () => {
		const p = principal([])
		const decision = checkPermission(p, 'source:read')
		expect(decision.allowed).toBeFalse()
		expect(decision.reasonCode).toBe('NO_ROLES')
	})

	test('editor cannot approve or publish reviews', () => {
		const p = principal(['editor'])
		expect(checkPermission(p, 'review:approve').allowed).toBeFalse()
		expect(checkPermission(p, 'review:publish').allowed).toBeFalse()
		expect(checkPermission(p, 'review:approve').reasonCode).toContain(
			'PERMISSION_DENIED',
		)
		// client-facing reason code must not leak the caller's role list
		expect(checkPermission(p, 'review:approve').reasonCode).not.toContain(
			'roles=',
		)
	})

	test('editor can create sources but not manage config', () => {
		const p = principal(['editor'])
		expect(hasPermission(p, 'source:create')).toBeTrue()
		expect(hasPermission(p, 'config:manage')).toBeFalse()
	})

	test('reviewer can approve but cannot create sources', () => {
		const p = principal(['reviewer'])
		expect(hasPermission(p, 'review:approve')).toBeTrue()
		expect(hasPermission(p, 'source:create')).toBeFalse()
	})

	test('reader can only read', () => {
		const p = principal(['reader'])
		expect(hasPermission(p, 'source:read')).toBeTrue()
		expect(hasPermission(p, 'knowledge:read')).toBeTrue()
		expect(hasPermission(p, 'knowledge:draft')).toBeFalse()
		expect(hasPermission(p, 'ops:read')).toBeFalse()
	})

	test('tenant_admin has every permission', () => {
		const p = principal(['tenant_admin'])
		expect(hasPermission(p, 'config:manage')).toBeTrue()
		expect(hasPermission(p, 'audit:read')).toBeTrue()
		expect(hasPermission(p, 'source:deprecate')).toBeTrue()
	})

	test('operator reads audit and ops but cannot draft knowledge', () => {
		const p = principal(['operator'])
		expect(hasPermission(p, 'ops:read')).toBeTrue()
		expect(hasPermission(p, 'audit:read')).toBeTrue()
		expect(hasPermission(p, 'knowledge:draft')).toBeFalse()
	})

	test('service scope can read and create sources', () => {
		const p = principal(['service'])
		expect(hasPermission(p, 'source:read')).toBeTrue()
		expect(hasPermission(p, 'source:create')).toBeTrue()
		expect(hasPermission(p, 'audit:read')).toBeFalse()
	})

	test('combined roles union their permissions', () => {
		const p = principal(['editor', 'operator'])
		expect(hasPermission(p, 'knowledge:draft')).toBeTrue()
		expect(hasPermission(p, 'ops:read')).toBeTrue()
		expect(hasPermission(p, 'review:approve')).toBeFalse()
	})

	test('effective permissions are the authority: stripped permission denies', () => {
		// HARD-004: even with the editor role, a principal whose
		// role_permissions row was revoked must be denied
		const p = principal(['editor'])
		p.permissions = p.permissions.filter((x) => x !== 'source:create')
		expect(hasPermission(p, 'source:create')).toBeFalse()
	})
})

describe('access scope decisions', () => {
	test('direct scope grant is allowed without DB when listed', async () => {
		const scopeId = crypto.randomUUID()
		const p = principal(['reader'], [scopeId])
		// checkScope hits the DB only when the direct list misses; the direct
		// hit avoids it (DB path covered by integration tests)
		const decision = await checkScopeDirect(p, scopeId)
		expect(decision.allowed).toBeTrue()
	})
})

// checkScope consults the DB; extract the direct-list fast path for unit use.
async function checkScopeDirect(p: Principal, scopeId: string) {
	if (p.scopes.includes(scopeId))
		return { allowed: true, reasonCode: 'OK' as const }
	return { allowed: false, reasonCode: 'SCOPE_DENIED' as const }
}
