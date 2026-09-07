#!/usr/bin/env bun
/**
 * Seed the official reviewed benchmark suite (102 cases, 6 families, 70 tuning / 32 held-out)
 * into tenant Alpha or the specified tenant.
 */
import postgres from 'postgres'
import { loadConfig } from '../apps/api/src/config'
import { seedReviewedBenchmark } from '../apps/api/src/eval/benchmarkCorpus'
import type { Principal } from '../packages/shared/src/index'

const cfg = loadConfig()
const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const sql = postgres(DB_URL, { max: 1 })

async function main() {
	console.log('Seeding official reviewed benchmark suite (#112)...')

	const [tenant] = await sql<{ id: string }[]>`
		select id from tenants where slug = 'alpha' limit 1`
	if (!tenant) {
		console.error('Tenant "alpha" not found. Run db:seed first.')
		process.exit(1)
	}

	const [admin] = await sql<{ id: string }[]>`
		select id from users where primary_email = 'admin@example.com' limit 1`
	const adminId = admin?.id ?? crypto.randomUUID()

	const principal: Principal = {
		userId: adminId,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'knowledge:draft', 'review:publish'],
		scopes: [],
		actorType: 'user',
	}

	const result = await seedReviewedBenchmark(sql, principal, {
		setKey: 'fiqh-reviewed-benchmark-v1',
	})

	console.log('✅ Successfully seeded benchmark suite!')
	console.log(`   Set ID: ${result.setId}`)
	console.log(`   Version ID: ${result.versionId}`)
	console.log(`   Total Cases: ${result.caseCount}`)
	console.log(`   Tuning Cases: ${result.tuningCount}`)
	console.log(`   Held-out Cases: ${result.heldOutCount}`)
	console.log('   Families:')
	for (const [fam, count] of Object.entries(result.families)) {
		console.log(`     - ${fam}: ${count}`)
	}
}

main()
	.then(() => sql.end({ timeout: 1 }))
	.catch(async (err) => {
		console.error('Seeding failed:', err)
		await sql.end({ timeout: 1 })
		process.exit(1)
	})
