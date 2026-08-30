import postgres from 'postgres'
import { config } from '../config'

declare module 'postgres' {}

export type Sql = ReturnType<typeof postgres>

let client: Sql | null = null

export function db(): Sql {
	if (!client) {
		client = postgres(config().databaseUrl, {
			max: 10,
			idle_timeout: 20,
			connect_timeout: 10,
			onnotice: () => {},
		})
	}
	return client
}

/** Run a scoped transaction on the shared pool; sets app.tenant_id. */
export async function withTenant<T>(
	tenantId: string,
	fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
	return scopedTransaction(db(), tenantId, fn)
}

/**
 * Run fn inside a transaction with app.tenant_id set so FORCE ROW LEVEL
 * SECURITY policies apply. Without the GUC every query on RLS tables
 * fails closed (zero rows), so all tenant-scoped data access goes through
 * this wrapper.
 */
export async function scopedTransaction<T>(
	client: Sql,
	tenantId: string,
	fn: (sql: Sql) => Promise<T>,
): Promise<T> {
	return client.begin(async (tx): Promise<T> => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`
		return fn(tx as unknown as Sql)
	}) as Promise<T>
}

export async function closeDb(): Promise<void> {
	if (client) {
		await client.end({ timeout: 1 })
		client = null
	}
}

export async function dbOk(): Promise<boolean> {
	try {
		await db()`select 1`
		return true
	} catch {
		return false
	}
}

export { postgres }
