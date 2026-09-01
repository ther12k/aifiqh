import { type Principal, sha256Hex } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import type { RetrievalCandidate } from './retrievalLanes'

/**
 * Access-scope enforcement for retrieval evidence (RAG-008).
 *
 * Two layers:
 *  1. lanes filter by access_scope_id inside their SQL (retrievalLanes.ts);
 *  2. this module re-verifies every candidate against the live policy table
 *     BEFORE evidence leaves retrieval — defense in depth, so a bug in any
 *     lane's SQL still cannot leak an out-of-scope unit.
 *
 * The check is FAIL-CLOSED: if the policy lookup itself fails, retrieval
 * throws rather than returning unverified evidence.
 */

export class AccessPolicyError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'AccessPolicyError'
		this.code = code
	}
}

/**
 * Batch-verify that every candidate's unit is inside the principal's tenant
 * and access scopes. Any unit that fails verification is dropped — it never
 * reaches the caller. A failing policy query fails the whole call.
 */
export async function filterCandidatesByScope(
	sql: Sql,
	principal: Principal,
	candidates: RetrievalCandidate[],
): Promise<RetrievalCandidate[]> {
	if (candidates.length === 0) return candidates
	const unitIds = candidates.map((c) => c.unitId)
	try {
		const rows = await sql<{ id: string }[]>`
			select id from retrieval_units
			where id = any(${unitIds}::uuid[])
				and tenant_id = ${principal.tenantId}::uuid
				and access_scope_id = any(${principal.scopes}::uuid[])`
		const allowed = new Set(rows.map((r) => r.id))
		return candidates.filter((c) => allowed.has(c.unitId))
	} catch (err) {
		// fail-closed: never return evidence the policy could not verify
		throw new AccessPolicyError(
			'ACCESS_POLICY_UNAVAILABLE',
			`scope verification failed: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

/** Stable scope identity for cache namespacing: tenant + sorted scope set. */
export function scopeKeyFor(principal: Principal): string {
	return sha256Hex(
		`${principal.tenantId}|${[...principal.scopes].sort().join(',')}`,
	)
}

interface CacheEntry<T> {
	value: T
	scopeKey: string
	expiresAt: number
}

/**
 * TTL cache whose entries are namespaced by the caller's scope identity.
 * A get() under a different scope identity is a miss by construction —
 * cached retrieval results can never cross scope boundaries even if two
 * principals produce the same cache key.
 */
export class ScopedResultCache<T> {
	private readonly ttlMs: number
	private readonly maxEntries: number
	private readonly store = new Map<string, CacheEntry<T>>()

	constructor(ttlMs = 30_000, maxEntries = 200) {
		this.ttlMs = ttlMs
		this.maxEntries = maxEntries
	}

	get(cacheKey: string, scopeKey: string): T | undefined {
		const entry = this.store.get(cacheKey)
		if (!entry) return undefined
		if (entry.scopeKey !== scopeKey) return undefined // cross-scope access: miss
		if (entry.expiresAt <= Date.now()) {
			this.store.delete(cacheKey)
			return undefined
		}
		return entry.value
	}

	set(cacheKey: string, scopeKey: string, value: T): void {
		if (this.store.size >= this.maxEntries && !this.store.has(cacheKey)) {
			// simple FIFO eviction: derived retrieval data, cheap to recompute
			const oldest = this.store.keys().next().value
			if (oldest !== undefined) this.store.delete(oldest)
		}
		this.store.set(cacheKey, {
			value,
			scopeKey,
			expiresAt: Date.now() + this.ttlMs,
		})
	}

	clear(): void {
		this.store.clear()
	}
}
