import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import {
	type ComparisonReport,
	compareRuns,
} from '../eval/evalComparisonService'
import {
	type RetrievalRunReport,
	runRetrievalEvaluation,
} from '../eval/evalRetrievalRunner'
import {
	type GateEvaluationResult,
	evaluateLaunchGate,
} from '../eval/gateService'
import {
	type EmbedReleaseResult,
	embedIndexRelease,
	resolveEmbeddingProvider,
} from './embeddingService'
import { promoteIndexRelease } from './indexAliasService'
import { compileIndexRelease } from './indexCompiler'

/**
 * Semantic Index Release & A/B Benchmark Workflow (RAG-SEM-002).
 *
 * Implements the immutable index release lifecycle:
 *  1. Build Release B: re-embed the corpus with the target provider (never
 *     updating vectors in place).
 *  2. Keep Release A (hash/baseline) untouched for rollback and lineage.
 *  3. Run the benchmark harness A vs B: Recall@K, MRR/nDCG, citation precision,
 *     latency deltas.
 *  4. Promote Release B to 'production' alias ONLY on a passing gate (EVAL-006).
 */

export const SEMANTIC_RELEASE_WORKFLOW_VERSION = 'semantic-release-v1'

export class SemanticReleaseError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'SemanticReleaseError'
	}
}

export interface BuildReleaseBInput {
	knowledgeReleaseId: string
	configurationId: string
	batchSize?: number
}

export interface BuildReleaseBResult {
	releaseId: string
	manifestHash: string
	embedResult: EmbedReleaseResult
}

/**
 * Step 1 & 2: Build a new index release B and embed it with the resolved provider.
 * Existing vectors and baseline release A remain completely untouched.
 */
export async function buildSemanticIndexRelease(
	sql: Sql,
	principal: Principal,
	input: BuildReleaseBInput,
): Promise<BuildReleaseBResult> {
	// 1. Compile candidate release B
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: input.knowledgeReleaseId,
		configurationId: input.configurationId,
	})

	// 2. Resolve embedding provider for release B
	const resolution = await resolveEmbeddingProvider(
		sql,
		principal.tenantId,
		compiled.indexReleaseId,
		{ purpose: 'index' },
	)
	if (resolution.status === 'unavailable') {
		throw new SemanticReleaseError(
			'EMBEDDING_UNAVAILABLE',
			`Cannot embed release B: ${resolution.reason} (${resolution.message})`,
		)
	}

	// 3. Embed units with the resolved provider
	const embedResult = await embedIndexRelease(
		sql,
		principal,
		compiled.indexReleaseId,
		resolution.provider,
		{ batchSize: input.batchSize ?? 64 },
	)

	// 4. Mark candidate release ready for benchmarking and promotion
	await sql`
		update index_releases
		set state = 'ready'
		where id = ${compiled.indexReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid`

	return {
		releaseId: compiled.indexReleaseId,
		manifestHash: compiled.manifestHash,
		embedResult,
	}
}

export interface BenchmarkPairInput {
	releaseAId: string
	releaseBId: string
	setVersionId: string
	k?: number
}

export interface BenchmarkPairResult {
	runAReport: RetrievalRunReport
	runBReport: RetrievalRunReport
	runAId: string
	runBId: string
	comparisonId: string
	comparisonReport: ComparisonReport
}

/**
 * Step 3: Run the retrieval benchmark harness A vs B and compare their dimensions.
 */
export async function benchmarkReleasePair(
	sql: Sql,
	principal: Principal,
	input: BenchmarkPairInput,
): Promise<BenchmarkPairResult> {
	const k = input.k ?? 10

	// Benchmark Release A (baseline)
	const runAOutcome = await runRetrievalEvaluation(sql, principal, {
		setVersionId: input.setVersionId,
		indexReleaseId: input.releaseAId,
		k,
	})

	// Benchmark Release B (candidate)
	const runBOutcome = await runRetrievalEvaluation(sql, principal, {
		setVersionId: input.setVersionId,
		indexReleaseId: input.releaseBId,
		k,
	})

	// Paired comparison (EVAL-005)
	const comp = await compareRuns(sql, principal, {
		baselineRunId: runAOutcome.runId,
		candidateRunId: runBOutcome.runId,
	})

	return {
		runAId: runAOutcome.runId,
		runBId: runBOutcome.runId,
		runAReport: runAOutcome.report,
		runBReport: runBOutcome.report,
		comparisonId: comp.comparisonId,
		comparisonReport: comp.report,
	}
}

export interface GatedPromotionInput {
	candidateReleaseId: string
	retrievalRunId: string
	e2eRunId?: string | null
	comparisonId?: string | null
	policyKey?: string
	alias?: 'production' | 'staging'
}

export interface GatedPromotionResult {
	gateResult: GateEvaluationResult
	promoted: boolean
	aliasResult?: {
		alias: string
		releaseId: string
		previousReleaseId: string | null
	}
}

/**
 * Step 4: Evaluate release gate on Release B, and promote ONLY if gate passes.
 */
export async function promoteGatedRelease(
	sql: Sql,
	principal: Principal,
	input: GatedPromotionInput,
): Promise<GatedPromotionResult> {
	const policyKey = input.policyKey ?? 'launch_v1'
	const alias = input.alias ?? 'production'

	// Evaluate release gate
	const gateResult = await evaluateLaunchGate(sql, principal, {
		policyKey,
		subjectType: 'index_release',
		subjectId: input.candidateReleaseId,
		retrievalRunId: input.retrievalRunId,
		e2eRunId: input.e2eRunId ?? null,
		comparisonId: input.comparisonId ?? null,
	})

	if (gateResult.result !== 'passed') {
		return {
			gateResult,
			promoted: false,
		}
	}

	// Gate passed: atomically promote candidate release to the target alias
	const aliasResult = await promoteIndexRelease(
		sql,
		principal,
		input.candidateReleaseId,
		alias,
	)

	return {
		gateResult,
		promoted: true,
		aliasResult,
	}
}
