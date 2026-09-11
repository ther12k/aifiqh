/**
 * Semantic Index Release & A/B Benchmark CLI (RAG-SEM-002).
 *
 * Implements the safe release lifecycle:
 *  1. Builds index release B with the target embedding model.
 *  2. Preserves baseline release A intact.
 *  3. Runs A vs B retrieval benchmark comparison.
 *  4. Evaluates release gate and promotes B to 'production' on pass.
 *
 * Usage: bun scripts/release_semantic_index.ts
 *
 * Environment variables:
 *   CONFIGURATION_ID    target index_configurations.id for Release B (required or resolved)
 *   BENCHMARK_SET_KEY   benchmark set key (default: fiqh-reviewed-benchmark-v2)
 *   GATE_POLICY         gate policy key (default: launch_v1)
 *   DRY_RUN             set to 'true' to benchmark without promoting (default: false)
 */
import postgres from 'postgres'
import { seedReviewedBenchmark } from '../apps/api/src/eval/benchmarkCorpus'
import {
	benchmarkReleasePair,
	buildSemanticIndexRelease,
	promoteGatedRelease,
} from '../apps/api/src/index/semanticReleaseService'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const sql = postgres(DB_URL, { max: 1 })
const dryRun = process.env.DRY_RUN === 'true'
const gatePolicy = process.env.GATE_POLICY ?? 'launch_v1'
const benchmarkKey =
	process.env.BENCHMARK_SET_KEY ?? 'fiqh-reviewed-benchmark-v2'

console.log('=== Semantic Index Release & A/B Benchmark (RAG-SEM-002) ===')
console.log(`Gate Policy: ${gatePolicy}`)
console.log(`Dry Run: ${dryRun}`)

// 1. Resolve admin principal & tenant
const [admin] = await sql<{ id: string; tenant_id: string }[]>`
	select u.id, tm.tenant_id
	from users u
	join tenant_memberships tm on tm.user_id = u.id
	where u.primary_email = 'admin@example.com'
	limit 1`

if (!admin) {
	console.error('✗ No admin user found')
	process.exit(1)
}

const principal = {
	userId: admin.id,
	tenantId: admin.tenant_id,
	roles: ['tenant_admin'],
	permissions: [
		'knowledge:read',
		'knowledge:draft',
		'review:publish',
		'config:manage',
	],
	scopes: [],
	actorType: 'user' as const,
}

// 2. Identify current production release (Release A)
const [aliasRow] = await sql<{ release_id: string }[]>`
	select release_id
	from index_aliases
	where tenant_id = ${principal.tenantId}::uuid and alias = 'production'
	limit 1`

if (!aliasRow) {
	console.error('✗ No active "production" index release found (Release A)')
	process.exit(1)
}
const releaseAId = aliasRow.release_id
console.log(`✓ Release A (baseline): ${releaseAId}`)

// 3. Resolve target configuration for Release B
let configId = process.env.CONFIGURATION_ID
if (!configId) {
	const [latestCfg] = await sql<{ id: string }[]>`
		select id from index_configurations order by created_at desc limit 1`
	configId = latestCfg?.id
}
if (!configId) {
	console.error('✗ No index_configuration found for Release B')
	process.exit(1)
}

const [releaseARow] = await sql<{ knowledge_release_id: string }[]>`
	select knowledge_release_id from index_releases where id = ${releaseAId}::uuid`
const knowledgeReleaseId = releaseARow.knowledge_release_id

// 4. Build Release B (re-embedding corpus, Release A untouched)
console.log('\n--- Step 1: Building Release B ---')
const buildRes = await buildSemanticIndexRelease(sql, principal, {
	knowledgeReleaseId,
	configurationId: configId,
})
console.log(`✓ Release B built: ${buildRes.releaseId}`)
console.log(`  Units considered: ${buildRes.embedResult.unitsConsidered}`)
console.log(`  Embeddings created: ${buildRes.embedResult.embeddingsCreated}`)
console.log(`  Embeddings reused: ${buildRes.embedResult.embeddingsReused}`)

// 5. Ensure benchmark suite exists
console.log('\n--- Step 2: Preparing Benchmark Suite ---')
const benchRes = await seedReviewedBenchmark(sql, principal, {
	setKey: benchmarkKey,
})
console.log(
	`✓ Benchmark suite version ready: ${benchRes.versionId} (${benchRes.caseCount} cases)`,
)

// 6. Run A/B Benchmark (Release A vs Release B)
console.log('\n--- Step 3: Running A vs B Benchmark ---')
const benchResult = await benchmarkReleasePair(sql, principal, {
	releaseAId,
	releaseBId: buildRes.releaseId,
	setVersionId: benchRes.versionId,
})
console.log('✓ Benchmark runs completed:')
console.log(
	`  Release A (Run ${benchResult.runAId}): Recall@10 = ${benchResult.runAReport.recallAtK}, MRR = ${benchResult.runAReport.mrr}, Avg Latency = ${benchResult.runAReport.avgLatencyMs}ms`,
)
console.log(
	`  Release B (Run ${benchResult.runBId}): Recall@10 = ${benchResult.runBReport.recallAtK}, MRR = ${benchResult.runBReport.mrr}, Avg Latency = ${benchResult.runBReport.avgLatencyMs}ms`,
)

const comp = benchResult.comparisonReport
console.log('\n  Comparison Summary:')
console.log(
	`  - Improved: ${comp.summary.improved}, Regressed: ${comp.summary.regressed}, Unchanged: ${comp.summary.unchanged}`,
)
console.log(
	`  - Delta Recall@10: ${comp.dimensions.retrievalQuality.deltaRecall}`,
)
console.log(`  - Delta MRR: ${comp.dimensions.retrievalQuality.deltaMrr}`)
console.log(`  - Delta Latency: ${comp.dimensions.latency.deltaAvgMs}ms`)

// 7. Evaluate Release Gate & Promote
console.log('\n--- Step 4: Release Gate Evaluation & Promotion ---')
const gateRes = await promoteGatedRelease(sql, principal, {
	candidateReleaseId: buildRes.releaseId,
	retrievalRunId: benchResult.runBId,
	comparisonId: benchResult.comparisonId,
	policyKey: gatePolicy,
	alias: 'production',
})

console.log(`Gate Result: ${gateRes.gateResult.result}`)
for (const check of gateRes.gateResult.checks) {
	console.log(
		`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.threshold}: expected ${check.expected}, got ${check.value}`,
	)
}

if (gateRes.promoted) {
	console.log(
		`\n🎉 PROMOTION SUCCESSFUL! Release B (${buildRes.releaseId}) is now the 'production' index release.`,
	)
	console.log(
		`   Previous release (${gateRes.aliasResult?.previousReleaseId}) retired.`,
	)
} else {
	console.log(
		`\n⚠ Release B was NOT promoted (gate passed = ${gateRes.gateResult.result === 'passed'}).`,
	)
	console.log(
		`   Release A (${releaseAId}) remains the active production release.`,
	)
}

await sql.end({ timeout: 1 })
