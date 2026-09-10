/**
 * Verify the chat model is actually resolvable in THIS environment (AI-001).
 *
 * Production must not be able to deploy silently with the AI path off.
 * Where scripts/configure_model.ts is the explicit configuration STEP,
 * this script is the verification GATE: it runs the REAL resolution path
 * (the same resolver the chat turn uses) and fails when
 * AIFIQH_REQUIRE_CHAT_MODEL=true and no model in the chain resolves.
 *
 * Resolution reasons reported:
 *   resolved | kill_switch | not_configured | disabled_or_empty
 *   | ambiguous | secret_unavailable
 *
 * Environment:
 *   DATABASE_URL / ADMIN_DATABASE_URL   Postgres connection
 *   AIFIQH_REQUIRE_CHAT_MODEL=true      exit 1 when nothing resolves
 *   AIFIQH_CHAT_MODEL=off               explicit kill switch (reported, respected)
 *   AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS   total attempts per turn (default 3)
 *
 * Usage: bun scripts/verify_model_config.ts
 * Exit codes: 0 verified or not-required; 1 requirement unmet; 2 DB error
 */
import postgres from 'postgres'
import {
	type ChatModelResolution,
	maxChatAttempts,
	resolveChatModelCandidates,
} from '../apps/api/src/llm/modelRouter'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const REQUIRED = process.env.AIFIQH_REQUIRE_CHAT_MODEL === 'true'

const REASON_SUMMARY: Record<ChatModelResolution, string> = {
	resolved: 'chat model resolvable — LLM path active',
	kill_switch: 'AIFIQH_CHAT_MODEL=off — AI deliberately disabled',
	not_configured: 'no provider/model/alias configured — RAG-only composer',
	disabled_or_empty: 'providers configured but disabled or without models',
	ambiguous: 'multiple providers without an explicit chat-production alias',
	secret_unavailable: 'secret ref does not resolve in this environment',
}

const sql = postgres(DB_URL, { max: 1, connect_timeout: 10 })

let chain: Awaited<ReturnType<typeof resolveChatModelCandidates>>
try {
	chain = await resolveChatModelCandidates(sql)
} catch (err) {
	console.error(
		`✗ model verification could not reach the database: ${err instanceof Error ? err.message : String(err)}`,
	)
	await sql.end({ timeout: 1 })
	process.exit(2)
}

const primary = chain.candidates[0]
const diagReason = primary ? 'resolved' : chain.primaryReason
console.log(`chat model resolution: ${diagReason}`)
console.log(`  ${REASON_SUMMARY[chain.primaryReason]}`)
if (primary) {
	console.log(
		`  provider : ${primary.config.providerKey} (${primary.config.providerType})`,
	)
	console.log(`  model    : ${primary.config.modelId}`)
	console.log(`  secret   : ${primary.config.secretSource}`)
}

// the fallback chain (AI-004): attempt order after the primary
console.log(
	`fallback chain: ${Math.max(0, chain.candidates.length - 1)} entr` +
		`${chain.candidates.length - 1 === 1 ? 'y' : 'ies'}` +
		` (max ${maxChatAttempts()} attempts/turn)`,
)
for (const c of chain.candidates.slice(1)) {
	console.log(
		`  #${c.position} ${c.config.providerKey} / ${c.config.modelId} (${c.targetType})`,
	)
}
for (const s of chain.skipped) {
	console.warn(`  #${s.position} SKIPPED: ${s.reason}`)
}

const anyModel = chain.candidates.length > 0
if (!anyModel && REQUIRED) {
	console.error(
		'✗ AIFIQH_REQUIRE_CHAT_MODEL=true but no model in the chain resolves — refusing to start. Configure it with scripts/configure_model.ts (an explicit deployment step) and make sure the secrets resolve in this environment.',
	)
	await sql.end({ timeout: 1 })
	process.exit(1)
}

if (!anyModel) {
	console.warn(
		'⚠ chat turns will use the deterministic built-in composer (recorded per turn as generation mode "deterministic_rag").',
	)
}

await sql.end({ timeout: 1 })
process.exit(0)
