import postgres from 'postgres'
/**
 * Append-only audit event service (AUD-001 / DB-003).
 * Writes actor, tenant, action, entity, before/after reference, reason,
 * trace_id, timestamp. The DB trigger from migration 0003 rejects
 * UPDATE/DELETE; application code must never mutate audit rows.
 * The sql client is injected (HARD-005) — no module-scope connections.
 */
import type { AuditEventInput } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { currentTraceId } from '../observability/trace'

export interface AuditEventRow {
	id: string
	tenant_id: string | null
	actor_type: 'user' | 'service' | 'system'
	actor_id: string
	action: string
	entity_type: string
	entity_id: string
	before_ref: Record<string, unknown> | null
	after_ref: Record<string, unknown> | null
	reason: string | null
	trace_id: string | null
	occurred_at: Date
}

export async function recordAudit(
	sql: Sql,
	input: AuditEventInput,
): Promise<AuditEventRow> {
	const traceId = input.traceId ?? currentTraceId() ?? null
	const [row] = await sql<AuditEventRow[]>`
    insert into audit_events
      (tenant_id, actor_type, actor_id, action, entity_type, entity_id,
       before_ref, after_ref, reason, trace_id)
    values
      (${input.tenantId ?? null}, ${input.actorType}, ${input.actorId}, ${input.action},
       ${input.entityType}, ${input.entityId},
       ${input.beforeRef ? sql.json(input.beforeRef as never) : null},
       ${input.afterRef ? sql.json(input.afterRef as never) : null},
       ${input.reason ?? null}, ${traceId})
    returning *
  `
	if (!row) throw new Error('audit insert returned no row')
	return row
}

/** Audit within the same transaction as the business change (consistency). */
export async function recordAuditInTx(
	tx: Sql | postgres.TransactionSql,
	input: AuditEventInput,
): Promise<void> {
	const traceId = input.traceId ?? currentTraceId() ?? null
	await tx`
    insert into audit_events
      (tenant_id, actor_type, actor_id, action, entity_type, entity_id,
       before_ref, after_ref, reason, trace_id)
    values
      (${input.tenantId ?? null}, ${input.actorType}, ${input.actorId}, ${input.action},
       ${input.entityType}, ${input.entityId},
       ${input.beforeRef ? tx.json(input.beforeRef as never) : null},
       ${input.afterRef ? tx.json(input.afterRef as never) : null},
       ${input.reason ?? null}, ${traceId})
  `
}

export interface AuditFilter {
	tenantId?: string
	actorId?: string
	entityType?: string
	entityId?: string
	traceId?: string
	limit?: number
}

export async function listAudit(
	sql: Sql,
	filter: AuditFilter,
): Promise<AuditEventRow[]> {
	return sql<AuditEventRow[]>`
    select * from audit_events
    where
      (${filter.tenantId ?? null}::uuid is null or tenant_id = ${filter.tenantId ?? null}::uuid) and
      (${filter.actorId ?? null}::text is null or actor_id = ${filter.actorId ?? null}) and
      (${filter.entityType ?? null}::text is null or entity_type = ${filter.entityType ?? null}) and
      (${filter.entityId ?? null}::text is null or entity_id = ${filter.entityId ?? null}) and
      (${filter.traceId ?? null}::text is null or trace_id = ${filter.traceId ?? null})
    order by occurred_at desc
    limit ${filter.limit ?? 50}
  `
}
