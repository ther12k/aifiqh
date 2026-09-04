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
function wrapTxSql(tx: unknown): Sql {
	if (typeof (tx as { begin?: unknown }).begin === 'function') {
		return tx as Sql
	}
	return new Proxy(tx as object, {
		get(target, prop, receiver) {
			if (prop === 'begin') {
				return (fn: (subTx: Sql) => Promise<unknown>) =>
					(
						target as {
							savepoint: (cb: (sp: unknown) => unknown) => Promise<unknown>
						}
					).savepoint((sp) => fn(wrapTxSql(sp)))
			}
			const val = Reflect.get(target, prop, receiver)
			return typeof val === 'function'
				? (val as (...args: unknown[]) => unknown).bind(target)
				: val
		},
	}) as unknown as Sql
}

export async function scopedTransaction<T>(
	client: Sql,
	tenantId: string,
	fn: (sql: Sql) => Promise<T>,
): Promise<T> {
	// If the client is already in a transaction, use savepoint instead of begin
	const beginFn = (
		typeof client.begin === 'function'
			? client.begin.bind(client)
			: typeof (client as unknown as { savepoint: unknown }).savepoint ===
					'function'
				? (
						client as unknown as { savepoint: typeof client.begin }
					).savepoint.bind(client)
				: null
	) as ((cb: (tx: unknown) => Promise<T>) => Promise<T>) | null

	if (beginFn) {
		return beginFn(async (tx): Promise<T> => {
			const wrapped = wrapTxSql(tx)
			await wrapped`select set_config('app.tenant_id', ${tenantId}, true)`
			return fn(wrapped)
		})
	}
	await client`select set_config('app.tenant_id', ${tenantId}, true)`
	return fn(client)
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
