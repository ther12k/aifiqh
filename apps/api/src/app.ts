import { createHash } from 'node:crypto'
import type { HealthReport, Permission, Principal } from '@aifiqh/shared'
/**
 * API composition root: trace middleware, health contract, auth guard, and
 * the source registry routes (RBAC-guarded, audit-logged).
 */
import { Elysia } from 'elysia'
import { listAudit, recordAuditInTx } from './audit/audit'
import type { OidcClient } from './auth/oidc'
import { checkAccess, loadPrincipal } from './auth/policy'
import { authPlugin } from './auth/routes'
import {
	CSRF_HEADER,
	parseCookies,
	verifyCsrf,
	verifySession,
} from './auth/session'
import { isSessionRevoked } from './auth/sessionStore'
import type { Config } from './config'
import { type Sql as ScopedSql, scopedTransaction } from './db/client'
import type { Sql } from './db/client'
import { dbOk } from './db/client'
import type { Logger } from './logger'
import { getTracer, recordSpan } from './observability/otel'
import { newTraceId } from './observability/trace'
import { contentKey, getObject, headObject, putObject } from './storage/s3'

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
	startedAt?: number
}

export function buildApp(deps: AppDeps) {
	const { cfg, log, sql } = deps
	const storageProbe = deps.probes?.storage ?? defaultStorageProbe(cfg)
	const tracer = getTracer('aifiqh-api')

	const app = new Elysia({ name: 'aifiqh-api' })
		.request((ctx) => {
			const traceId = ctx.request.headers.get('x-request-id') ?? newTraceId()
			ctx.store = {
				...(ctx.store ?? {}),
				traceId,
				startedAt: Date.now(),
			} as RequestStore
			ctx.set.headers['x-trace-id'] = traceId
		})
		.afterResponse((ctx) => {
			const store = ctx.store as RequestStore
			const status = typeof ctx.set.status === 'number' ? ctx.set.status : 200
			log.info('request', {
				method: ctx.request.method,
				path: new URL(ctx.request.url).pathname,
				status,
				traceId: store.traceId,
			})
			// OTel-compatible span export (no-op unless an endpoint is configured)
			recordSpan(
				tracer,
				'http.request',
				store.startedAt ?? Date.now(),
				Date.now(),
				store.traceId,
				{
					'http.request.method': ctx.request.method,
					'url.path': new URL(ctx.request.url).pathname,
					'http.response.status_code': status,
					...(cfg.env !== 'development'
						? { 'deployment.environment': cfg.env }
						: {}),
				},
			)
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
				/** CSRF double-submit: x-csrf-token header must equal the cookie. */
				requireCsrf(): void {
					const cookies = parseCookies(ctx.request.headers.get('cookie'))
					if (
						!verifyCsrf(
							ctx.request.headers.get(CSRF_HEADER),
							cookies.aifiqh_csrf,
						)
					) {
						throw new HttpError(403, 'forbidden', 'CSRF_TOKEN_INVALID')
					}
				},
				async requirePermission(permission: Permission): Promise<Principal> {
					const token = parseCookies(
						ctx.request.headers.get('cookie'),
					).aifiqh_session
					const session = verifySession(token, cfg.sessionSecret)
					if (!session) throw new HttpError(401, 'unauthorized')
					if (await isSessionRevoked(sql, session.sessionId)) {
						throw new HttpError(401, 'unauthorized', 'SESSION_REVOKED')
					}
					const tenantId = (session as unknown as { tenantId?: string })
						.tenantId
					if (!tenantId)
						throw new HttpError(403, 'forbidden', 'NO_TENANT_MEMBERSHIP')
					const principal = await loadPrincipal(sql, session.userId, tenantId)
					if (!principal)
						throw new HttpError(403, 'forbidden', 'NO_TENANT_MEMBERSHIP')
					const decision = await checkAccess(sql, principal, permission)
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
					const decision = await checkAccess(
						sql,
						principal,
						'source:read',
						scopeId,
					)
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

/** single-object upload ceiling for the buffered MVP path (bytes) */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

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
	requireCsrf: () => void
}

function sourceRoutes(deps: AppDeps) {
	const { cfg, log, sql } = deps
	return (
		new Elysia({ name: 'sources' })
			.post('/sources', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:create')
				// CSRF after auth so unauthenticated requests still get a 401
				ctx.requireCsrf()
				const body = ctx.body as Record<string, unknown>
				const missing = REQUIRED_SOURCE_FIELDS.filter((f) => !body?.[f])
				if (missing.length > 0) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: missing }
				}
				// the access scope must exist, belong to the caller's tenant, and be
				// within the caller's granted scopes (no cross-tenant scope injection).
				// the lookup runs inside the tenant transaction: access_scopes carries
				// RLS, so an out-of-transaction read cannot see it at all
				const row = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [scope] = await tx<{ tenant_id: string }[]>`
					select tenant_id from access_scopes where id = ${body.accessScopeId as string}::uuid limit 1
				`
						if (
							!scope ||
							scope.tenant_id !== principal.tenantId ||
							!principal.scopes.includes(body.accessScopeId as string)
						) {
							return {
								error: 'invalid_access_scope',
								fields: ['accessScopeId'],
							}
						}
						const [inserted] = await tx<SourceRow[]>`
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
						if (!inserted) throw new HttpError(500, 'insert_failed')
						// business change + audit commit atomically (HARD-007)
						await recordAuditInTx(tx, {
							tenantId: principal.tenantId,
							actorType: 'user',
							actorId: principal.userId,
							action: 'source.created',
							entityType: 'source',
							entityId: inserted.id,
							afterRef: { title: inserted.title },
							reason: (body.reason as string) || null,
							traceId: ctx.traceId,
						})
						return { created: inserted }
					},
				)
				if ('error' in row) {
					ctx.set.status = 400
					return row
				}
				ctx.set.status = 201
				return { id: row.created.id, title: row.created.title }
			})
			.get('/sources/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				const row = await scopedTransaction(sql, principal.tenantId, (tx) =>
					tx<SourceRow[]>`
        select * from sources where id = ${ctx.params.id}::uuid limit 1
      `.then((rows) => rows[0]),
				)
				if (!row || row.tenant_id !== principal.tenantId) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				const decision = await checkAccess(
					sql,
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
				// principal.scopes is pre-expanded to descendants, so this restricts
				// the list exactly like the detail endpoint's scope check
				return scopedTransaction(
					sql,
					principal.tenantId,
					(tx) =>
						tx<SourceRow[]>`
					select * from sources
					where tenant_id = ${principal.tenantId}::uuid
						and access_scope_id = any(${principal.scopes}::uuid[])
					order by created_at desc limit 100
				`,
				)
			})
			.patch('/sources/:id/metadata', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:update_metadata')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const patch = {
					title:
						typeof body.title === 'string' && body.title ? body.title : null,
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
				// read-before-write + scope check + update + audit in ONE
				// tenant-scoped transaction (HARD-007)
				const outcome = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [b] = await tx<SourceRow[]>`
					select * from sources where id = ${ctx.params.id}::uuid limit 1
				`
						if (!b || b.tenant_id !== principal.tenantId)
							return { code: 'not_found' as const }
						// scope check on the CURRENT scope: tenant-wide update_metadata
						// alone must not touch out-of-scope sources
						const scopeDecision = await checkAccess(
							tx,
							principal,
							'source:read',
							b.access_scope_id,
						)
						if (!scopeDecision.allowed) {
							log.warn('scope denied', {
								reasonCode: scopeDecision.reasonCode,
								traceId: ctx.traceId,
							})
							return {
								code: 'forbidden' as const,
								reasonCode: scopeDecision.reasonCode,
							}
						}
						const [a] = await tx<SourceRow[]>`
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
						if (!a) throw new HttpError(500, 'update_failed')
						await recordAuditInTx(tx, {
							tenantId: principal.tenantId,
							actorType: 'user',
							actorId: principal.userId,
							action: 'source.metadata_updated',
							entityType: 'source',
							entityId: ctx.params.id,
							beforeRef: { title: b.title, rights_status: b.rights_status },
							afterRef: { title: a.title, rights_status: a.rights_status },
							reason: (body.reason as string) || null,
							traceId: ctx.traceId,
						})
						return { code: 'ok' as const, before: b, after: a }
					},
				)
				if (outcome.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (outcome.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', outcome.reasonCode)
				}
				return { id: outcome.after.id, title: outcome.after.title }
			})

			// ------------------------------------------------------------------
			// SRC-002: content-addressed immutable upload pipeline
			// ------------------------------------------------------------------
			.post('/sources/:id/revisions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:create')
				ctx.requireCsrf()
				const buf = Buffer.from(await ctx.request.arrayBuffer())
				if (buf.length === 0) {
					ctx.set.status = 400
					return { error: 'empty_file' }
				}
				if (buf.length > MAX_UPLOAD_BYTES) {
					ctx.set.status = 413
					return { error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }
				}
				const sha256 = createHash('sha256').update(buf).digest('hex')
				const key = contentKey(sha256)
				// content-addressed dedupe: identical bytes already stored → reuse
				const stat = await headObject(cfg, key)
				const deduplicated = stat.exists
				if (!stat.exists) {
					// the object is fully written BEFORE any revision row exists, so
					// a failed/interrupted upload can never leave an active revision
					await putObject(
						cfg,
						key,
						buf,
						ctx.request.headers.get('content-type') ??
							'application/octet-stream',
					)
				}
				// revision numbers race under concurrent uploads: retry on conflict
				let outcome:
					| { code: 'not_found' }
					| { code: 'ok'; revisionId: string; revisionNumber: number } = {
					code: 'not_found',
				}
				for (let attempt = 0; attempt < 3; attempt++) {
					try {
						outcome = await scopedTransaction(
							sql,
							principal.tenantId,
							async (tx) => {
								const [src] = await tx<
									{ id: string; tenant_id: string; access_scope_id: string }[]
								>`select id, tenant_id, access_scope_id from sources
							where id = ${ctx.params.id}::uuid limit 1`
								if (!src || src.tenant_id !== principal.tenantId)
									return { code: 'not_found' as const }
								const scopeDecision = await checkAccess(
									tx,
									principal,
									'source:read',
									src.access_scope_id,
								)
								if (!scopeDecision.allowed)
									throw new HttpError(
										403,
										'forbidden',
										scopeDecision.reasonCode,
									)
								const [max] = await tx<{ n: number }[]>`
							select coalesce(max(revision_number), 0)::int as n
							from source_revisions where source_id = ${src.id}::uuid`
								const [rev] = await tx<
									{ id: string; revision_number: number }[]
								>`
							insert into source_revisions (source_id, revision_number, status, created_by)
							values (${src.id}::uuid, ${(max?.n ?? 0) + 1}, 'active', ${principal.userId}::uuid)
							returning id, revision_number`
								await tx`
							insert into source_files
								(source_revision_id, sha256, storage_key, mime_type, size_bytes)
							values
								(${rev.id}::uuid, ${sha256}, ${key},
								 ${ctx.request.headers.get('content-type') ?? 'application/octet-stream'},
								 ${buf.length})`
								await recordAuditInTx(tx, {
									tenantId: principal.tenantId,
									actorType: 'user',
									actorId: principal.userId,
									action: 'source.revision_created',
									entityType: 'source_revision',
									entityId: rev.id,
									afterRef: { sha256, sizeBytes: buf.length, deduplicated },
									traceId: ctx.traceId,
								})
								return {
									code: 'ok' as const,
									revisionId: rev.id,
									revisionNumber: rev.revision_number,
								}
							},
						)
						break
					} catch (err) {
						const retryable =
							err instanceof Error &&
							err.message.includes('source_revisions_source_id')
						if (!retryable || attempt === 2) throw err
					}
				}
				if (outcome.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				ctx.set.status = 201
				return {
					revisionId: outcome.revisionId,
					revisionNumber: outcome.revisionNumber,
					sha256,
					sizeBytes: buf.length,
					objectKey: key,
					deduplicated,
				}
			})
			.get('/sources/:id/revisions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				return scopedTransaction(
					sql,
					principal.tenantId,
					(tx) =>
						tx`
					select sr.id, sr.revision_number, sr.status, sr.created_at,
								 sf.sha256, sf.storage_key, sf.mime_type, sf.size_bytes
					from source_revisions sr
					left join source_files sf on sf.source_revision_id = sr.id
					where sr.source_id = ${ctx.params.id}::uuid
					order by sr.revision_number desc`,
				)
			})
			.get('/sources/:id/revisions/:revisionId/file', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				const file = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [row] = await tx<
							{
								storage_key: string
								mime_type: string
								sha256: string
								size_bytes: number
								access_scope_id: string
							}[]
						>`select sf.storage_key, sf.mime_type, sf.sha256, sf.size_bytes, s.access_scope_id
					from source_revisions sr
					join sources s on s.id = sr.source_id
					join source_files sf on sf.source_revision_id = sr.id
					where sr.id = ${ctx.params.revisionId}::uuid
						and sr.source_id = ${ctx.params.id}::uuid
					limit 1`
						if (!row) return null
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							row.access_scope_id,
						)
						if (!decision.allowed)
							throw new HttpError(403, 'forbidden', decision.reasonCode)
						return row
					},
				)
				if (!file) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				const stored = await getObject(cfg, file.storage_key)
				if (!stored.ok || !stored.body) {
					ctx.set.status = 404
					return { error: 'stored_object_missing' }
				}
				return new Response(stored.body, {
					headers: {
						'content-type': file.mime_type,
						'x-content-sha256': file.sha256,
						'content-length': String(file.size_bytes),
					},
				})
			})
			.get('/audit/events', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('audit:read')
				return scopedTransaction(sql, principal.tenantId, (tx) =>
					listAudit(tx, { tenantId: principal.tenantId, limit: 100 }),
				)
			})
	)
}
