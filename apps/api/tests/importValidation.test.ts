/**
 * Import validation report (#118): the six acceptance checks run before any
 * ingest may reach the editorial queue. A deliberately corrupted import
 * (dropped record, lost-Arabic text, duplicate id, missing locator,
 * withdrawn material still present) fails with precise locations and the
 * persisted run is `rejected`.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import {
	type ImportBatchInput,
	validateImportRecords,
} from '../src/sources/importValidation'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

let tenantId = ''
let adminUserId = ''

function makeBatch(
	overrides: Partial<ImportBatchInput> = {},
): ImportBatchInput {
	return {
		source: {
			title: 'Tanzil Quran (Uthmani)',
			author: 'Tanzil.net',
			sourceType: 'dataset',
			language: 'ar',
			rightsStatus: 'public_domain',
		},
		provider: { name: 'tanzil', edition: 'uthmani', acquisitionVersion: '1.0' },
		acquisitionMethod: 'bulk_file',
		policyReference: 'https://tanzil.net/download',
		policyCheckedAt: null,
		expectedCount: 3,
		records: [
			{
				providerRecordId: '2:255',
				sourceLocator: 'QS 2:255',
				originalText: 'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ',
			},
			{
				providerRecordId: '2:256',
				sourceLocator: 'QS 2:256',
				originalText: 'لَا إِكْرَاهَ فِي الدِّينِ',
			},
			{
				providerRecordId: '2:257',
				sourceLocator: 'QS 2:257',
				originalText: 'اللَّهُ وَلِيُّ الَّذِينَ آمَنُوا',
			},
		],
		...overrides,
	}
}

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`imp-t-${suffix}`}, 'Import Tenant')
		returning id`
	tenantId = tenant.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`imp-${suffix}@test.local`}, 'imp') returning id`
	adminUserId = user.id
})

function principal() {
	return {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin' as const],
		permissions: ['source:create' as const],
		scopes: [],
		actorType: 'user' as const,
	}
}

describe('import validation — pure checks (#118)', () => {
	test('a clean batch passes all six checks', () => {
		const checks = validateImportRecords(makeBatch())
		expect(checks.map((c) => `${c.check}:${c.status}`)).toEqual([
			'coverage:pass',
			'text_fidelity:pass',
			'stable_ids:pass',
			'provenance:pass',
			'revision_compare:pass',
			'status_propagation:pass',
		])
	})

	test('a dropped record fails coverage with counts', () => {
		const batch = makeBatch()
		batch.records = batch.records.slice(0, 2)
		const checks = validateImportRecords(batch)
		const cov = checks.find((c) => c.check === 'coverage')!
		expect(cov.status).toBe('fail')
		expect(cov.failures[0].detail).toContain('declares 3')
		expect(cov.failures[0].detail).toContain('carries 2')
	})

	test('lost Arabic characters and empty texts fail fidelity by record id', () => {
		const batch = makeBatch()
		batch.records[1].originalText = 'لَا إِكْرَاهَ \uFFFD\uFFFD'
		batch.records[2].originalText = '   '
		const checks = validateImportRecords(batch)
		const fid = checks.find((c) => c.check === 'text_fidelity')!
		expect(fid.status).toBe('fail')
		const ids = fid.failures.map((f) => f.recordId)
		expect(ids).toContain('2:256')
		expect(ids).toContain('2:257')
		expect(fid.failures.find((f) => f.recordId === '2:256')?.detail).toContain(
			'U+FFFD',
		)
	})

	test('duplicate provider ids fail stable_ids with the duplicated id', () => {
		const batch = makeBatch()
		batch.records[2] = { ...batch.records[1] }
		const checks = validateImportRecords(batch)
		const ids = checks.find((c) => c.check === 'stable_ids')!
		expect(ids.status).toBe('fail')
		expect(ids.failures[0].recordId).toBe('2:256')
		expect(ids.failures[0].detail).toContain('2×')
	})

	test('missing locators and missing provenance fail with precise records', () => {
		const batch = makeBatch()
		batch.records[0].sourceLocator = null
		batch.acquisitionMethod = null
		batch.policyReference = null
		const checks = validateImportRecords(batch)
		const prov = checks.find((c) => c.check === 'provenance')!
		expect(prov.status).toBe('fail')
		expect(prov.failures.some((f) => f.recordId === '2:255')).toBeTrue()
		expect(
			prov.failures.some((f) => f.detail.includes('acquisition method')),
		).toBeTrue()
		expect(
			prov.failures.some((f) => f.detail.includes('policy reference')),
		).toBeTrue()
	})

	test('changed text vs baseline is flagged for re-review, never silent', () => {
		const batch = makeBatch({
			baselineRecords: { '2:255': 'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ (نسخة قديمة)' },
		})
		const checks = validateImportRecords(batch)
		const rev = checks.find((c) => c.check === 'revision_compare')!
		expect(rev.status).toBe('warn')
		expect(rev.failures[0].recordId).toBe('2:255')
		expect(rev.failures[0].detail).toContain('NEW revision')
	})

	test('withdrawn material still in the batch fails status propagation', () => {
		const batch = makeBatch({ withdrawnRecordIds: ['2:257'] })
		const checks = validateImportRecords(batch)
		const prop = checks.find((c) => c.check === 'status_propagation')!
		expect(prop.status).toBe('fail')
		expect(prop.failures[0].recordId).toBe('2:257')
	})
})

describe('import validation — persisted runs (#118)', () => {
	test('rejected run persists with the report and never reaches the queue', async () => {
		const { validateAndRecordImport } = await import(
			'../src/sources/importValidation'
		)
		const batch = makeBatch()
		batch.records[1].originalText = ''
		const outcome = await validateAndRecordImport(sql, principal(), batch)
		expect(outcome.ok).toBeFalse()
		const fid = outcome.report.checks.find((c) => c.check === 'text_fidelity')!
		expect(fid.failures[0].recordId).toBe('2:256')

		const [row] = await sql<{ status: string }[]>`
			select status from import_runs where id = ${outcome.runId}::uuid`
		expect(row.status).toBe('rejected')
	})

	test('clean run persists as validated and RLS isolates by tenant', async () => {
		const { validateAndRecordImport } = await import(
			'../src/sources/importValidation'
		)
		const outcome = await validateAndRecordImport(sql, principal(), makeBatch())
		expect(outcome.ok).toBeTrue()
		const [row] = await sql<{ status: string }[]>`
			select status from import_runs where id = ${outcome.runId}::uuid`
		expect(row.status).toBe('validated')

		// RLS isolation as the APP role (the admin client owns the table and
		// bypasses nothing — but FORCE RLS still applies only to the policy):
		// own tenant sees the run, a foreign tenant must not
		const appUrl = DB_URL.replace(/:\/\/[^@]+@/, '://aifiqh_app:aifiqh_app@')
		const app = postgres(appUrl, { max: 1 })
		try {
			await app`select set_config('app.tenant_id', ${tenantId}, false)`
			const own = await app<{ id: string }[]>`
				select id from import_runs where id = ${outcome.runId}::uuid`
			expect(own.length).toBe(1)
			const [otherTenant] = await sql<{ id: string }[]>`
				insert into tenants (slug, name) values (${`imp-x-${crypto.randomUUID().slice(0, 8)}`}, 'X')
				returning id`
			await app`select set_config('app.tenant_id', ${otherTenant.id}, false)`
			const foreign = await app<{ id: string }[]>`
				select id from import_runs where id = ${outcome.runId}::uuid`
			expect(foreign.length).toBe(0)
		} finally {
			await app.end()
		}
	})
})
