import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { type Config, loadConfig } from '../src/config'
import {
	contentKey,
	createBucket,
	deleteObject,
	getObject,
	headObject,
	listObjects,
	putObject,
	removeBucket,
} from '../src/storage/s3'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

// two distinct payloads, as an ingestion run would have stored them
const PAYLOAD_A = Buffer.from(
	`%PDF-1.4 restore-drill original A ${crypto.randomUUID()}\n`.repeat(8),
)
const PAYLOAD_B = Buffer.from(
	`restore-drill original B ${crypto.randomUUID()}\nsecond line\n`,
)
const PAYLOADS: Array<{
	payload: Buffer
	mime: string
	sha256: string
	storageKey: string
	fileId: string
}> = []

// padding objects on a second prefix: push the full-bucket listing past
// the 1000-key page so the restore drill exercises listObjects pagination
const PAD_COUNT = 1200
const padKey = (i: number) => `pads/pad-${String(i).padStart(5, '0')}`
const padPayload = (i: number) =>
	Buffer.from(`drill pad ${i} ${crypto.randomUUID()}\n`)

let tenantId: string
let cfg: Config
let cfgDrill: Config
let drillBucket: string

/** run an async op over items in bounded-parallel batches */
async function batched<T>(
	items: T[],
	size: number,
	op: (item: T) => Promise<void>,
): Promise<void> {
	for (let i = 0; i < items.length; i += size)
		await Promise.all(items.slice(i, i + size).map(op))
}

beforeAll(async () => {
	await ensureMigrations()
	cfg = loadConfig()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`storage-drill-t-${suffix}`}, 'Storage Restore Drill') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Storage Drill Kitab', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'processing') returning id`

	// the drill owns its bucket, so a FULL-bucket disaster is safe on the
	// shared dev MinIO as well as in CI's fresh container
	drillBucket = `aifiqh-drill-${suffix}`
	cfgDrill = { ...cfg, storageBucket: drillBucket }
	await createBucket(cfg, drillBucket)

	for (const payload of [
		{ payload: PAYLOAD_A, mime: 'application/pdf' },
		{ payload: PAYLOAD_B, mime: 'text/plain' },
	]) {
		const sha256 = createHash('sha256').update(payload.payload).digest('hex')
		const storageKey = contentKey(sha256)
		// the object is fully written BEFORE any revision row exists (upload
		// route invariant) — the drill reproduces that order
		await putObject(cfgDrill, storageKey, payload.payload, payload.mime)
		const [file] = await sql<{ id: string }[]>`
			insert into source_files (source_revision_id, sha256, storage_key, mime_type, size_bytes)
			values (${rev.id}::uuid, ${sha256}, ${storageKey}, ${payload.mime}, ${payload.payload.length})
			returning id`
		PAYLOADS.push({
			...payload,
			sha256,
			storageKey,
			fileId: file.id,
		})
	}
	await batched(
		Array.from({ length: PAD_COUNT }, (_, i) => i),
		25,
		(i) => putObject(cfgDrill, padKey(i), padPayload(i), 'text/plain'),
	)
})

afterAll(async () => {
	// best-effort: leave no 1200-object bucket behind on the dev MinIO
	try {
		const keys = await listObjects(cfgDrill, '')
		await batched(keys, 25, (k) => deleteObject(cfgDrill, k))
		await removeBucket(cfg, drillBucket)
	} catch {
		// the drill may have failed before the bucket existed
	}
	await sql.end()
})

describe('REL-HARD-004 storage leg: full-bucket backup, loss, restore, reconcile', () => {
	test('whole-bucket loss is detectable and restore is complete and byte-exact', async () => {
		// --- backup: enumerate EVERY key (pagination included) -------------
		const listed = await listObjects(cfgDrill, '')
		expect(listed.length).toBe(PAYLOADS.length + PAD_COUNT)
		for (const p of PAYLOADS) expect(listed).toContain(p.storageKey)
		const snapshot = new Map<string, { body: Buffer; mime: string }>()
		await batched(listed, 25, async (key) => {
			const res = await getObject(cfgDrill, key)
			expect(res.ok).toBeTrue()
			snapshot.set(key, {
				body: Buffer.from(await res.arrayBuffer()),
				mime: 'application/octet-stream',
			})
		})
		expect(snapshot.size).toBe(listed.length)

		// --- disaster: the ENTIRE bucket is emptied ------------------------
		// safe because the bucket belongs to this drill run alone
		await batched(listed, 25, (k) => deleteObject(cfgDrill, k))
		expect(await listObjects(cfgDrill, '')).toEqual([])
		for (const p of PAYLOADS) {
			expect(await headObject(cfgDrill, p.storageKey)).toEqual({
				exists: false,
			})
			const gone = await getObject(cfgDrill, p.storageKey)
			expect(gone.ok).toBeFalse()
		}

		// --- restore from the backup snapshot ------------------------------
		await batched([...snapshot], 25, ([key, entry]) =>
			putObject(cfgDrill, key, entry.body, entry.mime),
		)

		// --- reconcile the key set: nothing lost, nothing extra ------------
		const restored = await listObjects(cfgDrill, '')
		expect([...restored].sort()).toEqual([...listed].sort())

		// --- reconcile every object byte-exact against the snapshot --------
		await batched(restored, 25, async (key) => {
			const res = await getObject(cfgDrill, key)
			expect(res.ok).toBeTrue()
			const bytes = Buffer.from(await res.arrayBuffer())
			expect(bytes.equals(snapshot.get(key)!.body)).toBeTrue()
		})

		// --- reconcile against the immutable source_files rows -------------
		const rows = await sql<
			{
				id: string
				sha256: string
				storage_key: string
				size_bytes: string
			}[]
		>`select f.id, f.sha256, f.storage_key, f.size_bytes
			from source_files f
			join source_revisions sr on sr.id = f.source_revision_id
			join sources s on s.id = sr.source_id
			where s.tenant_id = ${tenantId}::uuid`
		expect(rows.length).toBe(PAYLOADS.length)
		const byKey = new Map(PAYLOADS.map((p) => [p.storageKey, p]))
		for (const row of rows) {
			// content addressing survived the round trip: the row's key is
			// exactly where the hash says the bytes must live
			expect(row.storage_key).toBe(contentKey(row.sha256))
			const stat = await headObject(cfgDrill, row.storage_key)
			expect(stat.exists).toBeTrue()
			expect(stat.size).toBe(Number(row.size_bytes))
			const res = await getObject(cfgDrill, row.storage_key)
			expect(res.ok).toBeTrue()
			const bytes = Buffer.from(await res.arrayBuffer())
			// byte-exact: hash of served bytes == the hash the DB pinned
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256)
			expect(bytes.equals(byKey.get(row.storage_key)!.payload)).toBeTrue()
		}
	}, 300_000)
})
