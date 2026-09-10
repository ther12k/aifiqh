import { createHash } from 'node:crypto'
import type { HealthReport, Permission, Principal } from '@aifiqh/shared'
/**
 * API composition root: trace middleware, health contract, auth guard, and
 * the source registry routes (RBAC-guarded, audit-logged).
 */
import { Elysia } from 'elysia'
import {
	AnswerTraceError,
	getAnswerGraph,
	publishAnswerWithPins,
} from './answers/answerTraceService'
import {
	ChatError,
	deleteConversation,
	getConversation,
	listConversations,
	postUserTurn,
	retryLastTurn,
	startConversation,
} from './answers/chatService'
import {
	ClaimReviewError,
	type ClaimVerdict,
	aggregateScholarlyReview,
	standingVerdicts,
	submitClaimReview,
} from './answers/claimReviewService'
import {
	EVIDENCE_PACK_VERSION,
	type EvidencePack,
	EvidencePackError,
	captureEvidencePack,
	verifyEvidencePackReplay,
} from './answers/evidencePackService'
import {
	type FeedbackCategory,
	FeedbackError,
	feedbackCategoryCounts,
	listAnswerFeedback,
	submitFeedback,
} from './answers/feedbackService'
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
	listFallbackChain,
	listModelOptions,
	listProviders,
	replaceFallbackChain,
	resolveAlias,
	rollbackAlias,
	setAlias,
	setProviderEnabled,
	testProviderConnection,
} from './config/configService'
import {
	FlagError,
	createRolloutRule,
	evaluateFlags,
	killSwitch,
	upsertFlag,
} from './config/flagService'
import {
	PromptConfigError,
	createPromptVersion,
	listPromptVersions,
	promotePromptVersion,
	resolvePromptForGeneration,
	rollbackPromptVersion,
} from './config/promptService'
import { type Sql as ScopedSql, scopedTransaction } from './db/client'
import type { Sql } from './db/client'
import { dbOk } from './db/client'
import {
	EvalCompareError,
	compareRuns,
	getComparison,
} from './eval/evalComparisonService'
import { EvalE2EError, runE2EEvaluation } from './eval/evalE2ERunner'
import {
	type ExportedCase,
	diffSetVersions,
	exportSetVersion,
	exportSetVersionCsv,
	importCases,
	parseExportedCasesCsv,
	seedSetVersion,
} from './eval/evalImportExport'
import {
	EvalRunError,
	runRetrievalEvaluation,
} from './eval/evalRetrievalRunner'
import {
	EvalSetError,
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
	getSetVersion,
	listSetVersions,
	publishSetVersion,
} from './eval/evalSetService'
import {
	GateError,
	PromotionBlockedError,
	evaluateLaunchGate,
	gateClearance,
	overrideGateFailure,
} from './eval/gateService'
import {
	EmbeddingError,
	embedIndexRelease,
	resolveEmbeddingProvider,
} from './index/embeddingService'
import { compileIncrementalIndexRelease } from './index/incrementalIndexer'
import {
	IndexAliasError,
	promoteIndexRelease,
	resolveIndexAlias,
	rollbackIndexAlias,
} from './index/indexAliasService'
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
import {
	CHAT_MODEL_ALIAS,
	maxChatAttempts,
	resolveChatModelDiagnostics,
} from './llm/modelRouter'
import type { Logger } from './logger'
import { getTracer, recordSpan } from './observability/otel'
import { newTraceId } from './observability/trace'
import {
	OcrCorrectionError,
	getOcrReview,
	restoreCorrection,
	saveCorrection,
} from './ocr/ocrCorrectionService'
import {
	OpsError,
	getOpsStatus,
	listFailureCodes,
	listOperationFailures,
	recordHealthEvent,
	recordOperationFailure,
} from './ops/opsStatusService'
import {
	decideResponse,
	storeResponseDecision,
} from './retrieval/abstentionPolicy'
import { AccessPolicyError, ScopedResultCache } from './retrieval/accessPolicy'
import {
	CONTEXT_PROFILES,
	type ContextProfileKind,
	buildContext,
	storeContextManifest,
} from './retrieval/contextBuilder'
import {
	type AssessmentOutcome,
	assessEvidenceFromPipeline,
	storeEvidenceAssessment,
} from './retrieval/evidenceAssessment'
import { expandEvidenceContext } from './retrieval/evidenceExpansion'
import { InspectorError, getInspectorTrace } from './retrieval/inspectorService'
import {
	type LaneExecutionOutcome,
	executeLanePlan,
} from './retrieval/laneFusion'
import { planAndPersistQuery } from './retrieval/queryPlanner'
import { HashRerankerProvider } from './retrieval/reranker'
import { LaneError, type LexicalFilters } from './retrieval/retrievalLanes'
import {
	type ImportBatchInput,
	validateAndRecordImport,
} from './sources/importValidation'
import { resolveSpan } from './sources/spanResolver'
import { contentKey, getObject, headObject, putObject } from './storage/s3'
import {
	getStudioDashboard,
	listBrokenLinks,
	listFailedJobs,
} from './studio/dashboardService'

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

