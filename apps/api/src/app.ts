import type { HealthReport, Permission, Principal } from '@aifiqh/shared'
/**
 * API composition root: trace middleware, health contract, auth guard, and
 * the source registry routes (RBAC-guarded, audit-logged).
 */
import { Elysia } from 'elysia'
import { listAudit, recordAudit } from './audit/audit'
import type { OidcClient } from './auth/oidc'
import { checkAccess, loadPrincipal } from './auth/policy'
import { authPlugin } from './auth/routes'
import { parseCookies, verifySession } from './auth/session'
import type { Config } from './config'
import type { Sql } from './db/client'
import { dbOk } from './db/client'
import type { Logger } from './logger'
import { newTraceId } from './observability/trace'

export interface AppDeps {
	cfg: Config
	log: Logger
	sql: Sql
	oidc: OidcClient
	/** injectable health probes (tests substitute fakes) */
	probes?: {
		storage?: () => Promise<boolean>
	}
}

export class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		public reasonCode?: string,
	) {
		super(code)
	}
}

interface RequestStore {
	traceId: string
}

export function buildApp(deps: AppDeps) {
	const { cfg, log, sql } = deps
	const storageProbe = deps.probes?.storage ?? defaultStorageProbe(cfg)

	const app = new Elysia({ name: 'aifiqh-api' })
		.request((ctx) => {
			const traceId = ctx.request.headers.get('x-request-id') ?? newTraceId()
			ctx.store = { ...(ctx.store ?? {}), traceId } as RequestStore
			ctx.set.headers['x-trace-id'] = traceId
		})
		.afterResponse((ctx) => {
			log.info('request', {
				method: ctx.request.method,
				path: new URL(ctx.request.url).pathname,
				status: typeof ctx.set.status === 'number' ? ctx.set.status : 200,
				traceId: (ctx.store as RequestStore).traceId,
			})
		})
		.error((ctx) => {
			const err = ctx.error
			if (err instanceof HttpError) {
				ctx.set.status = err.status
				return { error: err.code, reasonCode: err.reasonCode ?? err.code }
			}
			log.error('unhandled error', { error: err })
			ctx.set.status = 500
			return { error: 'internal_error' }
		})
		.derive((ctx) => {
			const traceId = (ctx.store as RequestStore).traceId
			return {
				traceId,
				async requirePermission(permission: Permission): Promise<Principal> {
					const token = parseCookies(
						ctx.request.headers.get('cookie'),
					).aifiqh_session
					const session = verifySession(token, cfg.sessionSecret)
					if (!session) throw new HttpError(401, 'unauthorized')
					const tenantId = (session as unknown as { tenantId?: string })
						.tenantId
					if (!tenantId)
						throw new HttpError(403, 'forbidden', 'NO_TENANT_MEMBERSHIP')
					const principal = await loadPrincipal(session.userId, tenantId)
					if (!principal)
						throw new HttpError(403, 'forbidden', 'NO_TENANT_MEMBERSHIP')
					const decision = await checkAccess(principal, permission)
					if (!decision.allowed) {
						log.warn('permission denied', {
							permission,
							reasonCode: decision.reasonCode,
							userId: principal.userId,
							traceId,
						})
						throw new HttpError(403, 'forbidden', decision.reasonCode)
					}
					return principal
				},
				async requireScope(
					principal: Principal,
					scopeId: string,
				): Promise<void> {
					const decision = await checkAccess(principal, 'source:read', scopeId)
					if (!decision.allowed) {
						log.warn('scope denied', {
							scopeId,
							reasonCode: decision.reasonCode,
							traceId,
						})
						throw new HttpError(403, 'forbidden', decision.reasonCode)
					}
				},
			}
		})
		.get('/healthz', () => ({ status: 'healthy' }))
		.get('/readyz', async ({ set }) => {
			const ok = await dbOk()
			if (!ok) set.status = 503
			return { status: ok ? 'ready' : 'unavailable' }
		})
		.get('/health/components', async (): Promise<HealthReport> => {
			const dbHealthy = await dbOk()
			const storageHealthy = await storageProbe().catch(() => false)
			const components = [
				{
					component: 'database',
					status: dbHealthy ? ('healthy' as const) : ('unavailable' as const),
				},
				{
					component: 'object-storage',
					status: storageHealthy
						? ('healthy' as const)
						: ('unavailable' as const),
				},
			]
			const status = components.every((c) => c.status === 'healthy')
				? ('healthy' as const)
				: components.some((c) => c.status === 'healthy')
					? ('degraded' as const)
					: ('unavailable' as const)
			return { status, components }
		})
		.use(authPlugin(deps))
		.use(sourceRoutes(deps))
	return app
}

function defaultStorageProbe(cfg: Config) {
	return async () => {
		try {
			const res = await fetch(`${cfg.storageEndpoint}/minio/health/live`, {
				signal: AbortSignal.timeout(1500),
			})
			return res.ok
		} catch {
			return false
		}
	}
}

const REQUIRED_SOURCE_FIELDS = [
	'title',
	'author',
	'sourceType',
	'language',
	'rightsStatus',
	'accessScopeId',
] as const

interface SourceRow {
	id: string
	tenant_id: string
	title: string
	author: string
	source_type: string
	language: string
	edition: string | null
	publisher: string | null
	rights_status: string
	rights_notes: string | null
	access_scope_id: string
	created_by: string | null
	created_at: Date
}

