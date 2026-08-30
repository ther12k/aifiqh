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

/** Run a scoped transaction; sets app.tenant_id for row-level security. */
export async function withTenant<T>(
	tenantId: string,
	fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
	return db().begin(async (sql): Promise<T> => {
		await sql`select set_config('app.tenant_id', ${tenantId}, true)`
		return fn(sql as unknown as Sql)
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
