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
import {
	ConfigValidationError,
	addModel,
	createProvider,
	listProviders,
	resolveAlias,
	rollbackAlias,
	setAlias,
	setProviderEnabled,
	testProviderConnection,
} from './config/configService'
import { type Sql as ScopedSql, scopedTransaction } from './db/client'
import type { Sql } from './db/client'
import { dbOk } from './db/client'
import {
	EmbeddingError,
	HashEmbeddingProvider,
	embedIndexRelease,
} from './index/embeddingService'
import { compileIncrementalIndexRelease } from './index/incrementalIndexer'
import {
	IndexCompilerError,
	compareIndexReleases,
	compileIndexRelease,
} from './index/indexCompiler'
import {
	LexicalSearchError,
	rebuildLexicalProjection,
	searchLexical,
} from './index/lexicalSearch'
import { rebuildAndVerifyIndexRelease } from './index/rebuildVerifier'
import {
	ChangesetError,
	addChangesetItem,
	createChangeset,
	getChangeset,
	transitionChangeset,
} from './knowledge/changesetService'
import { DiffError, computeChangesetDiff } from './knowledge/diffService'
import type { CreateConceptInput } from './knowledge/knowledgeService'
import {
	addReviewerNote,
	createConcept,
	createRevision,
	getConcept,
	getTypeProfiles,
	listConceptRevisions,
	listStaleConcepts,
	recordVerification,
} from './knowledge/knowledgeService'
import {
	LinkValidationError,
	deactivateLink,
	linkConcepts,
	linkSourceSpan,
	listConceptLinks,
	listSpanLinks,
} from './knowledge/linkService'
import { validateForPublish } from './knowledge/publishValidator'
import {
	ReleaseError,
	publishChangeset,
	resolveAliasRelease,
	rollbackAlias as rollbackReleaseAlias,
} from './knowledge/releaseService'
import type { Logger } from './logger'
import { getTracer, recordSpan } from './observability/otel'
import { newTraceId } from './observability/trace'
import {
	OcrCorrectionError,
	getOcrReview,
	restoreCorrection,
	saveCorrection,
} from './ocr/ocrCorrectionService'
import { resolveSpan } from './sources/spanResolver'
import { contentKey, getObject, headObject, putObject } from './storage/s3'

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
function bodyStr(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined
}
function bodyStrArray(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every((x) => typeof x === 'string')
		? (v as string[])
		: undefined
}

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
				/**
				 * Mutation-time authorization re-check (REL-HARD-005): re-loads
				 * effective permissions inside the caller's transaction, so a
				 * revocation that lands between request start and the write
				 * transaction still denies high-impact mutations.
				 */
				async recheckPermissionInTx(
					tx: Sql,
					principal: Principal,
					permission: Permission,
				): Promise<void> {
					const rows = await tx<{ allowed: number }[]>`
						select count(*)::int as allowed
						from tenant_memberships tm
						join membership_roles mr on mr.membership_id = tm.id
						join role_permissions rp on rp.role_id = mr.role_id
						where tm.user_id = ${principal.userId}::uuid
							and tm.tenant_id = ${principal.tenantId}::uuid
							and tm.status = 'active'
							and rp.permission_key = ${permission}`
					if ((rows[0]?.allowed ?? 0) === 0) {
						log.warn('permission revoked mid-request', {
							permission,
							userId: principal.userId,
							traceId,
						})
						throw new HttpError(
							403,
							'forbidden',
							`PERMISSION_REVOKED:${permission}`,
						)
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
	recheckPermissionInTx: (
		tx: unknown,
		principal: Principal,
		p: Permission,
	) => Promise<void>
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
				// refuse oversized bodies before buffering anything
				const declaredLength = Number(
					ctx.request.headers.get('content-length') ?? '0',
				)
				if (declaredLength > MAX_UPLOAD_BYTES) {
					ctx.set.status = 413
					return { error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }
				}
				// authorize BEFORE touching object storage: an upload against a
				// missing/foreign/out-of-scope source must not leave an orphaned
				// object behind (content-addressed keys would keep it forever)
				const precheck = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [src] = await tx<
							{ id: string; tenant_id: string; access_scope_id: string }[]
						>`select id, tenant_id, access_scope_id from sources
							where id = ${ctx.params.id}::uuid limit 1`
						if (!src || src.tenant_id !== principal.tenantId)
							return { code: 'not_found' as const }
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!decision.allowed) {
							log.warn('scope denied', {
								reasonCode: decision.reasonCode,
								traceId: ctx.traceId,
							})
							return {
								code: 'forbidden' as const,
								reasonCode: decision.reasonCode,
							}
						}
						return { code: 'ok' as const }
					},
				)
				if (precheck.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (precheck.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', precheck.reasonCode)
				}
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
							errMessage(err).includes('source_revisions_source_id')
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
				const statusFilter = (
					ctx as unknown as { query?: Record<string, string> }
				).query?.status
				const result = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						// same scope discipline as the detail/download routes: the
						// caller must hold the source's access scope
						const [src] = await tx<{ access_scope_id: string }[]>`
							select access_scope_id from sources
							where id = ${ctx.params.id}::uuid limit 1`
						if (!src) return { code: 'not_found' as const }
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!decision.allowed) {
							return {
								code: 'forbidden' as const,
								reasonCode: decision.reasonCode,
							}
						}
						const rows = await tx`
						select sr.id, sr.revision_number, sr.status, sr.created_at,
									 sf.sha256, sf.storage_key, sf.mime_type, sf.size_bytes
						from source_revisions sr
						left join source_files sf on sf.source_revision_id = sr.id
						where sr.source_id = ${ctx.params.id}::uuid
							and (${statusFilter ?? null}::text is null or sr.status = ${statusFilter ?? null})
						order by sr.revision_number desc`
						return { code: 'ok' as const, rows }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				return result.rows
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
			// ------------------------------------------------------------------
			// SRC-003: revision deprecation lifecycle + historical resolution
			// ------------------------------------------------------------------
			.post('/sources/:id/revisions/:revisionId/deprecate', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:deprecate')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
				if (!reason) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['reason'] }
				}
				const replacement =
					typeof body.replacementRevisionId === 'string' &&
					body.replacementRevisionId
						? body.replacementRevisionId
						: null
				const result = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [src] = await tx<{ access_scope_id: string }[]>`
							select access_scope_id from sources
							where id = ${ctx.params.id}::uuid limit 1`
						if (!src) return { code: 'not_found' as const }
						const scopeDecision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!scopeDecision.allowed) {
							return {
								code: 'forbidden' as const,
								reasonCode: scopeDecision.reasonCode,
							}
						}
						const [rev] = await tx<{ id: string; status: string }[]>`
							select id, status from source_revisions
							where id = ${ctx.params.revisionId}::uuid
								and source_id = ${ctx.params.id}::uuid limit 1`
						if (!rev) return { code: 'not_found' as const }
						if (rev.status !== 'active') {
							return { code: 'invalid_state' as const, status: rev.status }
						}
						// link the replacement chain: the successor replaces the
						// deprecated revision (validated by the DB trigger)
						if (replacement) {
							await tx`
								update source_revisions set replaces_revision_id = ${ctx.params.revisionId}::uuid
								where id = ${replacement}::uuid
									and source_id = ${ctx.params.id}::uuid
									and status = 'active'`
						}
						await tx`
							update source_revisions
							set status = 'deprecated', deprecation_reason = ${reason}
							where id = ${rev.id}::uuid`
						await tx`
							insert into source_revision_status_events
								(source_revision_id, from_status, to_status, actor_type, actor_id, reason)
							values
								(${rev.id}::uuid, 'active', 'deprecated', 'user', ${principal.userId}, ${reason})`
						await recordAuditInTx(tx, {
							tenantId: principal.tenantId,
							actorType: 'user',
							actorId: principal.userId,
							action: 'source.revision_deprecated',
							entityType: 'source_revision',
							entityId: rev.id,
							beforeRef: { status: 'active' },
							afterRef: { status: 'deprecated', reason, replacement },
							reason,
							traceId: ctx.traceId,
						})
						return { code: 'ok' as const }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				if (result.code === 'invalid_state') {
					ctx.set.status = 409
					return { error: 'invalid_state', status: result.status }
				}
				return { revisionId: ctx.params.revisionId, status: 'deprecated' }
			})
			.get('/sources/:id/revisions/:revisionId/pages', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				const result = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [src] = await tx<{ access_scope_id: string }[]>`
								select access_scope_id from sources
								where id = ${ctx.params.id}::uuid limit 1`
						if (!src) return { code: 'not_found' as const }
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!decision.allowed) {
							return {
								code: 'forbidden' as const,
								reasonCode: decision.reasonCode,
							}
						}
						const pages = await tx<
							{
								id: string
								page_number: number
								image_storage_key: string | null
							}[]
						>`
								select id, page_number, image_storage_key
								from source_pages
								where source_revision_id = ${ctx.params.revisionId}::uuid
								order by page_number asc`
						return { code: 'ok' as const, pages }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				return result.pages
			})
			.get('/sources/:id/revisions/:revisionId/sections', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				const result = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [src] = await tx<{ access_scope_id: string }[]>`
								select access_scope_id from sources
								where id = ${ctx.params.id}::uuid limit 1`
						if (!src) return { code: 'not_found' as const }
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!decision.allowed) {
							return {
								code: 'forbidden' as const,
								reasonCode: decision.reasonCode,
							}
						}
						const sections = await tx<
							{
								id: string
								ordinal: number
								heading: string | null
								parent_section_id: string | null
							}[]
						>`
								select id, ordinal, heading, parent_section_id
								from source_sections
								where source_revision_id = ${ctx.params.revisionId}::uuid
								order by ordinal asc`
						return { code: 'ok' as const, sections }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				return result.sections
			})
			.get('/sources/:id/revisions/:revisionId/spans', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				const query =
					(ctx as unknown as { query?: Record<string, string> }).query ?? {}
				const pageNumber = query.page ? Number(query.page) : null
				const result = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [src] = await tx<{ access_scope_id: string }[]>`
								select access_scope_id from sources
								where id = ${ctx.params.id}::uuid limit 1`
						if (!src) return { code: 'not_found' as const }
						const decision = await checkAccess(
							tx,
							principal,
							'source:read',
							src.access_scope_id,
						)
						if (!decision.allowed) {
							return {
								code: 'forbidden' as const,
								reasonCode: decision.reasonCode,
							}
						}
						const spans = await tx<
							{
								id: string
								span_key: string
								original_text: string
								page_number: number | null
								ordinal: number | null
								heading: string | null
							}[]
						>`
								select sp.id, sp.span_key, sp.original_text,
									p.page_number, sec.ordinal, sec.heading
								from source_spans sp
								left join source_pages p on p.id = sp.page_id
								left join source_sections sec on sec.id = sp.section_id
								where sp.source_revision_id = ${ctx.params.revisionId}::uuid
									and (${pageNumber}::int is null or p.page_number = ${pageNumber})
								order by p.page_number asc nulls first, sp.span_key asc`
						return { code: 'ok' as const, spans }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				return result.spans
			})
			.get(
				'/sources/:id/revisions/:revisionId/spans/:spanKey',
				async (rawCtx) => {
					const ctx = rawCtx as unknown as HandlerCtx
					const principal = await ctx.requirePermission('source:read')
					const result = await scopedTransaction(
						sql,
						principal.tenantId,
						async (tx) => {
							const [src] = await tx<{ access_scope_id: string }[]>`
								select access_scope_id from sources
								where id = ${ctx.params.id}::uuid limit 1`
							if (!src) return { code: 'not_found' as const }
							const decision = await checkAccess(
								tx,
								principal,
								'source:read',
								src.access_scope_id,
							)
							if (!decision.allowed) {
								return {
									code: 'forbidden' as const,
									reasonCode: decision.reasonCode,
								}
							}
							const resolved = await resolveSpan(
								tx,
								ctx.params.id,
								ctx.params.revisionId,
								ctx.params.spanKey,
							)
							return { code: 'ok' as const, resolved }
						},
					)
					if (result.code === 'not_found') {
						ctx.set.status = 404
						return { error: 'not_found' }
					}
					if (result.code === 'forbidden') {
						throw new HttpError(403, 'forbidden', result.reasonCode)
					}
					if (!result.resolved) {
						ctx.set.status = 404
						return { error: 'span_not_found' }
					}
					return result.resolved
				},
			)
			.get('/knowledge/profiles', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				await ctx.requirePermission('knowledge:read')
				return getTypeProfiles(sql)
			})
			.post('/knowledge/concepts', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await createConcept(
						sql,
						principal,
						{
							typeKey: body.typeKey as CreateConceptInput['typeKey'],
							title: bodyStr(body.title) ?? '',
							bodyMarkdown: bodyStr(body.bodyMarkdown) ?? '',
							language: bodyStr(body.language),
							madhhab: bodyStrArray(body.madhhab),
							topicPath: bodyStrArray(body.topicPath),
							accessScopeId: bodyStr(body.accessScopeId) ?? '',
							positionKind: bodyStr(body.positionKind) ?? null,
							authorityClass: bodyStr(body.authorityClass) ?? null,
							metadataJsonb: body.metadataJsonb as
								| Record<string, unknown>
								| undefined,
							generationMethod:
								body.generationMethod as CreateConceptInput['generationMethod'],
							modelRef: body.modelRef as Record<string, unknown> | undefined,
							staleAfter: bodyStr(body.staleAfter),
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (errMessage(err).includes('Validation failed')) {
						ctx.set.status = 400
						return { error: 'validation_failed', message: errMessage(err) }
					}
					if (errMessage(err).includes('Scope denied')) {
						ctx.set.status = 403
						return { error: 'forbidden', reasonCode: errMessage(err) }
					}
					throw err
				}
			})
			.get('/knowledge/concepts/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					const concept = await getConcept(sql, principal, ctx.params.id)
					if (!concept) {
						ctx.set.status = 404
						return { error: 'not_found' }
					}
					return concept
				} catch (err) {
					if (errMessage(err).includes('Scope denied')) {
						ctx.set.status = 403
						return { error: 'forbidden', reasonCode: errMessage(err) }
					}
					throw err
				}
			})
			.post('/knowledge/concepts/:id/revisions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await createRevision(
						sql,
						principal,
						ctx.params.id,
						{
							title: bodyStr(body.title) ?? '',
							bodyMarkdown: bodyStr(body.bodyMarkdown) ?? '',
							language: bodyStr(body.language),
							madhhab: bodyStrArray(body.madhhab),
							positionKind: bodyStr(body.positionKind) ?? null,
							authorityClass: bodyStr(body.authorityClass) ?? null,
							metadataJsonb: body.metadataJsonb as
								| Record<string, unknown>
								| undefined,
							generationMethod:
								body.generationMethod as CreateConceptInput['generationMethod'],
							modelRef: body.modelRef as Record<string, unknown> | undefined,
							staleAfter: bodyStr(body.staleAfter),
							expectedBaseRevisionNumber:
								typeof body.expectedBaseRevisionNumber === 'number'
									? body.expectedBaseRevisionNumber
									: undefined,
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (errMessage(err).includes('Validation failed')) {
						ctx.set.status = 400
						return { error: 'validation_failed', message: errMessage(err) }
					}
					if (errMessage(err).includes('Scope denied')) {
						ctx.set.status = 403
						return { error: 'forbidden', reasonCode: errMessage(err) }
					}
					if (errMessage(err).includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) {
						ctx.set.status = 409
						return { error: 'conflict', message: errMessage(err) }
					}
					if (errMessage(err).includes('DUPLICATE_CONTENT_HASH')) {
						ctx.set.status = 409
						return { error: 'duplicate', message: errMessage(err) }
					}
					if (errMessage(err).includes('Concept not found')) {
						ctx.set.status = 404
						return { error: 'not_found' }
					}
					throw err
				}
			})
			.get('/knowledge/concepts/:id/revisions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await listConceptRevisions(sql, principal, ctx.params.id)
				} catch (err) {
					if (errMessage(err).includes('Scope denied')) {
						ctx.set.status = 403
						return { error: 'forbidden', reasonCode: errMessage(err) }
					}
					if (errMessage(err).includes('Concept not found')) {
						ctx.set.status = 404
						return { error: 'not_found' }
					}
					throw err
				}
			})
			.get('/knowledge/stale', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return listStaleConcepts(sql, principal.tenantId)
			})
			.post('/changesets', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await createChangeset(
						sql,
						principal,
						{ title: bodyStr(body.title) ?? '' },
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (err instanceof ChangesetError) {
						ctx.set.status = 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/changesets/:id/items', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await addChangesetItem(
						sql,
						principal,
						ctx.params.id,
						{
							conceptId: bodyStr(body.conceptId) ?? '',
							proposedRevisionId: bodyStr(body.proposedRevisionId) ?? '',
							baseRevisionId: bodyStr(body.baseRevisionId),
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (err instanceof ChangesetError) {
						ctx.set.status =
							err.code === 'NOT_FOUND'
								? 404
								: err.code === 'SCOPE_DENIED'
									? 403
									: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/changesets/:id/transition', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				// any knowledge participant enters; the service enforces
				// action-specific roles (submit = knowledge:draft,
				// approve/publish/reject = review:approve)
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const action = bodyStr(body.action)
				if (
					!action ||
					![
						'submitted',
						'changes_requested',
						'approved',
						'published',
						'rejected',
					].includes(action)
				) {
					ctx.set.status = 400
					return { error: 'INVALID_TRANSITION', message: 'Unknown action' }
				}
				try {
					const res = await transitionChangeset(
						sql,
						principal,
						ctx.params.id,
						{
							action: action as 'submitted',
							reason: bodyStr(body.reason),
							expectedState: bodyStr(body.expectedState),
						},
						ctx.traceId,
					)
					return res
				} catch (err) {
					if (err instanceof ChangesetError) {
						ctx.set.status =
							err.code === 'NOT_FOUND'
								? 404
								: err.code === 'OPTIMISTIC_CONFLICT'
									? 409
									: err.code === 'SCOPE_DENIED'
										? 403
										: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/changesets/:id/items/:conceptId/diff', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await computeChangesetDiff(
						sql,
						principal,
						ctx.params.id,
						ctx.params.conceptId,
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof DiffError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/changesets/:id/publish', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const alias = bodyStr(body.alias)
				if (alias !== 'staging' && alias !== 'production') {
					ctx.set.status = 400
					return {
						error: 'ALIAS_INVALID',
						message: "alias must be 'staging' or 'production'",
					}
				}
				try {
					return await publishChangeset(
						sql,
						principal,
						ctx.params.id,
						{ alias },
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ReleaseError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/releases/aliases/:alias/rollback', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				if (
					ctx.params.alias !== 'staging' &&
					ctx.params.alias !== 'production'
				) {
					ctx.set.status = 400
					return { error: 'ALIAS_INVALID', message: 'unknown alias' }
				}
				try {
					return await rollbackReleaseAlias(
						sql,
						principal,
						ctx.params.alias as 'staging' | 'production',
						bodyStr(body.targetReleaseId) ?? '',
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ReleaseError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/index/releases/:id/search', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const query =
					(ctx as unknown as { query?: Record<string, string> }).query ?? {}
				try {
					return await searchLexical(
						sql,
						principal,
						ctx.params.id,
						query.q ?? '',
						{
							limit: query.limit ? Number(query.limit) : undefined,
						},
					)
				} catch (err) {
					if (err instanceof LexicalSearchError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/releases/:id/rebuild-lexical', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				try {
					return await rebuildLexicalProjection(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof LexicalSearchError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/releases/:id/embed', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				// deterministic hash provider is the built-in default; remote
				// providers plug into the same EmbeddingProvider contract
				try {
					return await embedIndexRelease(
						sql,
						principal,
						ctx.params.id,
						new HashEmbeddingProvider(),
					)
				} catch (err) {
					if (err instanceof EmbeddingError) {
						ctx.set.status = err.code === 'RELEASE_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get(
				'/index/releases/:prevReleaseId/compare/:nextReleaseId',
				async (rawCtx) => {
					const ctx = rawCtx as unknown as HandlerCtx
					const principal = await ctx.requirePermission('knowledge:read')
					return compareIndexReleases(
						sql,
						principal,
						ctx.params.prevReleaseId,
						ctx.params.nextReleaseId,
					)
				},
			)
			.post('/index/compile', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await compileIndexRelease(
						sql,
						principal,
						{
							knowledgeReleaseId: bodyStr(body.knowledgeReleaseId) ?? '',
							configurationId: bodyStr(body.configurationId) ?? '',
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof IndexCompilerError) {
						ctx.set.status =
							err.code === 'CONFIG_NOT_FOUND' ||
							err.code === 'KNOWLEDGE_RELEASE_NOT_FOUND'
								? 404
								: 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/compile-incremental', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await compileIncrementalIndexRelease(
						sql,
						principal,
						{
							previousIndexReleaseId:
								bodyStr(body.previousIndexReleaseId) ?? '',
							knowledgeReleaseId: bodyStr(body.knowledgeReleaseId) ?? '',
							configurationId: bodyStr(body.configurationId) ?? '',
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof IndexCompilerError) {
						ctx.set.status =
							err.code === 'CONFIG_NOT_FOUND' ||
							err.code === 'KNOWLEDGE_RELEASE_NOT_FOUND'
								? 404
								: 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/releases/:id/rebuild-verify', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				try {
					return await rebuildAndVerifyIndexRelease(
						sql,
						principal,
						ctx.params.id,
						{},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof IndexCompilerError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/releases/aliases/:alias', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				if (
					ctx.params.alias !== 'staging' &&
					ctx.params.alias !== 'production'
				) {
					ctx.set.status = 400
					return { error: 'ALIAS_INVALID', message: 'unknown alias' }
				}
				const release = await resolveAliasRelease(
					sql,
					principal,
					ctx.params.alias as 'staging' | 'production',
				)
				if (!release) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				return release
			})
			.get('/changesets/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await getChangeset(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof ChangesetError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get(
				'/knowledge/concepts/:id/revisions/:revisionId/publish-validation',
				async (rawCtx) => {
					const ctx = rawCtx as unknown as HandlerCtx
					const principal = await ctx.requirePermission('review:approve')
					return validateForPublish(
						sql,
						principal,
						ctx.params.id,
						ctx.params.revisionId,
					)
				},
			)
			.get('/ocr/outputs/:ocrOutputId/review', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:read')
				try {
					const review = await getOcrReview(
						sql,
						principal,
						ctx.params.ocrOutputId,
					)
					if (!review) {
						ctx.set.status = 404
						return { error: 'not_found' }
					}
					return review
				} catch (err) {
					if (
						err instanceof OcrCorrectionError &&
						err.code === 'SCOPE_DENIED'
					) {
						throw new HttpError(403, 'forbidden', err.message)
					}
					throw err
				}
			})
			.post('/ocr/outputs/:ocrOutputId/corrections', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:update_metadata')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await saveCorrection(
						sql,
						principal,
						ctx.params.ocrOutputId,
						{
							correctedText: bodyStr(body.correctedText) ?? '',
							reason: bodyStr(body.reason) ?? '',
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (err instanceof OcrCorrectionError) {
						ctx.set.status = err.code === 'OCR_OUTPUT_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					if (
						err instanceof OcrCorrectionError &&
						err.code === 'SCOPE_DENIED'
					) {
						throw new HttpError(403, 'forbidden', err.message)
					}
					throw err
				}
			})
			.post(
				'/ocr/outputs/:ocrOutputId/corrections/:correctionId/restore',
				async (rawCtx) => {
					const ctx = rawCtx as unknown as HandlerCtx
					const principal = await ctx.requirePermission(
						'source:update_metadata',
					)
					ctx.requireCsrf()
					try {
						return await restoreCorrection(
							sql,
							principal,
							ctx.params.ocrOutputId,
							ctx.params.correctionId,
							ctx.traceId,
						)
					} catch (err) {
						if (err instanceof OcrCorrectionError) {
							ctx.set.status = err.code === 'CORRECTION_NOT_FOUND' ? 404 : 403
							return { error: err.code, message: err.message }
						}
						throw err
					}
				},
			)
			.post('/knowledge/revisions/:revisionId/links', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await linkConcepts(
						sql,
						principal,
						ctx.params.revisionId,
						{
							toConceptId: bodyStr(body.toConceptId),
							toRevisionId: bodyStr(body.toRevisionId),
							relationshipType: bodyStr(body.relationshipType) ?? '',
							direction: body.direction as
								| 'directed'
								| 'undirected'
								| undefined,
							notes: bodyStr(body.notes),
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof LinkValidationError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/knowledge/links/:linkId/deactivate', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				try {
					await deactivateLink(sql, principal, ctx.params.linkId, ctx.traceId)
					return { id: ctx.params.linkId, active: false }
				} catch (err) {
					if (err instanceof LinkValidationError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.get('/knowledge/concepts/:id/links', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await listConceptLinks(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof LinkValidationError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 403
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/knowledge/revisions/:revisionId/span-links', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await linkSourceSpan(
						sql,
						principal,
						ctx.params.revisionId,
						{
							sourceSpanId: bodyStr(body.sourceSpanId) ?? '',
							relationshipType: bodyStr(body.relationshipType),
							quotationText: bodyStr(body.quotationText),
							notes: bodyStr(body.notes),
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof LinkValidationError) {
						ctx.set.status =
							err.code === 'NOT_FOUND' || err.code === 'LINK_TARGET_MISSING'
								? 404
								: 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.get('/knowledge/revisions/:revisionId/span-links', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await listSpanLinks(sql, principal, ctx.params.revisionId)
				} catch (err) {
					if (err instanceof LinkValidationError) {
						ctx.set.status = err.code === 'NOT_FOUND' ? 404 : 403
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/knowledge/revisions/:revisionId/notes', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const canNote =
					principal.permissions.includes('knowledge:draft') ||
					principal.permissions.includes('review:approve')
				if (!canNote) {
					throw new HttpError(403, 'forbidden', 'ROLE_NOT_AUTHORIZED_FOR_NOTES')
				}
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as { note?: string }
				if (!body.note || !body.note.trim()) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['note'] }
				}
				const res = await addReviewerNote(
					sql,
					principal,
					ctx.params.revisionId,
					body.note,
				)
				ctx.set.status = 201
				return res
			})
			.post('/knowledge/revisions/:revisionId/verify', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:approve')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as {
					verdict?: 'approved' | 'rejected'
					notes?: string
				}
				if (!body.verdict || !['approved', 'rejected'].includes(body.verdict)) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['verdict'] }
				}
				const res = await recordVerification(
					sql,
					principal,
					ctx.params.revisionId,
					body.verdict,
					body.notes,
				)
				ctx.set.status = 201
				return res
			})
			.get('/config/providers', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				await ctx.requirePermission('config:manage')
				return listProviders(sql)
			})
			.post('/config/providers', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await createProvider(
						sql,
						principal,
						{
							key: bodyStr(body.key) ?? '',
							provider: bodyStr(body.provider) ?? '',
							baseUrl: bodyStr(body.baseUrl) ?? '',
							secretRef: bodyStr(body.secretRef),
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/config/providers/:id/test', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				try {
					return await testProviderConnection(
						sql,
						principal,
						ctx.params.id,
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = err.code === 'PROVIDER_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/config/providers/:id/enabled', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as { enabled?: boolean }
				try {
					await setProviderEnabled(
						sql,
						principal,
						ctx.params.id,
						body.enabled === true,
						ctx.traceId,
					)
					return { id: ctx.params.id, enabled: body.enabled === true }
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = err.code === 'PROVIDER_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/config/providers/:id/models', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					const res = await addModel(
						sql,
						principal,
						ctx.params.id,
						{
							modelId: bodyStr(body.modelId) ?? '',
							contextWindow:
								typeof body.contextWindow === 'number'
									? body.contextWindow
									: undefined,
							capabilities: body.capabilities as
								| Record<string, unknown>
								| undefined,
						},
						ctx.traceId,
					)
					ctx.set.status = 201
					return res
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = err.code === 'PROVIDER_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.get('/config/aliases/:alias', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				await ctx.requirePermission('config:manage')
				const resolved = await resolveAlias(sql, ctx.params.alias)
				if (!resolved) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				return resolved
			})
			.put('/config/aliases/:alias', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await setAlias(
						sql,
						principal,
						ctx.params.alias,
						{
							targetType: body.targetType as 'provider' | 'model' | 'prompt',
							targetId: bodyStr(body.targetId) ?? '',
							changeReason: bodyStr(body.changeReason) ?? '',
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
			})
			.post('/config/aliases/:alias/rollback', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				try {
					return await rollbackAlias(
						sql,
						principal,
						ctx.params.alias,
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = 400
						return { error: err.code, message: errMessage(err) }
					}
					throw err
				}
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
