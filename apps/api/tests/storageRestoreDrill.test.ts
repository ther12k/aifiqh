import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { type Config, loadConfig } from '../src/config'
import {
	contentKey,
	deleteObject,
	getObject,
	headObject,
	listObjects,
	putObject,
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

let tenantId: string
let cfg: Config

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

	for (const payload of [
		{ payload: PAYLOAD_A, mime: 'application/pdf' },
		{ payload: PAYLOAD_B, mime: 'text/plain' },
	]) {
		const sha256 = createHash('sha256').update(payload.payload).digest('hex')
		const storageKey = contentKey(sha256)
		// the object is fully written BEFORE any revision row exists (upload
		// route invariant) — the drill reproduces that order
		await putObject(cfg, storageKey, payload.payload, payload.mime)
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
})

afterAll(async () => {
	await sql.end()
})

describe('REL-HARD-004 storage leg: object-store backup, loss, restore, reconcile', () => {
	test('drill proves loss is detectable and restore is byte-exact against source_files', async () => {
		// --- backup: enumerate the originals prefix and snapshot bytes -----
		const listed = await listObjects(cfg, 'originals/')
		for (const p of PAYLOADS) expect(listed).toContain(p.storageKey)
		const snapshot = new Map<string, { body: Buffer; mime: string }>()
		for (const p of PAYLOADS) {
			const res = await getObject(cfg, p.storageKey)
			expect(res.ok).toBeTrue()
			snapshot.set(p.storageKey, {
				body: Buffer.from(await res.arrayBuffer()),
				mime: p.mime,
			})
		}

		// --- disaster: the drill's objects vanish --------------------------
		// scoped to objects this drill created: a persistent dev bucket is
		// shared with every other test run; CI's bucket is fresh per run
		for (const p of PAYLOADS) await deleteObject(cfg, p.storageKey)
		for (const p of PAYLOADS) {
			expect(await headObject(cfg, p.storageKey)).toEqual({ exists: false })
			const gone = await getObject(cfg, p.storageKey)
			expect(gone.ok).toBeFalse()
		}

		// --- restore from the backup snapshot ------------------------------
		for (const [key, entry] of snapshot)
			await putObject(cfg, key, entry.body, entry.mime)

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
			const stat = await headObject(cfg, row.storage_key)
			expect(stat.exists).toBeTrue()
			expect(stat.size).toBe(Number(row.size_bytes))
			const res = await getObject(cfg, row.storage_key)
			expect(res.ok).toBeTrue()
			const bytes = Buffer.from(await res.arrayBuffer())
			// byte-exact: hash of served bytes == the hash the DB pinned
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256)
			expect(bytes.equals(byKey.get(row.storage_key)!.payload)).toBeTrue()
		}
	}, 120_000)
})
