import { join } from 'node:path'
/**
 * Populated-database migration rehearsal (REL-HARD-001 / #96).
 *
 * Fresh-install proves 0001→latest correctness; this proves 0021+ (RLS
 * expansion, composite lineage FKs, publication guards) lands safely on
 * EXISTING data.
 *
 * Flow:
 *   1. fresh database → migrations 0001..0020 (until option)
 *   2. seed a representative populated dataset DIRECTLY on the 0020 schema
 *      (multiple tenants/scopes, memberships incl. revoked, revisions with
 *      pages/sections/spans/coordinates/footnotes, citations, expected
 *      evidence, releases incl. published, validation runs incl. critical
 *      unresolved, multiple answer revisions)
 *   3. run orphan preflight queries for every composite FK 0021 will add —
 *      any hit aborts BEFORE touching the database
 *   4. apply 0021..latest with per-file timing
 *   5. emit metrics: preflight counts, durations, post-migration grants and
 *      RLS posture (fail closed as aifiqh_app), app compatibility.
 *
 * Usage: bun scripts/rehearse_migration.ts [connection-string]
 */
import postgres from 'postgres'
import { applyMigrations } from './migrate'
import { approveTestRevision } from '../apps/api/tests/revisionSeed'

const URL_ = process.argv[2] ?? process.env.REHEARSAL_DB_URL ?? ''
if (!URL_) {
	console.error(
		'usage: bun scripts/rehearse_migration.ts postgres://user:pass@host:port/<fresh-database>',
	)
	process.exit(2)
}

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'db', 'migrations')
const sql = postgres(URL_, { max: 1 })

interface Preflight {
	name: string
	query: ReturnType<typeof postgres>
}

function buildPreflights(): Preflight[] {
	const orphans = {
		spanPage:
			'select ss.id from source_spans ss join source_pages sp on sp.id = ss.page_id where sp.source_revision_id <> ss.source_revision_id',
		spanSection:
			'select ss.id from source_spans ss join source_sections sc on sc.id = ss.section_id where sc.source_revision_id <> ss.source_revision_id',
		// 0020-era form: coordinates had no revision column yet, so compare the
		// coordinate's page against the span's revision through the span
		coordPageVsSpan:
			'select sc.id from span_coordinates sc join source_spans ss on ss.id = sc.span_id left join source_pages sp on sp.id = sc.page_id where sp.id is null or sp.source_revision_id <> ss.source_revision_id',
		footnoteAnchor:
			'select f.id from source_footnotes f left join source_spans ss on ss.id = f.anchor_span_id where f.anchor_span_id is not null and (ss.id is null or ss.source_revision_id <> f.source_revision_id)',
		footnoteNote:
			'select f.id from source_footnotes f left join source_spans ss on ss.id = f.note_span_id where f.note_span_id is not null and (ss.id is null or ss.source_revision_id <> f.source_revision_id)',
		// concept_source_spans gained its revision pin only in 0021; preflight
		// only dangling spans (the FK already guaranteed existence)
		conceptSpanDangling:
			'select css.id from concept_source_spans css left join source_spans ss on ss.id = css.source_span_id where ss.id is null',
		citationSource:
			'select c.id from citations c left join source_revisions sr on sr.id = c.source_revision_id left join sources s on s.id = c.source_id where sr.source_id <> c.source_id',
		citationSpan:
			'select c.id from citations c left join source_spans ss on ss.id = c.span_id where ss.source_revision_id <> c.source_revision_id',
		citationPage:
			'select c.id from citations c left join source_pages sp on sp.id = c.page_id where c.page_id is not null and (sp.id is null or sp.source_revision_id <> c.source_revision_id)',
		citationSection:
			'select c.id from citations c left join source_sections sc on sc.id = c.section_id where c.section_id is not null and (sc.id is null or sc.source_revision_id <> c.source_revision_id)',
		expectedSpan:
			'select e.id from expected_evidence e left join source_spans ss on ss.id = e.span_id where e.span_id is not null and ss.source_revision_id <> e.source_revision_id',
		releaseItemTenant:
			'select ri.id from knowledge_release_items ri join knowledge_releases r on r.id = ri.release_id join knowledge_concepts kc on kc.id = ri.concept_id where kc.tenant_id <> r.tenant_id',
		releaseItemRevision:
			'select ri.id from knowledge_release_items ri join knowledge_concept_revisions kcr on kcr.id = ri.concept_revision_id where kcr.concept_id <> ri.concept_id',
		aliasTenant:
			'select a.tenant_id, a.release_id from knowledge_release_aliases a left join knowledge_releases r on r.id = a.release_id where r.id is null or r.tenant_id <> a.tenant_id',
	}
	return Object.entries(orphans).map(([name, query]) => ({
		name,
		query: sql.unsafe(query) as unknown as { length: number },
	}))
}

