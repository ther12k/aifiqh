/**
 * Shared DTOs and contracts. Must not import framework-specific code
 * (no elysia, no postgres, no react) — consumed by api, worker, and web.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable'

export interface ComponentHealth {
	component: string
	status: HealthStatus
	detail?: string
}

export interface HealthReport {
	status: HealthStatus
	components: ComponentHealth[]
}

export type ActorType = 'user' | 'service' | 'system'

export interface AuditEventInput {
	tenantId?: string | null
	actorType: ActorType
	actorId: string
	action: string
	entityType: string
	entityId: string
	beforeRef?: Record<string, unknown> | null
	afterRef?: Record<string, unknown> | null
	reason?: string | null
	traceId?: string | null
}

export interface AuditEvent extends AuditEventInput {
	id: string
	occurredAt: string
}

export type RoleKey =
	| 'tenant_admin'
	| 'editor'
	| 'reviewer'
	| 'reader'
	| 'operator'
	| 'service'

export const PERMISSIONS = [
	'source:read',
	'source:create',
	'source:update_metadata',
	'source:deprecate',
	'knowledge:read',
	'knowledge:draft',
	'review:approve',
	'review:publish',
	'config:manage',
	'ops:read',
	'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
	tenant_admin: PERMISSIONS,
	editor: [
		'source:read',
		'source:create',
		'source:update_metadata',
		'knowledge:read',
		'knowledge:draft',
	],
	reviewer: [
		'source:read',
		'knowledge:read',
		'review:approve',
		'review:publish',
		'audit:read',
	],
	reader: ['source:read', 'knowledge:read'],
	operator: ['source:read', 'knowledge:read', 'ops:read', 'audit:read'],
	service: ['source:read', 'source:create', 'knowledge:read', 'ops:read'],
}

export interface Principal {
	userId: string
	tenantId: string
	roles: RoleKey[]
	/** effective permissions resolved from role_permissions in PostgreSQL —
	 * the database is the authorization authority; ROLE_PERMISSIONS above is
	 * only the seed catalog */
	permissions: Permission[]
	scopes: string[]
	actorType: ActorType
}

export interface AccessDecision {
	allowed: boolean
	reasonCode: string
}

export interface AuthSession {
	sessionId: string
	userId: string
	issuer: string
	subject: string
	expiresAt: string
	/** tenant hint resolved at login (first active membership) */
	tenantId?: string
}

export const SESSION_COOKIE = 'aifiqh_session'

export * from './ingestion'
export * from './knowledge'
export * from './llm'
export * from './sha256'
