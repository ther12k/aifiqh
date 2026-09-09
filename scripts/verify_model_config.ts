/**
 * Verify the chat model is actually resolvable in THIS environment (AI-001).
 *
 * Production must not be able to deploy silently with the AI path off.
 * Where scripts/configure_model.ts is the explicit configuration STEP,
 * this script is the verification GATE: it runs the REAL resolution path
 * (resolveChatModelDiagnostics — same code the chat turn uses) and fails
 * when AIFIQH_REQUIRE_CHAT_MODEL=true and the model cannot resolve.
 *
 * Resolution reasons reported:
 *   resolved | kill_switch | not_configured | disabled_or_empty
 *   | ambiguous | secret_unavailable
 *
 * Environment:
 *   DATABASE_URL / ADMIN_DATABASE_URL   Postgres connection
 *   AIFIQH_REQUIRE_CHAT_MODEL=true      exit 1 when the model cannot resolve
 *   AIFIQH_CHAT_MODEL=off               explicit kill switch (reported, respected)
 *
 * Usage: bun scripts/verify_model_config.ts
 * Exit codes: 0 verified or not-required; 1 requirement unmet; 2 DB error
 */
import postgres from 'postgres'
import {
	type ChatModelResolution,
	resolveChatModelDiagnostics,
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

let diag: Awaited<ReturnType<typeof resolveChatModelDiagnostics>>
try {
	diag = await resolveChatModelDiagnostics(sql)
} catch (err) {
	console.error(
		`✗ model verification could not reach the database: ${err instanceof Error ? err.message : String(err)}`,
	)
	await sql.end({ timeout: 1 })
	process.exit(2)
}

console.log(`chat model resolution: ${diag.reason}`)
console.log(`  ${REASON_SUMMARY[diag.reason]}`)
if (diag.config) {
	console.log(
		`  provider : ${diag.config.providerKey} (${diag.config.providerType})`,
	)
	console.log(`  model    : ${diag.config.modelId}`)
	console.log(`  secret   : ${diag.config.secretSource}`)
}

if (!diag.config && REQUIRED) {
	console.error(
		'✗ AIFIQH_REQUIRE_CHAT_MODEL=true but the chat model cannot resolve — refusing to start. Configure it with scripts/configure_model.ts (an explicit deployment step) and make sure the secret resolves in this environment.',
	)
	await sql.end({ timeout: 1 })
	process.exit(1)
}

if (!diag.config) {
	console.warn(
		'⚠ chat turns will use the deterministic built-in composer (recorded per turn as generation mode "deterministic_rag").',
	)
}

await sql.end({ timeout: 1 })
process.exit(0)