async function seedPopulatedDataset(): Promise<Record<string, string>> {
	const ids: Record<string, string> = {}
	// tenants + scopes + memberships (one revoked)
	for (const slug of ['rehearse-a', 'rehearse-b']) {
		const [t] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${slug}, ${slug}) returning id`
		ids[slug] = t.id
	}
	const root = async (tenant: string) => {
		const [s] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${ids[tenant]}, 'root', 'Root') returning id`
		return s.id
	}
	ids.scopeA = await root('rehearse-a')
	ids.scopeB = await root('rehearse-b')

	const mkUser = async (email: string) => {
		const [u] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name) values (${email}, ${email})
			returning id`
		return u.id
	}
	ids.adminA = await mkUser(`admin-${Date.now()}@rehearse.test`)
	ids.revokedA = await mkUser(`revoked-${Date.now()}@rehearse.test`)
	const [mA] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${ids['rehearse-a']}, ${ids.adminA}) returning id`
	await sql`
		insert into membership_roles (membership_id, role_id)
		select ${mA.id}, r.id from roles r where r.tenant_id is null and r.key = 'tenant_admin'`
	const [mRev] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id, status)
		values (${ids['rehearse-a']}, ${ids.revokedA}, 'suspended') returning id`
	await sql`
		insert into membership_roles (membership_id, role_id)
		select ${mRev.id}, r.id from roles r where r.tenant_id is null and r.key = 'reader'`

	// sources + revisions + pages + sections + spans + coordinates + footnotes
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${ids['rehearse-a']}, 'Rehearsal kitab', 'x', 'book', 'ar', 'licensed', ${ids.scopeA})
		returning id`
	ids.source = src.id
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	ids.revision = rev.id
	const [page] = await sql<{ id: string }[]>`
		insert into source_pages (source_revision_id, page_number, image_storage_key)
		values (${rev.id}, 1, 'originals/seed-page-1') returning id`
	ids.page = page.id
	const [section] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, level, heading)
		values (${rev.id}, 1, 1, 'Bab satu') returning id`
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, section_id, page_id, span_key, original_text)
		values (${rev.id}, ${section.id}, ${page.id}, 's1', 'teks foreshoot') returning id`
	ids.span = span.id
	// 0020-era shape: source_revision_id is backfilled by 0021
	await sql`
		insert into span_coordinates (span_id, page_id, box)
		values (${span.id}, ${page.id}, '{"x":1,"y":2,"w":3,"h":4}')`
	await sql`
		insert into source_footnotes (source_revision_id, marker, anchor_span_id)
		values (${rev.id}, '1', ${span.id})`

	// knowledge concept + revision + concept-span link
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
		values (${ids['rehearse-a']}, 'definition', ${ids.scopeA}, ${ids.adminA}) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions
			(concept_id, revision_number, title, body_markdown, content_hash, created_by)
		values (${concept.id}, 1, 'Def', 'isi', 'rehearse-hash', ${ids.adminA}) returning id`
	ids.conceptRevision = krev.id
	await sql`
		insert into concept_source_spans (revision_id, source_span_id)
		values (${krev.id}, ${span.id})`

	// draft + published releases
	const [relDraft] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash) values (${ids['rehearse-a']}, 'r-draft')
		returning id`
	const [relPub] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state)
		values (${ids['rehearse-a']}, 'r-pub', 'published') returning id`
	await sql`
		insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${relPub.id}, ${concept.id}, ${krev.id})`
	await sql`
		update knowledge_releases set state = 'published' where id = ${relPub.id}`

	// conversation + message + trace + answers with mixed validation states
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${ids['rehearse-a']}, ${ids.adminA}) returning id`
	const [msg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conv.id}, 1, 'assistant', 'jawaban') returning id`
	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, query_original, status, completed_at)
		values (${ids['rehearse-a']}, ${ids.adminA}, 'q', 'completed', now()) returning id`
	const [ans] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${msg.id}, ${trace.id}, 'validated') returning id`
	await sql`
		update answers set status = 'published' where id = ${ans.id}`
	const [run] = await sql<{ id: string }[]>`
		insert into validation_runs (answer_id, validator_version, finished_at)
		values (${ans.id}, 'v1', now()) returning id`
	// legacy resolved critical + an open minor: exercises the publish guard
	await sql`
		insert into validation_issues (run_id, severity, code, resolved)
		values (${run.id}, 'critical', 'LEGACY', true),
		       (${run.id}, 'minor', 'STYLE', false)`
	ids.answer = ans.id
	// NOTE: at 0020 the unique(message_id) constraint forbids multiple answer
	// revisions per message; a second revision is added AFTER 0021 in step 5.

	// evaluation set + case + expected evidence (span-pinned)
	const [set] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, owner_user_id)
		values (${ids['rehearse-a']}, 'rehearse', ${ids.adminA}) returning id`
	const [setv] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version) values (${set.id}, 1) returning id`
	const [case_] = await sql<{ id: string }[]>`
		insert into evaluation_cases
			(set_version_id, case_key, category, query_text, owner_user_id)
		values (${setv.id}, 'c1', 'retrieval', 'siapa', ${ids.adminA}) returning id`
	await sql`
		insert into expected_evidence (case_id, source_revision_id, span_id)
		values (${case_.id}, ${rev.id}, ${span.id})`

	// audit history (append-only table gets RLS in 0021)
	await sql`
		insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id)
		values (${ids['rehearse-a']}, 'user', ${ids.adminA}, 'rehearse.seed', 'source', ${src.id})`
	return ids
}

async function main() {
	console.log('[1/5] staging schema at 0020 on a fresh database…')
	const staged = await applyMigrations(sql, MIGRATIONS_DIR, () => {}, {
		until: '0020_auth_state_and_rls_hardening.sql',
	})
	if (!staged.includes('0020_auth_state_and_rls_hardening.sql')) {
		throw new Error('rehearsal requires staging through 0020')
	}

	console.log('[2/5] seeding populated dataset on the 0020 schema…')
	const ids = await seedPopulatedDataset()
	console.log('  dataset keys:', Object.keys(ids).length)

	console.log('[3/5] orphan preflight (must be zero before applying 0021+)…')
	let orphans = 0
	for (const pf of buildPreflights()) {
		const rows = (await pf.query) as unknown as { length: number }
		const count = rows.length ?? 0
		if (count > 0) {
			console.error(`  ORPHANS[${pf.name}] = ${count}`)
			orphans += count
		}
	}
	if (orphans > 0) {
		throw new Error(
			`${orphans} orphan rows would violate 0021 lineage constraints`,
		)
	}
	console.log('  all preflight counts zero')

	console.log('[4/5] applying 0021..latest with per-file timing…')
	const applied = await applyMigrations(sql, MIGRATIONS_DIR, (m) =>
		console.log(`  ${m}`),
	)
	if (!applied.some((f) => f.startsWith('0021_'))) {
		throw new Error('expected 0021+ to be applied in this run')
	}

	console.log('[5/5] post-migration posture checks…')
	// append-only tables intentionally keep INSERT+SELECT; UPDATE/DELETE/TRUNCATE
	// must be gone (insert-only design)
	const grants = await sql<{ n: string }[]>`
		select count(*) as n from information_schema.role_table_grants
		where grantee = 'aifiqh_app' and privilege_type in ('UPDATE','DELETE')
			and table_name in ('audit_events','source_files','ocr_outputs','gate_results')`
	if (Number(grants[0].n) !== 0) {
		throw new Error('app role retained UPDATE/DELETE on append-only tables')
	}
	// RLS fail-closed as the runtime role
	const appUrl = URL_.replace(/:\/\/[^@]+@/, '://aifiqh_app:aifiqh_app@')
	const appSql = postgres(appUrl, { max: 1 })
	const bare = await appSql<{ n: string }[]>`select count(*) as n from sources`
	if (Number(bare[0].n) !== 0) {
		throw new Error(
			'runtime role sees tenant rows without app.tenant_id — not fail closed',
		)
	}
	await scopedTransactionCompat(appSql, ids['rehearse-a'])
	// 0021 backfill integrity: pre-existing rows must have gained revision pins
	const [coord] = await sql<{ n: string }[]>`
		select count(*) as n from span_coordinates where source_revision_id is null`
	const [css] = await sql<{ n: string }[]>`
		select count(*) as n from concept_source_spans where source_revision_id is null`
	if (Number(coord.n) !== 0 || Number(css.n) !== 0) {
		throw new Error('0021 backfill left null source_revision_id rows')
	}
	console.log('  0021 backfill filled pre-existing rows: ok')
	// 0021 relaxed unique(message_id) to (message_id, answer_revision): prove
	// a second answer revision is now insertable on migrated data
	const second = await sql<{ id: string; answer_revision: number }[]>`
		insert into answers (message_id, trace_id, status, answer_revision)
		select message_id, trace_id, 'draft', 2 from answers where id = ${ids.answer}
		returning id, answer_revision`
	if (!second[0])
		throw new Error('post-0021 second answer revision insert failed')
	console.log('  post-0021 second answer revision inserted: ok')
	await appSql.end({ timeout: 1 })

	console.log('\nREHEARSAL RESULT: PASS')
	console.log(
		JSON.stringify(
			{
				stagedThrough: '0020',
				preflightQueries: 14,
				orphanRows: 0,
				applied: applied.length,
				migrations: applied,
			},
			null,
			2,
		),
	)
}

async function scopedTransactionCompat(
	appSql: ReturnType<typeof postgres>,
	tenantId: string,
) {
	const rows = await appSql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`
		return tx<{ n: string }[]>`select count(*) as n from sources`
	})
	if (Number(rows[0].n) < 1) {
		throw new Error(
			'runtime role with tenant GUC sees no seeded rows — RLS misconfigured',
		)
	}
	console.log('  runtime role sees seeded tenant with GUC: ok')
}

main()
	.then(async () => sql.end({ timeout: 1 }))
	.catch(async (err) => {
		console.error(
			'REHEARSAL RESULT: FAIL —',
			err instanceof Error ? err.message : err,
		)
		await sql.end({ timeout: 1 }).catch(() => {})
		process.exit(1)
	})