// retrieval result cache — entries are namespaced by tenant + scope-set
// identity, so a cached result can never be served across scope boundaries
const retrievalCache = new ScopedResultCache<LaneExecutionOutcome>(30_000)

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
			// no route matched (e.g. /config/.env probes): a plain 404 is the
			// honest answer — not a 500 that logs noise on every probe
			if (
				err instanceof Error &&
				(err.name === 'NotFoundError' || err.message === 'Not Found')
			) {
				ctx.set.status = 404
				return { error: 'not_found' }
			}
			log.error('unhandled error', { error: err })
			ctx.set.status = 500
			return { error: 'internal_error' }
		})
		.derive((ctx) => {
			const traceId = (ctx.store as RequestStore).traceId
			return {
				traceId,
				/** Signed double-submit CSRF: header equals the cookie AND the
				 * cookie verifies against the session secret (OWASP variant). */
				requireCsrf(): void {
					const cookies = parseCookies(ctx.request.headers.get('cookie'))
					if (
						!verifyCsrf(
							ctx.request.headers.get(CSRF_HEADER),
							cookies.aifiqh_csrf,
							cfg.sessionSecret,
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

// DB-039 acquisition & usage-policy registry vocabularies
const ACQUISITION_METHODS = [
	'bulk_file',
	'api',
	'repository_snapshot',
	'approved_crawl',
	'manual_entry',
] as const
const ALLOWED_USES = [
	'display',
	'storage',
	'rag',
	'export',
	'model_training',
] as const

interface AcquisitionValues {
	acquisition_method: string | null
	policy_reference: string | null
	policy_checked_at: string | null
	allowed_uses: string[] | null
	retention_policy: string | null
	update_policy: string | null
	parser_version: string | null
}

/**
 * Parse the optional acquisition/policy registry fields (DB-039). Absent
 * fields stay null — 'unknown' must remain expressible. Provided values are
 * validated against the controlled vocabularies; violations come back as
 * invalid field names for the 400 body.
 */
function parseAcquisitionInput(body: Record<string, unknown>): {
	invalid: string[]
	values: AcquisitionValues
} {
	const invalid: string[] = []
	const str = (key: string, out: string): string | null => {
		const v = body[key]
		if (v === undefined || v === null) return null
		if (typeof v !== 'string' || !v.trim()) {
			invalid.push(out)
			return null
		}
		return v.trim()
	}
	let acquisitionMethod = str('acquisitionMethod', 'acquisitionMethod')
	if (
		acquisitionMethod &&
		!ACQUISITION_METHODS.includes(
			acquisitionMethod as (typeof ACQUISITION_METHODS)[number],
		)
	) {
		invalid.push('acquisitionMethod')
		acquisitionMethod = null
	}
	let allowedUses: string[] | null = null
	if (body.allowedUses !== undefined && body.allowedUses !== null) {
		if (
			Array.isArray(body.allowedUses) &&
			body.allowedUses.every((u) => typeof u === 'string') &&
			body.allowedUses.length > 0 &&
			body.allowedUses.every((u) =>
				ALLOWED_USES.includes(u as (typeof ALLOWED_USES)[number]),
			)
		) {
			allowedUses = body.allowedUses as string[]
		} else {
			invalid.push('allowedUses')
		}
	}
	let policyCheckedAt = str('policyCheckedAt', 'policyCheckedAt')
	if (policyCheckedAt && Number.isNaN(Date.parse(policyCheckedAt))) {
		invalid.push('policyCheckedAt')
		policyCheckedAt = null
	}
	return {
		invalid,
		values: {
			acquisition_method: acquisitionMethod,
			policy_reference: str('policyReference', 'policyReference'),
			policy_checked_at: policyCheckedAt,
			allowed_uses: allowedUses,
			retention_policy: str('retentionPolicy', 'retentionPolicy'),
			update_policy: str('updatePolicy', 'updatePolicy'),
			parser_version: str('parserVersion', 'parserVersion'),
		},
	}
}

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
	acquisition_method: string | null
	policy_reference: string | null
	policy_checked_at: string | null
	allowed_uses: string[] | null
	retention_policy: string | null
	update_policy: string | null
	parser_version: string | null
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
				const acquisition = parseAcquisitionInput(body)
				if (missing.length > 0 || acquisition.invalid.length > 0) {
					ctx.set.status = 400
					return {
						error: 'validation_failed',
						fields: [...missing, ...acquisition.invalid],
					}
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
             rights_status, access_scope_id, created_by,
             acquisition_method, policy_reference, policy_checked_at,
             allowed_uses, retention_policy, update_policy, parser_version)
          values
            (${principal.tenantId}::uuid, ${body.title as string}, ${body.author as string},
             ${body.sourceType as string}, ${body.language as string},
             ${(body.edition as string) || null}, ${(body.publisher as string) || null},
             ${body.rightsStatus as string}, ${body.accessScopeId as string}::uuid,
             ${principal.userId}::uuid,
             ${acquisition.values.acquisition_method},
             ${acquisition.values.policy_reference},
             ${acquisition.values.policy_checked_at},
             ${acquisition.values.allowed_uses ?? []}::text[],
             ${acquisition.values.retention_policy},
             ${acquisition.values.update_policy},
             ${acquisition.values.parser_version})
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
				const acquisition = parseAcquisitionInput(body)
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
					acquisition_method: acquisition.values.acquisition_method,
					policy_reference: acquisition.values.policy_reference,
					policy_checked_at: acquisition.values.policy_checked_at,
					allowed_uses: acquisition.values.allowed_uses,
					retention_policy: acquisition.values.retention_policy,
					update_policy: acquisition.values.update_policy,
					parser_version: acquisition.values.parser_version,
				}
				if (acquisition.invalid.length > 0) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: acquisition.invalid }
				}
				if (Object.values(patch).every((v) => v === null)) {
					ctx.set.status = 400
					return {
						error: 'validation_failed',
						fields: [
							'title|author|language|edition|publisher|rightsStatus',
							'| acquisition/policy fields (DB-039)',
						],
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
						rights_status = coalesce(${patch.rights_status}, rights_status),
						acquisition_method = coalesce(${patch.acquisition_method}, acquisition_method),
						policy_reference = coalesce(${patch.policy_reference}, policy_reference),
						policy_checked_at = coalesce(${patch.policy_checked_at}, policy_checked_at),
						allowed_uses = coalesce(${patch.allowed_uses}, allowed_uses),
						retention_policy = coalesce(${patch.retention_policy}, retention_policy),
						update_policy = coalesce(${patch.update_policy}, update_policy),
						parser_version = coalesce(${patch.parser_version}, parser_version)
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
							afterRef: {
								title: a.title,
								rights_status: a.rights_status,
								acquisition_method: a.acquisition_method,
								policy_reference: a.policy_reference,
								allowed_uses: a.allowed_uses,
							},
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
					// the object is fully written BEFORE any revision row exists,
					// so a failed/interrupted upload leaves nothing behind; and a
					// landed revision is only pending_review — nothing an upload
					// does can ever produce an answerable revision (#108)
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
							values (${src.id}::uuid, ${(max?.n ?? 0) + 1}, 'pending_review', ${principal.userId}::uuid)
							returning id, revision_number`
								await tx`
							insert into source_files
								(source_revision_id, sha256, storage_key, mime_type, size_bytes)
							values
								(${rev.id}::uuid, ${sha256}, ${key},
								 ${ctx.request.headers.get('content-type') ?? 'application/octet-stream'},
								 ${buf.length})`
								// the revision lands directly in pending_review: upload +
								// storage IS the ingest step here, and the event trail
								// records how it got there
								await tx`
							insert into source_revision_status_events
								(source_revision_id, from_status, to_status, actor_type, actor_id, reason)
							values (${rev.id}::uuid, 'processing', 'pending_review', 'user', ${principal.userId}, 'ingest complete — awaiting editorial review')`
								await recordAuditInTx(tx, {
									tenantId: principal.tenantId,
									actorType: 'user',
									actorId: principal.userId,
									action: 'source.revision_created',
									entityType: 'source_revision',
									entityId: rev.id,
									afterRef: {
										sha256,
										sizeBytes: buf.length,
										deduplicated,
										status: 'pending_review',
									},
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
					status: 'pending_review',
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
			// --- editorial approval gate (#108) ---
			// A revision only becomes answerable through a recorded human
			// decision. approve: pending_review → active. reject:
			// pending_review → deprecated. retire: active → deprecated with
			// a review trail. The DB trigger independently refuses any
			// activation without the review row written below.
			.post('/sources/:id/revisions/:revisionId/review', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:approve')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const decision = body.decision
				if (
					decision !== 'approve' &&
					decision !== 'reject' &&
					decision !== 'retire'
				) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['decision'] }
				}
				const note = typeof body.note === 'string' ? body.note.trim() : ''
				// a rejection/retirement without a stated reason is an
				// unexplainable editorial act — approvals may stand on the
				// inspected evidence alone
				if (decision !== 'approve' && !note) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['note'] }
				}
				const fromStatus = decision === 'retire' ? 'active' : 'pending_review'
				const toStatus = decision === 'approve' ? 'active' : 'deprecated'
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
						if (rev.status !== fromStatus) {
							return { code: 'invalid_state' as const, status: rev.status }
						}
						// the review row MUST land before the status update:
						// the activation trigger looks for it
						await tx`
							insert into source_revision_reviews
								(tenant_id, source_revision_id, decision, actor_type, actor_id, note)
							values (${principal.tenantId}::uuid, ${rev.id}::uuid,
								${decision}, 'user', ${principal.userId}, ${note || null})`
						await tx`
							update source_revisions
							set status = ${toStatus},
								deprecation_reason = ${decision === 'approve' ? null : note}
							where id = ${rev.id}::uuid`
						await tx`
							insert into source_revision_status_events
								(source_revision_id, from_status, to_status, actor_type, actor_id, reason)
							values (${rev.id}::uuid, ${fromStatus}, ${toStatus}, 'user',
								${principal.userId}, ${note || decision})`
						await recordAuditInTx(tx, {
							tenantId: principal.tenantId,
							actorType: 'user',
							actorId: principal.userId,
							action: 'source.revision_reviewed',
							entityType: 'source_revision',
							entityId: rev.id,
							beforeRef: { status: rev.status },
							afterRef: { status: toStatus, decision, note },
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
				return {
					revisionId: ctx.params.revisionId,
					decision,
					status: toStatus,
				}
			})
			.get('/sources/:id/revisions/:revisionId/reviews', async (rawCtx) => {
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
						const reviews = await tx<
							{
								id: string
								decision: string
								actor_id: string | null
								note: string | null
								created_at: string
							}[]
						>`
							select id, decision, actor_id, note, created_at
							from source_revision_reviews
							where source_revision_id = ${ctx.params.revisionId}::uuid
							order by created_at desc`
						return { code: 'ok' as const, reviews }
					},
				)
				if (result.code === 'not_found') {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				if (result.code === 'forbidden') {
					throw new HttpError(403, 'forbidden', result.reasonCode)
				}
				return { reviews: result.reviews }
			})
			// --- import validation gate (#118) ---
			// A corpus import batch is validated against the six acceptance
			// checks BEFORE it may enter the editorial queue; the run is
			// persisted either way and a rejected report means the importer
			// must not create revisions from it.
			.post('/imports/validate', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('source:create')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const src = (body.source ?? {}) as Record<string, unknown>
				const prov = (body.provider ?? {}) as Record<string, unknown>
				if (
					typeof src.title !== 'string' ||
					!src.title ||
					typeof prov.name !== 'string' ||
					!prov.name ||
					!Array.isArray(body.records)
				) {
					ctx.set.status = 400
					return {
						error: 'validation_failed',
						fields: ['source.title', 'provider.name', 'records'],
					}
				}
				const records = (body.records as Record<string, unknown>[]).map(
					(r) => ({
						providerRecordId:
							typeof r.providerRecordId === 'string' ? r.providerRecordId : '',
						sourceLocator:
							typeof r.sourceLocator === 'string' ? r.sourceLocator : null,
						originalText:
							typeof r.originalText === 'string' ? r.originalText : '',
						translationText:
							typeof r.translationText === 'string' ? r.translationText : null,
						translator: typeof r.translator === 'string' ? r.translator : null,
						grading: typeof r.grading === 'string' ? r.grading : null,
					}),
				)
				const batch: ImportBatchInput = {
					source: {
						title: src.title,
						author: typeof src.author === 'string' ? src.author : '',
						sourceType:
							typeof src.sourceType === 'string' ? src.sourceType : 'book',
						language: typeof src.language === 'string' ? src.language : 'ar',
						rightsStatus:
							typeof src.rightsStatus === 'string'
								? src.rightsStatus
								: 'unknown',
					},
					provider: {
						name: prov.name,
						edition: typeof prov.edition === 'string' ? prov.edition : null,
						acquisitionVersion:
							typeof prov.acquisitionVersion === 'string'
								? prov.acquisitionVersion
								: null,
					},
					acquisitionMethod:
						typeof body.acquisitionMethod === 'string'
							? body.acquisitionMethod
							: null,
					policyReference:
						typeof body.policyReference === 'string'
							? body.policyReference
							: null,
					policyCheckedAt:
						typeof body.policyCheckedAt === 'string'
							? body.policyCheckedAt
							: null,
					expectedCount:
						typeof body.expectedCount === 'number' ? body.expectedCount : null,
					records,
					withdrawnRecordIds: Array.isArray(body.withdrawnRecordIds)
						? (body.withdrawnRecordIds as string[])
						: undefined,
					baselineRecords:
						typeof body.baselineRecords === 'object' &&
						body.baselineRecords !== null
							? (body.baselineRecords as Record<string, string>)
							: null,
				}
				const outcome = await validateAndRecordImport(sql, principal, batch)
				// 422: the batch is well-formed but fails the import contract —
				// it must not proceed to the review queue
				ctx.set.status = outcome.ok ? 200 : 422
				return {
					runId: outcome.runId,
					ok: outcome.ok,
					report: outcome.report,
				}
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
					const gate = (body.gate ?? {}) as Record<string, unknown>
					return await publishChangeset(
						sql,
						principal,
						ctx.params.id,
						{
							alias,
							gate: {
								retrievalRunId: bodyStr(gate.retrievalRunId) ?? null,
								e2eRunId: bodyStr(gate.e2eRunId) ?? null,
								comparisonId: bodyStr(gate.comparisonId) ?? null,
							},
						},
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof PromotionBlockedError) {
						ctx.set.status = 422
						return {
							error: 'PROMOTION_BLOCKED',
							message: err.message,
							reasonCode: err.reasonCode,
							reasons: err.reasons,
							gateResultId: err.gateResultId,
						}
					}
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
				// RAG-SEM-001: embedding requires a configured provider binding;
				// the deterministic hash provider is test/local-only and is
				// REFUSED in require mode instead of silently hashing
				try {
					const resolution = await resolveEmbeddingProvider(
						sql,
						principal.tenantId,
						ctx.params.id,
						{ purpose: 'index' },
					)
					if (resolution.status === 'unavailable') {
						ctx.set.status =
							resolution.reason === 'release_not_found' ? 404 : 503
						return {
							error: `EMBEDDING_${resolution.reason.toUpperCase()}`,
							message: resolution.message,
						}
					}
					return await embedIndexRelease(
						sql,
						principal,
						ctx.params.id,
						resolution.provider,
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
					// RAG-SEM-001: refused embedding (no binding configured,
					// missing secret) fails the incremental build loudly
					if (err instanceof EmbeddingError) {
						ctx.set.status = 503
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/releases/:id/promote', async (rawCtx) => {
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
					return await promoteIndexRelease(
						sql,
						principal,
						ctx.params.id,
						alias,
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof PromotionBlockedError) {
						ctx.set.status = 422
						return {
							error: 'PROMOTION_BLOCKED',
							message: err.message,
							reasonCode: err.reasonCode,
							reasons: err.reasons,
							gateResultId: err.gateResultId,
						}
					}
					if (err instanceof IndexAliasError) {
						ctx.set.status =
							err.code === 'RELEASE_NOT_FOUND'
								? 404
								: err.code === 'ALREADY_CURRENT'
									? 409
									: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/index/aliases/:alias/rollback', async (rawCtx) => {
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
					return await rollbackIndexAlias(
						sql,
						principal,
						ctx.params.alias as 'staging' | 'production',
						bodyStr(body.targetReleaseId) ?? '',
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof IndexAliasError) {
						ctx.set.status = err.code === 'RELEASE_NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/index/aliases/:alias', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				if (
					ctx.params.alias !== 'staging' &&
					ctx.params.alias !== 'production'
				) {
					ctx.set.status = 400
					return { error: 'ALIAS_INVALID', message: 'unknown alias' }
				}
				const resolved = await resolveIndexAlias(
					sql,
					principal,
					ctx.params.alias as 'staging' | 'production',
				)
				if (!resolved) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				return resolved
			})
			.post('/retrieval/plan', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				return planAndPersistQuery(
					sql,
					principal,
					{
						originalQuery: bodyStr(body.query) ?? '',
						indexReleaseId: bodyStr(body.indexReleaseId),
						requestedScope: bodyStrArray(body.requestedScope),
						requestedMadhhab: bodyStrArray(body.requestedMadhhab),
						mode: body.mode as
							| 'grounded_only'
							| 'allow_general_knowledge'
							| undefined,
						conversationId: bodyStr(body.conversationId),
					},
					ctx.traceId,
				)
			})
			.get('/conversations', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return await scopedTransaction(sql, principal.tenantId, (tx) =>
					listConversations(tx, principal),
				)
			})
			.post('/conversations', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				ctx.set.status = 201
				return await scopedTransaction(sql, principal.tenantId, (tx) =>
					startConversation(tx, principal, bodyStr(body.title) ?? null),
				)
			})
			.post('/messages/:id/feedback', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const category = bodyStr(body.category) as FeedbackCategory | undefined
				if (!category) {
					ctx.set.status = 400
					return { error: 'CATEGORY_REQUIRED', message: 'category is required' }
				}
				try {
					// feedback reads conversations/messages under RLS — must run
					// with the tenant context set or the join sees zero rows
					return await scopedTransaction(sql, principal.tenantId, (tx) =>
						submitFeedback(tx, principal, {
							messageId: ctx.params.id,
							category,
							details: bodyStr(body.details),
							citationRef: bodyStr(body.citationRef),
						}),
					)
				} catch (err) {
					if (err instanceof FeedbackError) {
						ctx.set.status =
							err.code === 'MESSAGE_NOT_FOUND'
								? 404
								: err.code === 'RATE_LIMITED'
									? 429
									: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/answers/:id/feedback', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return scopedTransaction(sql, principal.tenantId, (tx) =>
					listAnswerFeedback(tx, principal, ctx.params.id),
				)
			})
			.get('/feedback/summary', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return scopedTransaction(sql, principal.tenantId, (tx) =>
					feedbackCategoryCounts(tx, principal),
				)
			})
			.get('/conversations/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await scopedTransaction(sql, principal.tenantId, (tx) =>
						getConversation(tx, principal, ctx.params.id),
					)
				} catch (err) {
					if (err instanceof ChatError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.delete('/conversations/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				try {
					return await scopedTransaction(sql, principal.tenantId, (tx) =>
						deleteConversation(tx, principal, ctx.params.id),
					)
				} catch (err) {
					if (err instanceof ChatError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/conversations/:id/messages', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const content = bodyStr(body.content) ?? ''
				if (!content.trim()) {
					ctx.set.status = 400
					return { error: 'CONTENT_REQUIRED', message: 'content is required' }
				}
				try {
					return await scopedTransaction(sql, principal.tenantId, (tx) =>
						postUserTurn(tx, principal, {
							conversationId: ctx.params.id,
							content,
							indexReleaseId: bodyStr(body.indexReleaseId),
							madhhab: bodyStrArray(body.madhhab),
							ensureMadhhab: bodyStrArray(body.ensureMadhhab),
							contextProfile: bodyStr(body.contextProfile) as
								| 'exact'
								| 'standard'
								| 'comparative'
								| 'research'
								| 'document_audit'
								| undefined,
							mode: body.mode as
								| 'grounded_only'
								| 'allow_general_knowledge'
								| undefined,
						}),
					)
				} catch (err) {
					if (err instanceof ChatError) {
						ctx.set.status = err.code === 'CONVERSATION_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/conversations/:id/retry', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await scopedTransaction(sql, principal.tenantId, (tx) =>
						retryLastTurn(tx, principal, ctx.params.id, {
							indexReleaseId: bodyStr(body.indexReleaseId),
							madhhab: bodyStrArray(body.madhhab),
							ensureMadhhab: bodyStrArray(body.ensureMadhhab),
							contextProfile: bodyStr(body.contextProfile) as
								| 'exact'
								| 'standard'
								| 'comparative'
								| 'research'
								| 'document_audit'
								| undefined,
							mode: body.mode as
								| 'grounded_only'
								| 'allow_general_knowledge'
								| undefined,
						}),
					)
				} catch (err) {
					if (err instanceof ChatError) {
						ctx.set.status = err.code === 'CONVERSATION_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/answers/:id/graph', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await getAnswerGraph(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof AnswerTraceError) {
						ctx.set.status = err.code === 'ANSWER_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			// --- Reviewer workspace endpoints (#110 / #119) ---
			.get('/reviewer/queue', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:approve')
				const rows = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						return await tx<
							{
								answer_id: string
								conversation_id: string
								created_at: string
								question: string | null
								claim_count: number
								reviewed_claim_count: number
							}[]
						>`
							select a.id as answer_id, cv.id as conversation_id, a.created_at::text,
								(select content from messages where conversation_id = cv.id and role = 'user' order by ordinal asc limit 1) as question,
								(select count(*)::int from answer_claims ac where ac.answer_id = a.id) as claim_count,
								(select count(distinct cr.claim_id)::int from claim_reviews cr where cr.answer_id = a.id) as reviewed_claim_count
							from answers a
							join messages m on m.id = a.message_id
							join conversations cv on cv.id = m.conversation_id
							where cv.tenant_id = ${principal.tenantId}::uuid
							order by a.created_at desc limit 50`
					},
				)
				return { queue: rows }
			})
			.get('/answers/:id/claims', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const answerId = ctx.params.id

				const data = await scopedTransaction(
					sql,
					principal.tenantId,
					async (tx) => {
						const [ans] = await tx<
							{
								id: string
								conversation_id: string
								created_at: string
								question: string | null
								answer_text: string | null
							}[]
						>`
							select a.id, cv.id as conversation_id, a.created_at::text,
								(select content from messages where conversation_id = cv.id and role = 'user' order by ordinal asc limit 1) as question,
								m.content as answer_text
							from answers a
							join messages m on m.id = a.message_id
							join conversations cv on cv.id = m.conversation_id
							where a.id = ${answerId}::uuid and cv.tenant_id = ${principal.tenantId}::uuid
							limit 1`
						if (!ans) return null

						const claims = await tx<
							{
								id: string
								claim_text: string
								claim_kind: string
								ordinal: number
							}[]
						>`
							select id, claim_text, claim_kind, ordinal
							from answer_claims where answer_id = ${answerId}::uuid order by ordinal asc`

						const evidence = await tx<
							{
								claim_id: string
								evidence_id: string
								unit_id: string | null
								span_id: string | null
								span_key: string | null
								original_text: string | null
								authority_type: string | null
								madhhab: string[] | null
								stance: string | null
								grading: string | null
								grading_by: string | null
								source_title: string | null
								source_author: string | null
							}[]
						>`
							select ce.claim_id, ce.id as evidence_id, ce.unit_id,
								ss.id as span_id, ss.span_key, ss.original_text, ss.authority_type,
								ss.madhhab, ss.stance, ss.grading, ss.grading_by,
								s.title as source_title, s.author as source_author
							from claim_evidence ce
							join answer_claims ac on ac.id = ce.claim_id
							left join retrieval_units ru on ru.id = ce.unit_id
							left join source_spans ss on ss.id = ru.source_span_id
							left join source_revisions sr on sr.id = ss.source_revision_id
							left join sources s on s.id = sr.source_id
							where ac.answer_id = ${answerId}::uuid`

						const verdicts = await standingVerdicts(tx, principal, answerId)
						const verdictByClaim = new Map(verdicts.map((v) => [v.claimId, v]))

						const evidenceByClaim = new Map<
							string,
							Array<(typeof evidence)[number]>
						>()
						for (const e of evidence) {
							const list = evidenceByClaim.get(e.claim_id) ?? []
							list.push(e)
							evidenceByClaim.set(e.claim_id, list)
						}

						const materialCount = claims.length
						const scholarlyReview = aggregateScholarlyReview(
							verdicts,
							materialCount,
						)

						return {
							answerId: ans.id,
							conversationId: ans.conversation_id,
							createdAt: ans.created_at,
							question: ans.question ?? 'Tanya jawab fiqih',
							answerText: ans.answer_text,
							scholarlyReview,
							claims: claims.map((c) => ({
								id: c.id,
								text: c.claim_text,
								kind: c.claim_kind,
								ordinal: c.ordinal,
								standingVerdict: verdictByClaim.get(c.id) ?? null,
								evidence: (evidenceByClaim.get(c.id) ?? []).map((ev) => ({
									evidenceId: ev.evidence_id,
									unitId: ev.unit_id,
									spanId: ev.span_id,
									spanKey: ev.span_key,
									originalText: ev.original_text,
									authorityType: ev.authority_type,
									madhhab: ev.madhhab ?? [],
									stance: ev.stance,
									grading: ev.grading,
									gradingBy: ev.grading_by,
									sourceTitle: ev.source_title,
									sourceAuthor: ev.source_author,
								})),
							})),
						}
					},
				)

				if (!data) {
					ctx.set.status = 404
					return { error: 'not_found' }
				}
				return data
			})
			.post('/answers/:id/claims/:claimId/review', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:approve')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const verdict = body.verdict as ClaimVerdict
				if (
					verdict !== 'approve' &&
					verdict !== 'reject' &&
					verdict !== 'correct'
				) {
					ctx.set.status = 400
					return { error: 'validation_failed', fields: ['verdict'] }
				}
				try {
					const result = await scopedTransaction(
						sql,
						principal.tenantId,
						(tx) =>
							submitClaimReview(tx, principal, {
								answerId: ctx.params.id,
								claimId: ctx.params.claimId,
								verdict,
								note: typeof body.note === 'string' ? body.note : null,
								correctedText:
									typeof body.correctedText === 'string'
										? body.correctedText
										: null,
							}),
					)
					return result
				} catch (err) {
					if (err instanceof ClaimReviewError) {
						ctx.set.status = err.code === 'CLAIM_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/config/prompts/:templateKey/versions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await createPromptVersion(sql, principal, {
						templateKey: ctx.params.templateKey,
						body: bodyStr(body.body) ?? '',
						variables: (body.variables ?? []) as Array<{
							name: string
							required: boolean
						}>,
						description: bodyStr(body.description),
					})
				} catch (err) {
					if (err instanceof PromptConfigError) {
						ctx.set.status = err.code === 'VARIABLES_INVALID' ? 422 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/config/prompts/:templateKey/versions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return listPromptVersions(sql, ctx.params.templateKey)
			})
			.post('/config/prompts/versions/:id/promote', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				try {
					return await promotePromptVersion(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof PromptConfigError) {
						ctx.set.status = 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/config/prompts/versions/:id/rollback', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await rollbackPromptVersion(
						sql,
						principal,
						ctx.params.id,
						bodyStr(body.reason) ?? '',
					)
				} catch (err) {
					if (err instanceof PromptConfigError) {
						ctx.set.status = err.code === 'REASON_REQUIRED' ? 422 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/config/prompts/:templateKey/effective', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const resolved = await resolvePromptForGeneration(
					sql,
					ctx.params.templateKey,
				)
				if (!resolved) {
					ctx.set.status = 404
					return { error: 'NO_PROMOTED_VERSION' }
				}
				return resolved
			})
			.put('/config/flags/:key', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await upsertFlag(
						sql,
						principal,
						ctx.params.key,
						bodyStr(body.description) ?? '',
						body.enabledByDefault === true,
					)
				} catch (err) {
					if (err instanceof FlagError) {
						ctx.set.status = 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/config/flags/:key/rules', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const segment = (body.segment ?? {}) as {
					kill_switch?: boolean
					roles?: string[]
				}
				try {
					return await createRolloutRule(sql, principal, {
						flagKey: ctx.params.key,
						percentage: Number(body.percentage ?? 0),
						tenantId: bodyStr(body.tenantId),
						segment,
						priority: Number(body.priority ?? 0),
					})
				} catch (err) {
					if (err instanceof FlagError) {
						ctx.set.status =
							err.code === 'PERCENTAGE_INVALID' ||
							err.code === 'SEGMENT_INVALID'
								? 422
								: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/config/flags/:key/kill', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				try {
					return await killSwitch(sql, principal, ctx.params.key)
				} catch (err) {
					if (err instanceof FlagError) {
						ctx.set.status = err.code === 'FORBIDDEN' ? 403 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/studio/dashboard', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				return getStudioDashboard(sql, principal)
			})
			.get('/studio/failed-jobs', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const url = new URL(ctx.request.url)
				return listFailedJobs(sql, principal, {
					limit: Number(url.searchParams.get('limit') ?? '') || undefined,
					offset: Number(url.searchParams.get('offset') ?? '') || undefined,
				})
			})
			.get('/studio/broken-links', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const url = new URL(ctx.request.url)
				return listBrokenLinks(sql, principal, {
					limit: Number(url.searchParams.get('limit') ?? '') || undefined,
					offset: Number(url.searchParams.get('offset') ?? '') || undefined,
				})
			})
			.get('/ops/status', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('ops:read')
				return getOpsStatus(sql, principal)
			})
			.post('/eval/sets', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await createEvaluationSet(sql, principal, {
						key: bodyStr(body.key) ?? '',
						description: bodyStr(body.description),
						ownerUserId: bodyStr(body.ownerUserId),
					})
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/sets/:id/versions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				try {
					return await createSetVersion(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = err.code === 'SET_NOT_FOUND' ? 404 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/sets/:id/versions', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return {
						versions: await listSetVersions(sql, principal, ctx.params.id),
					}
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/set-versions/:id/cases', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await addEvaluationCase(sql, principal, ctx.params.id, {
						caseKey: bodyStr(body.caseKey) ?? '',
						category: bodyStr(body.category) ?? '',
						queryText: bodyStr(body.queryText) ?? '',
						language: bodyStr(body.language),
						riskLevel: bodyStr(body.riskLevel),
						conversation: (body.conversation ?? null) as Record<
							string,
							unknown
						> | null,
						expectedBehavior: (body.expectedBehavior ?? {}) as Record<
							string,
							unknown
						>,
						expectedEvidence: (body.expectedEvidence ?? []) as Array<{
							sourceRevisionId?: string | null
							spanId?: string | null
							knowledgeRevisionId?: string | null
							mustInclude?: boolean
						}>,
						ownerUserId: bodyStr(body.ownerUserId) ?? principal.userId,
						reviewerUserId: bodyStr(body.reviewerUserId),
					})
				} catch (err) {
					if (err instanceof EvalSetError) {
						const unprocessable = [
							'CATEGORY_INVALID',
							'RISK_INVALID',
							'EXPECTATION_REQUIRED',
							'SOURCE_REVISION_NOT_FOUND',
							'SPAN_REVISION_MISMATCH',
							'SPAN_WITHOUT_REVISION',
							'KNOWLEDGE_REVISION_NOT_FOUND',
						]
						ctx.set.status = unprocessable.includes(err.code)
							? 422
							: err.code === 'VERSION_NOT_FOUND'
								? 404
								: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/set-versions/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await getSetVersion(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/set-versions/:id/publish', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				try {
					return await publishSetVersion(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status =
							err.code === 'VERSION_NOT_FOUND'
								? 404
								: err.code === 'EMPTY_VERSION'
									? 422
									: 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/set-versions/:id/export', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const url = new URL(ctx.request.url)
				try {
					const detail = await getSetVersion(sql, principal, ctx.params.id)
					if (url.searchParams.get('format') === 'csv') {
						return new Response(exportSetVersionCsv(detail), {
							headers: { 'content-type': 'text/csv; charset=utf-8' },
						})
					}
					return exportSetVersion(detail)
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/sets/:id/import', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					let cases: ExportedCase[]
					if (typeof body.csv === 'string') {
						cases = parseExportedCasesCsv(body.csv)
					} else if (Array.isArray(body.cases)) {
						cases = body.cases
					} else {
						ctx.set.status = 400
						return { error: 'IMPORT_EMPTY', message: 'provide cases[] or csv' }
					}
					return await importCases(sql, principal, ctx.params.id, cases, {
						ownerUserId: bodyStr(body.ownerUserId) ?? principal.userId,
						reviewerUserId: bodyStr(body.reviewerUserId),
					})
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status =
							err.code === 'SET_NOT_FOUND' || err.code === 'VERSION_NOT_FOUND'
								? 404
								: 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/sets/:id/seed', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:draft')
				ctx.requireCsrf()
				try {
					return await seedSetVersion(sql, principal, ctx.params.id, {
						ownerUserId: principal.userId,
					})
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = err.code === 'SET_NOT_FOUND' ? 404 : 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/set-versions/:id/diff/:otherId', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					const from = await getSetVersion(sql, principal, ctx.params.id)
					const to = await getSetVersion(sql, principal, ctx.params.otherId)
					return diffSetVersions(from, to)
				} catch (err) {
					if (err instanceof EvalSetError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/set-versions/:id/run-retrieval', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await runRetrievalEvaluation(sql, principal, {
						setVersionId: ctx.params.id,
						indexReleaseId: bodyStr(body.indexReleaseId) ?? '',
						knowledgeReleaseId: bodyStr(body.knowledgeReleaseId),
						k: Number(body.k ?? '') || undefined,
					})
				} catch (err) {
					if (err instanceof EvalRunError) {
						ctx.set.status = err.code === 'EMPTY_VERSION' ? 422 : 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/set-versions/:id/run-e2e', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await runE2EEvaluation(sql, principal, {
						setVersionId: ctx.params.id,
						indexReleaseId: bodyStr(body.indexReleaseId) ?? '',
						madhhab: Array.isArray(body.madhhab)
							? (body.madhhab as string[])
							: undefined,
						mode:
							body.mode === 'allow_general_knowledge'
								? 'allow_general_knowledge'
								: 'grounded_only',
					})
				} catch (err) {
					if (err instanceof EvalE2EError) {
						ctx.set.status = err.code === 'EMPTY_VERSION' ? 422 : 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/runs/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const [run] = await sql<
					{
						id: string
						set_version_id: string
						mode: string
						pins: Record<string, unknown>
						status: string
						report: Record<string, unknown>
						started_at: string
						finished_at: string | null
					}[]
				>`select r.id, r.set_version_id::text, r.mode, r.pins, r.status,
						r.report, r.started_at, r.finished_at
					from evaluation_runs r
					join evaluation_set_versions v on v.id = r.set_version_id
					join evaluation_sets s on s.id = v.set_id
					where r.id = ${ctx.params.id}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
				if (!run) {
					ctx.set.status = 404
					return { error: 'RUN_NOT_FOUND' }
				}
				return {
					id: run.id,
					setVersionId: run.set_version_id,
					mode: run.mode,
					pins: run.pins,
					status: run.status,
					report: run.report,
					startedAt: run.started_at,
					finishedAt: run.finished_at,
				}
			})
			.post('/eval/compare', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await compareRuns(sql, principal, {
						baselineRunId: bodyStr(body.baselineRunId) ?? '',
						candidateRunId: bodyStr(body.candidateRunId) ?? '',
						caseMap: (body.caseMap ?? undefined) as
							| Record<string, string>
							| undefined,
					})
				} catch (err) {
					if (err instanceof EvalCompareError) {
						ctx.set.status = err.code === 'RUN_NOT_FOUND' ? 404 : 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/comparisons/:id', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await getComparison(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof EvalCompareError) {
						ctx.set.status = 404
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/eval/gates/evaluate', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await evaluateLaunchGate(sql, principal, {
						policyKey: bodyStr(body.policyKey) ?? undefined,
						subjectType: (bodyStr(body.subjectType) ?? 'knowledge_release') as
							| 'knowledge_release'
							| 'index_release'
							| 'config',
						subjectId: bodyStr(body.subjectId) ?? '',
						retrievalRunId: bodyStr(body.retrievalRunId) ?? null,
						e2eRunId: bodyStr(body.e2eRunId) ?? null,
						comparisonId: bodyStr(body.comparisonId) ?? null,
					})
				} catch (err) {
					if (err instanceof GateError) {
						ctx.set.status =
							err.code === 'POLICY_NOT_FOUND' || err.code === 'RUN_NOT_FOUND'
								? 404
								: 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/eval/gates/clearance', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const url = new URL(ctx.request.url)
				return gateClearance(sql, principal, {
					policyKey: url.searchParams.get('policyKey') ?? undefined,
					subjectType:
						url.searchParams.get('subjectType') ?? 'knowledge_release',
					subjectId: url.searchParams.get('subjectId') ?? '',
				})
			})
			.post('/eval/gates/:id/override', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await overrideGateFailure(sql, principal, {
						gateResultId: ctx.params.id,
						reason: bodyStr(body.reason) ?? '',
					})
				} catch (err) {
					if (err instanceof GateError) {
						ctx.set.status = err.code === 'FORBIDDEN' ? 403 : 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/ops/failures', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('ops:read')
				const url = new URL(ctx.request.url)
				try {
					return await listOperationFailures(sql, principal, {
						subsystem: url.searchParams.get('subsystem') ?? undefined,
						severity: url.searchParams.get('severity') ?? undefined,
						component: url.searchParams.get('component') ?? undefined,
						limit: Number(url.searchParams.get('limit') ?? '') || undefined,
						offset: Number(url.searchParams.get('offset') ?? '') || undefined,
					})
				} catch (err) {
					if (err instanceof OpsError) {
						ctx.set.status = 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/ops/failure-codes', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				await ctx.requirePermission('ops:read')
				return { codes: await listFailureCodes(sql) }
			})
			.post('/ops/health-events', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('ops:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await recordHealthEvent(sql, {
						componentKey: bodyStr(body.componentKey) ?? '',
						status: bodyStr(body.status) ?? '',
						detail: body.detail,
					})
				} catch (err) {
					if (err instanceof OpsError) {
						ctx.set.status = err.code === 'STATUS_INVALID' ? 422 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/ops/failures', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('ops:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				try {
					return await recordOperationFailure(sql, {
						componentKey: bodyStr(body.componentKey) ?? '',
						failureCode: bodyStr(body.failureCode) ?? '',
						severity: bodyStr(body.severity) ?? '',
						message: bodyStr(body.message) ?? '',
						traceId: bodyStr(body.traceId),
						entityRef: (body.entityRef ?? null) as Record<
							string,
							unknown
						> | null,
					})
				} catch (err) {
					if (err instanceof OpsError) {
						ctx.set.status = err.code === 'SEVERITY_INVALID' ? 422 : 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/retrieval/traces/:id/inspector', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				const url = new URL(ctx.request.url)
				const limitParam = Number(url.searchParams.get('limit') ?? '')
				const offsetParam = Number(url.searchParams.get('offset') ?? '')
				try {
					return await getInspectorTrace(sql, principal, ctx.params.id, {
						limit: Number.isFinite(limitParam) ? limitParam : undefined,
						offset: Number.isFinite(offsetParam) ? offsetParam : undefined,
					})
				} catch (err) {
					if (err instanceof InspectorError) {
						ctx.set.status = err.code === 'TRACE_NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.get('/answers/:id/evidence-pack', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				try {
					return await captureEvidencePack(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof EvidencePackError) {
						ctx.set.status = err.code === 'ANSWER_NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/answers/:id/evidence-pack/verify', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const pack = body.pack as EvidencePack | undefined
				if (!pack || pack.version !== EVIDENCE_PACK_VERSION) {
					ctx.set.status = 400
					return {
						error: 'PACK_REQUIRED',
						message: `body.pack must be a captured ${EVIDENCE_PACK_VERSION} evidence pack`,
					}
				}
				try {
					return await verifyEvidencePackReplay(
						sql,
						principal,
						ctx.params.id,
						pack,
					)
				} catch (err) {
					if (err instanceof EvidencePackError) {
						ctx.set.status = err.code === 'ANSWER_NOT_FOUND' ? 404 : 409
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/answers/:id/publish', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('review:publish')
				ctx.requireCsrf()
				try {
					return await publishAnswerWithPins(sql, principal, ctx.params.id)
				} catch (err) {
					if (err instanceof AnswerTraceError) {
						ctx.set.status =
							err.code === 'ANSWER_NOT_FOUND' || err.code === 'MISSING_PIN'
								? err.code === 'ANSWER_NOT_FOUND'
									? 404
									: 409
								: 400
						return { error: err.code, message: err.message }
					}
					throw err
				}
			})
			.post('/retrieval/search', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('knowledge:read')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const query = bodyStr(body.query) ?? ''
				if (!query.trim()) {
					ctx.set.status = 400
					return { error: 'QUERY_REQUIRED', message: 'query is required' }
				}
				const filters: LexicalFilters = {
					madhhab: bodyStrArray(body.madhhab),
					language: bodyStr(body.language),
					topicPath: bodyStrArray(body.topicPath),
				}

				// release pin: explicit id, else the tenant's production alias —
				// lanes never search an unpinned "latest" implicitly
				let indexReleaseId = bodyStr(body.indexReleaseId)
				if (!indexReleaseId) {
					const resolved = await resolveIndexAlias(sql, principal, 'production')
					if (!resolved) {
						ctx.set.status = 404
						return {
							error: 'NO_ACTIVE_RELEASE',
							message: 'no indexReleaseId given and production alias is unset',
						}
					}
					indexReleaseId = resolved.releaseId
				}

				try {
					// vector lane uses the SAME embedding configuration the
					// release was embedded with (model + version pinned);
					// unavailable resolutions (broken binding on a remote
					// identity) skip the lane fail-closed instead of hashing
					const vectorResolution = await resolveEmbeddingProvider(
						sql,
						principal.tenantId,
						indexReleaseId,
						{ purpose: 'query' },
					)

					// all four lanes run in parallel, fuse with RRF, and every
					// candidate is re-verified against the live access-scope
					// policy (fail-closed) before evidence leaves retrieval;
					// the fused list is then reranked under the relevance
					// policy (deterministic hash reranker is the built-in
					// default; opt out with rerank: false)
					const outcome = await executeLanePlan(sql, principal, {
						query,
						indexReleaseId,
						filters,
						vectorProvider:
							vectorResolution.status === 'unavailable'
								? undefined
								: vectorResolution.provider,
						reranker:
							body.rerank === false ? undefined : new HashRerankerProvider(),
						// evidence selection stage: overlap collapse + source and
						// madhhab diversity, with every exclusion recorded
						evidence: { requestedMadhhab: bodyStrArray(body.ensureMadhhab) },
						cache: retrievalCache,
					})

					const { identifier, quote, lexical, vector } = outcome.lanes

					// sufficiency assessment (EVD-004): deterministic verdict
					// with reason codes, stored on the retrieval trace —
					// the planner runs first so the trace exists
					const planResult = await planAndPersistQuery(sql, principal, {
						originalQuery: query,
						indexReleaseId,
						requestedMadhhab: filters.madhhab,
					})
					let assessment: AssessmentOutcome | null = null
					if (outcome.evidence) {
						assessment = await assessEvidenceFromPipeline(
							sql,
							principal,
							indexReleaseId,
							{
								intent: planResult.plan.intent,
								exactCandidatesCount:
									identifier.candidates.length + quote.candidates.length,
								evidence: outcome.evidence,
								requestedMadhhab: bodyStrArray(body.ensureMadhhab) ?? [],
							},
						)
						await storeEvidenceAssessment(sql, planResult.traceId, assessment)
					}

					// abstention / escalation policy (EVD-005): categorical
					// decision + language constraints, stored per trace —
					// never a numeric confidence
					const decision = assessment
						? decideResponse(
								assessment,
								body.mode === 'allow_general_knowledge'
									? 'allow_general_knowledge'
									: 'grounded_only',
							)
						: null
					if (decision) {
						await storeResponseDecision(sql, planResult.traceId, decision)
					}

					// structural expansion (EVD-003): adjacent passages,
					// footnotes, pinned evidence spans and linked concepts for
					// the selected fragments — scope-checked, cycle-bounded,
					// every item carrying relation/reason/token estimate
					const contextProfile = bodyStr(body.contextProfile)
					let expansion: Awaited<
						ReturnType<typeof expandEvidenceContext>
					> | null = null
					if (body.expandEvidence === true || contextProfile) {
						const seedSource =
							outcome.evidence?.selected ?? outcome.fused.candidates
						expansion = await expandEvidenceContext(
							sql,
							principal,
							indexReleaseId,
							seedSource.map((c) => ({
								unitId: c.unitId,
								logicalUnitId: c.logicalUnitId,
							})),
						)
					}

					// adaptive context (CTX-001): profile budgeted, protected
					// relations survive truncation, manifest immutable per
					// trace with items/order/token estimates stored
					let context: Awaited<ReturnType<typeof buildContext>> | null = null
					let contextManifest: Awaited<
						ReturnType<typeof storeContextManifest>
					> | null = null
					if (contextProfile && outcome.evidence) {
						const profileDef =
							CONTEXT_PROFILES[contextProfile as ContextProfileKind] ??
							CONTEXT_PROFILES.standard
						context = buildContext(profileDef, outcome.evidence, expansion)
						contextManifest = await storeContextManifest(
							sql,
							planResult.traceId,
							context,
						)
					}

					return {
						indexReleaseId,
						query,
						filters,
						traceId: planResult.traceId,
						identifier,
						quote,
						lexical,
						vector,
						fused: outcome.fused,
						rerank: outcome.rerank,
						evidence: outcome.evidence,
						expansion,
						assessment,
						decision,
						context,
						contextManifest,
					}
				} catch (err) {
					if (err instanceof LaneError) {
						ctx.set.status = 400
						return { error: err.code, lane: err.lane, message: err.message }
					}
					if (err instanceof AccessPolicyError) {
						// fail-closed: scope verification unavailable → no evidence
						ctx.set.status = 503
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
			.get('/config/model', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				const [diag, chain, options] = await Promise.all([
					resolveChatModelDiagnostics(sql),
					listFallbackChain(sql, CHAT_MODEL_ALIAS),
					listModelOptions(sql),
				])
				// RAG-SEM-001: embedding resolution against the production
				// alias release — operators must see hash vs remote vs refused
				let embedding: Record<string, unknown> = {
					status: 'unavailable',
					reason: 'no_active_release',
				}
				const [aliasRelease] = await sql<{ release_id: string }[]>`
					select release_id from index_aliases
					where tenant_id = ${principal.tenantId}::uuid and alias = 'production'
					limit 1`
				if (aliasRelease) {
					const resolution = await resolveEmbeddingProvider(
						sql,
						principal.tenantId,
						aliasRelease.release_id,
						{ purpose: 'query' },
					)
					embedding =
						resolution.status === 'unavailable'
							? {
									status: 'unavailable',
									reason: resolution.reason,
									message: resolution.message,
								}
							: {
									status: resolution.status,
									modelId: resolution.provider.modelId,
									modelVersion: resolution.provider.modelVersion,
									dimensions: resolution.provider.dimensions,
									reason:
										resolution.status === 'remote'
											? undefined
											: resolution.reason,
									...(resolution.status === 'remote'
										? {
												providerKey: resolution.providerKey,
												remoteModel: resolution.remoteModel,
												secretSource: resolution.secretSource,
											}
										: {}),
								}
				}
				return {
					alias: CHAT_MODEL_ALIAS,
					primary: diag.config
						? {
								providerKey: diag.config.providerKey,
								providerType: diag.config.providerType,
								modelId: diag.config.modelId,
								secretSource: diag.config.secretSource,
							}
						: null,
					primaryReason: diag.reason,
					// kill-switch empties the whole chain — surface it explicitly
					killSwitch: diag.reason === 'kill_switch',
					fallbacks: chain.entries,
					modelOptions: options,
					maxAttempts: maxChatAttempts(),
					requireChatModel: process.env.AIFIQH_REQUIRE_CHAT_MODEL === 'true',
					embedding,
				}
			})
			.put('/config/model/fallbacks', async (rawCtx) => {
				const ctx = rawCtx as unknown as HandlerCtx
				const principal = await ctx.requirePermission('config:manage')
				ctx.requireCsrf()
				const body = (ctx.body ?? {}) as Record<string, unknown>
				const rawEntries = Array.isArray(body.entries) ? body.entries : []
				const entries = rawEntries
					.map((e, idx) => {
						const row = (e ?? {}) as Record<string, unknown>
						const targetType = row.targetType
						if (targetType !== 'provider' && targetType !== 'model') return null
						const targetId = bodyStr(row.targetId)
						if (!targetId) return null
						return { targetType, targetId }
					})
					.filter(
						(e): e is { targetType: 'provider' | 'model'; targetId: string } =>
							e !== null,
					)
				try {
					return await replaceFallbackChain(
						sql,
						principal,
						CHAT_MODEL_ALIAS,
						entries,
						ctx.traceId,
					)
				} catch (err) {
					if (err instanceof ConfigValidationError) {
						ctx.set.status = err.code === 'ALIAS_TARGET_INVALID' ? 400 : 422
						return { error: err.code, message: err.message }
					}
					throw err
				}
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
					if (err instanceof PromotionBlockedError) {
						ctx.set.status = 422
						return {
							error: 'PROMOTION_BLOCKED',
							message: err.message,
							reasonCode: err.reasonCode,
							reasons: err.reasons,
							gateResultId: err.gateResultId,
						}
					}
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