/** Runtime context contract for guarded routes (derive types are erased
 * across plugin boundaries in this Elysia build, so handlers normalize the
 * incoming context to this shape). */
interface HandlerCtx {
	request: Request
	set: { status?: number; headers: Record<string, string> }
	body: unknown
	params: Record<string, string>
	traceId: string
	requirePermission: (p: Permission) => Promise<Principal>
}

function sourceRoutes(deps: AppDeps) {
	const { cfg, log, sql } = deps
	return new Elysia({ name: 'sources' })
		.post('/sources', async (rawCtx) => {
			const ctx = rawCtx as unknown as HandlerCtx
			const principal = await ctx.requirePermission('source:create')
			const body = ctx.body as Record<string, unknown>
			const missing = REQUIRED_SOURCE_FIELDS.filter((f) => !body?.[f])
			if (missing.length > 0) {
				ctx.set.status = 400
				return { error: 'validation_failed', fields: missing }
			}
			const [row] = await sql<SourceRow[]>`
          insert into sources
            (tenant_id, title, author, source_type, language, edition, publisher,
             rights_status, access_scope_id, created_by)
          values
            (${principal.tenantId}::uuid, ${body.title as string}, ${body.author as string},
             ${body.sourceType as string}, ${body.language as string},
             ${(body.edition as string) || null}, ${(body.publisher as string) || null},
             ${body.rightsStatus as string}, ${body.accessScopeId as string}::uuid,
             ${principal.userId}::uuid)
          returning *
        `
			if (!row) throw new HttpError(500, 'insert_failed')
			await recordAudit({
				tenantId: principal.tenantId,
				actorType: 'user',
				actorId: principal.userId,
				action: 'source.created',
				entityType: 'source',
				entityId: row.id,
				afterRef: { title: row.title },
				reason: (body.reason as string) || null,
				traceId: ctx.traceId,
			})
			ctx.set.status = 201
			return { id: row.id, title: row.title }
		})
		.get('/sources/:id', async (rawCtx) => {
			const ctx = rawCtx as unknown as HandlerCtx
			const principal = await ctx.requirePermission('source:read')
			const [row] = await sql<SourceRow[]>`
        select * from sources where id = ${ctx.params.id}::uuid limit 1
      `
			if (!row || row.tenant_id !== principal.tenantId) {
				ctx.set.status = 404
				return { error: 'not_found' }
			}
			const decision = await checkAccess(
				principal,
				'source:read',
				row.access_scope_id,
			)
			if (!decision.allowed) {
				log.warn('scope denied', {
					reasonCode: decision.reasonCode,
					traceId: ctx.traceId,
				})
				throw new HttpError(403, 'forbidden', decision.reasonCode)
			}
			return row
		})
		.get('/sources', async (rawCtx) => {
			const ctx = rawCtx as unknown as HandlerCtx
			const principal = await ctx.requirePermission('source:read')
			return sql<SourceRow[]>`
        select * from sources where tenant_id = ${principal.tenantId}::uuid
        order by created_at desc limit 100
      `
		})
		.patch('/sources/:id/metadata', async (rawCtx) => {
			const ctx = rawCtx as unknown as HandlerCtx
			const principal = await ctx.requirePermission('source:update_metadata')
			const body = (ctx.body ?? {}) as Record<string, unknown>
			const [before] = await sql<SourceRow[]>`
        select * from sources where id = ${ctx.params.id}::uuid limit 1
      `
			if (!before || before.tenant_id !== principal.tenantId) {
				ctx.set.status = 404
				return { error: 'not_found' }
			}
			const patch = {
				title: typeof body.title === 'string' && body.title ? body.title : null,
				author:
					typeof body.author === 'string' && body.author ? body.author : null,
				language:
					typeof body.language === 'string' && body.language
						? body.language
						: null,
				edition:
					typeof body.edition === 'string' && body.edition
						? body.edition
						: null,
				publisher:
					typeof body.publisher === 'string' && body.publisher
						? body.publisher
						: null,
				rights_status:
					typeof body.rightsStatus === 'string' && body.rightsStatus
						? body.rightsStatus
						: null,
			}
			if (Object.values(patch).every((v) => v === null)) {
				ctx.set.status = 400
				return {
					error: 'validation_failed',
					fields: ['title|author|language|edition|publisher|rightsStatus'],
				}
			}
			const [after] = await sql<SourceRow[]>`
        update sources set
          title = coalesce(${patch.title}, title),
          author = coalesce(${patch.author}, author),
          language = coalesce(${patch.language}, language),
          edition = coalesce(${patch.edition}, edition),
          publisher = coalesce(${patch.publisher}, publisher),
          rights_status = coalesce(${patch.rights_status}, rights_status)
        where id = ${ctx.params.id}::uuid
        returning *
      `
			if (!after) throw new HttpError(500, 'update_failed')
			await recordAudit({
				tenantId: principal.tenantId,
				actorType: 'user',
				actorId: principal.userId,
				action: 'source.metadata_updated',
				entityType: 'source',
				entityId: ctx.params.id,
				beforeRef: { title: before.title, rights_status: before.rights_status },
				afterRef: { title: after.title, rights_status: after.rights_status },
				reason: (body.reason as string) || null,
				traceId: ctx.traceId,
			})
			return { id: after.id, title: after.title }
		})
		.get('/audit/events', async (rawCtx) => {
			const ctx = rawCtx as unknown as HandlerCtx
			const principal = await ctx.requirePermission('audit:read')
			return listAudit({ tenantId: principal.tenantId, limit: 100 })
		})
}
