/**
 * Shared DB bootstrap for DB-backed test files. Applies migrations exactly
 * once per process (idempotent against an already-migrated database) so any
 * test file can run first in CI's fresh container.
 */
import { join } from 'node:path'
import postgres from 'postgres'
import { applyMigrations } from '../../../scripts/migrate'

export const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const MIGRATIONS_DIR = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'db',
	'migrations',
)

let applied: Promise<void> | null = null

/**
 * Apply all migrations once and seed the permission/role catalog
 * (normally seeded by scripts/seed.ts). Safe to call from every test
 * file's beforeAll; CI starts from an empty container.
 */
export function ensureMigrations(): Promise<void> {
	if (!applied) {
		const sql = postgres(DB_URL, { max: 1 })
		applied = (async () => {
			await applyMigrations(sql, MIGRATIONS_DIR, () => {})

			const perms = [
				'source:read',
				'source:create',
				'source:update_metadata',
				'source:deprecate',
				'knowledge:read',
				'knowledge:draft',
				'review:approve',
				'review:publish',
				'config:manage',
				'ops:read',
				'audit:read',
			]
			for (const key of perms) {
				await sql`insert into permissions (key, description) values (${key}, ${key}) on conflict do nothing`
			}
			const matrix: Record<string, string[]> = {
				tenant_admin: perms,
				editor: [
					'source:read',
					'source:create',
					'source:update_metadata',
					'knowledge:read',
					'knowledge:draft',
				],
				reviewer: [
					'source:read',
					'knowledge:read',
					'review:approve',
					'review:publish',
					'audit:read',
				],
				reader: ['source:read', 'knowledge:read'],
				operator: ['source:read', 'knowledge:read', 'ops:read', 'audit:read'],
				service: ['source:read', 'source:create', 'knowledge:read', 'ops:read'],
			}
			for (const [role, rolePerms] of Object.entries(matrix)) {
				await sql`insert into roles (tenant_id, key, name) values (null, ${role}, ${role}) on conflict do nothing`
				const [r] = await sql<
					{ id: string }[]
				>`select id from roles where tenant_id is null and key = ${role}`
				for (const p of rolePerms) {
					await sql`insert into role_permissions (role_id, permission_key) values (${r.id}, ${p}) on conflict do nothing`
				}
			}
		})().finally(() => sql.end({ timeout: 1 }))
	}
	return applied
}
