import postgres from 'postgres'
import { loadConfig } from '../apps/api/src/config'
import {
	HashEmbeddingProvider,
	embedIndexRelease,
} from '../apps/api/src/index/embeddingService'
import { compileIndexRelease } from '../apps/api/src/index/indexCompiler'
/**
 * Ingest real initial Islamic data (Hadith Arbain An-Nawawi & Quranic Ahkam verses)
 * from public free APIs into tenant Alpha, publish knowledge releases,
 * compile the retrieval index, and activate the production aliases.
 */
import type { Principal } from '../packages/shared/src/index'
import { sha256Hex } from '../packages/shared/src/index'

const cfg = loadConfig()
const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 1 })

interface HadithArbainItem {
	no: number | string
	judul: string
	arab: string
	indo: string
}

interface QuranAyatItem {
	nomorAyat: number
	teksArab: string
	teksIndonesia: string
}

async function fetchHadithArbain(): Promise<HadithArbainItem[]> {
	console.log("Fetching Hadits Arba'in An-Nawawiyyah...")
	const res = await fetch('https://api.myquran.com/v2/hadits/arbain/semua')
	if (!res.ok) throw new Error(`Failed to fetch hadith: ${res.status}`)
	const json = (await res.json()) as { data: HadithArbainItem[] }
	return json.data
}

async function fetchQuranSurah(
	surahNum: number,
): Promise<{ namaLatin: string; ayat: QuranAyatItem[] }> {
	console.log(`Fetching Qur'an Surah ${surahNum}...`)
	const res = await fetch(`https://equran.id/api/v2/surat/${surahNum}`)
	if (!res.ok)
		throw new Error(`Failed to fetch surah ${surahNum}: ${res.status}`)
	const json = (await res.json()) as {
		data: { namaLatin: string; ayat: QuranAyatItem[] }
	}
	return { namaLatin: json.data.namaLatin, ayat: json.data.ayat }
}

async function main() {
	console.log('Starting ingestion of real Islamic jurisprudence data...')

	// 1. Fetch free API data
	const hadithList = await fetchHadithArbain()
	console.log(`Retrieved ${hadithList.length} hadiths from Arba'in An-Nawawi`)

	const baqarah = await fetchQuranSurah(2)
	const maidah = await fetchQuranSurah(5)

	// Filter key ahkam verses
	const baqarahAhkam = [183, 184, 185, 187, 222, 228, 275, 282]
	const maidahAhkam = [1, 3, 6, 38, 90]

	const quranVerses: {
		ref: string
		arab: string
		indo: string
		topic: string
	}[] = []
	for (const num of baqarahAhkam) {
		const ayat = baqarah.ayat.find((a) => a.nomorAyat === num)
		if (ayat) {
			quranVerses.push({
				ref: `QS. Al-Baqarah: ${num}`,
				arab: ayat.teksArab,
				indo: ayat.teksIndonesia,
				topic:
					num >= 183 && num <= 187
						? 'Puasa Ramadan'
						: num === 222
							? 'Thaharah & Haid'
							: num === 275
								? 'Muamalah & Larangan Riba'
								: 'Hukum Muamalah & Keluarga',
			})
		}
	}
	for (const num of maidahAhkam) {
		const ayat = maidah.ayat.find((a) => a.nomorAyat === num)
		if (ayat) {
			quranVerses.push({
				ref: `QS. Al-Ma'idah: ${num}`,
				arab: ayat.teksArab,
				indo: ayat.teksIndonesia,
				topic:
					num === 1
						? 'Akad'
						: num === 3
							? 'Makanan Halal & Haram'
							: num === 6
								? 'Wudhu & Tayammum'
								: num === 90
									? 'Keharaman Khamar & Judi'
									: 'Hukum Jinayat',
			})
		}
	}
	console.log(`Prepared ${quranVerses.length} selected ayat ahkam verses`)

	// 2. Resolve tenant alpha and admin
	const [tenant] = await sql<
		{ id: string }[]
	>`select id from tenants where slug = 'alpha'`
	if (!tenant)
		throw new Error("Tenant 'alpha' not found. Run bun scripts/seed.ts first.")
	const tenantId = tenant.id

	const [admin] = await sql<
		{ id: string }[]
	>`select id from users where primary_email = 'admin@example.com'`
	if (!admin) throw new Error("Admin user 'admin@example.com' not found.")
	const adminId = admin.id

	let scopeId = ''
	await sql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`
		const [scope] = await tx<{ id: string }[]>`
			select id from access_scopes where tenant_id = ${tenantId}::uuid and key = 'root'`
		if (!scope) throw new Error('Root access scope not found in tenant alpha.')
		scopeId = scope.id
	})

	const principal: Principal = {
		userId: adminId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: [
			'knowledge:read',
			'knowledge:draft',
			'review:publish',
			'config:manage',
		],
		scopes: [scopeId],
		actorType: 'user',
	}

	let kReleaseId = ''
	let configId = ''
	// revisions created this run — they land in pending_review (#108)
	const pendingRevisionIds: string[] = []

	// 3. Set up Sources in tenant Alpha
	// We run with app.tenant_id set for RLS compliance
	await sql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`

		// Clean previous initial sources if any with title matching
		const existingSources = await tx<{ id: string }[]>`
			select id from sources where tenant_id = ${tenantId}::uuid and title = any(${["Hadits Arba'in An-Nawawiyyah", "Al-Qur'an Al-Karim (Ayat-Ayat Ahkam)"]}::text[])`
		if (existingSources.length > 0) {
			console.log(
				`Found ${existingSources.length} existing demo sources, reusing/keeping current schema.`,
			)
		}

		// Source 1: Hadith Arbain
		const hadithTitle = "Hadits Arba'in An-Nawawiyyah"
		const hadithAuthor = 'Imam Yahya bin Sharaf An-Nawawi'
		const hadithEdition = "Matan Arba'in"
		const hadithPublisher = 'Maktabah Darul Hadits'
		const [srcHadith] = await tx<{ id: string }[]>`
				insert into sources (
					tenant_id, title, author, source_type, language, edition, publisher, rights_status, access_scope_id, created_by
				) values (
					${tenantId}::uuid, ${hadithTitle}, ${hadithAuthor}, 'book', 'ar', ${hadithEdition}, ${hadithPublisher}, 'public_domain', ${scopeId}::uuid, ${adminId}::uuid
				) returning id`

		// #108 editorial approval gate: revisions land in pending_review —
		// ingest never activates content; a reviewer does (see the end of
		// this script for how)
		const [revHadith] = await tx<{ id: string }[]>`
				insert into source_revisions (source_id, revision_number, status, created_by)
				values (${srcHadith.id}::uuid, 1, 'pending_review', ${adminId}::uuid) returning id`
		pendingRevisionIds.push(revHadith.id)

		for (const h of hadithList) {
			const spanKey = `hadith-arbain-${String(h.no).padStart(2, '0')}`
			const text = `[Hadits Arba'in No. ${h.no}: ${h.judul}]\n${h.arab}\nArtinya: ${h.indo}`
			await tx`
					insert into source_spans (source_revision_id, span_key, original_text)
					values (${revHadith.id}::uuid, ${spanKey}, ${text})`
		}
		console.log(`Inserted ${hadithList.length} spans for Hadits Arba'in`)

		// Source 2: Quranic Ahkam
		const quranTitle = "Al-Qur'an Al-Karim (Ayat-Ayat Ahkam)"
		const quranAuthor = 'Kalamullah'
		const quranEdition = 'Mushaf Standar'
		const quranPublisher = 'Kemenag RI'
		const [srcQuran] = await tx<{ id: string }[]>`
				insert into sources (
					tenant_id, title, author, source_type, language, edition, publisher, rights_status, access_scope_id, created_by
				) values (
					${tenantId}::uuid, ${quranTitle}, ${quranAuthor}, 'book', 'ar', ${quranEdition}, ${quranPublisher}, 'public_domain', ${scopeId}::uuid, ${adminId}::uuid
				) returning id`

		const [revQuran] = await tx<{ id: string }[]>`
				insert into source_revisions (source_id, revision_number, status, created_by)
				values (${srcQuran.id}::uuid, 1, 'pending_review', ${adminId}::uuid) returning id`
		pendingRevisionIds.push(revQuran.id)

		for (let i = 0; i < quranVerses.length; i++) {
			const v = quranVerses[i]
			const spanKey = `quran-ahkam-${String(i + 1).padStart(2, '0')}`
			const text = `[${v.ref} - Topik: ${v.topic}]\n${v.arab}\nArtinya: ${v.indo}`
			await tx`
					insert into source_spans (source_revision_id, span_key, original_text)
					values (${revQuran.id}::uuid, ${spanKey}, ${text})`
		}
		console.log(`Inserted ${quranVerses.length} spans for Ayat-Ayat Ahkam`)

		// 4. Knowledge Concepts
		const concepts = [
			{
				title: 'Kaidah Niat dalam Ibadah (Al-Umuru bi Maqashidiha)',
				type: 'rule',
				body: 'Niat adalah rukun dan syarat sah penentu diterimanya setiap amal perbuatan dan ibadah. Berdasarkan Hadits Arba\'in No. 1: "Innamal a\'maalu bin-niyyaat" (Sesungguhnya setiap amalan bergantung pada niatnya). Niat membedakan antara kebiasaan adat dan ibadah, serta membedakan satu ibadah dengan ibadah lainnya.',
			},
			{
				title: 'Rukun dan Kewajiban Puasa Ramadan',
				type: 'rule',
				body: 'Puasa Ramadan adalah kewajiban fardhu \'ain bagi setiap orang beriman yang baligh, berakal, dan sanggup menunaikannya. Sebagaimana firman Allah dalam QS. Al-Baqarah: 183: "Wahai orang-orang yang beriman, diwajibkan atas kamu berpuasa sebagaimana diwajibkan atas orang-orang sebelum kamu agar kamu bertakwa". Rukun puasa meliputi niat di malam hari dan menahan diri dari segala hal yang membatalkan dari terbit fajar hingga terbenam matahari.',
			},
			{
				title: 'Tata Cara dan Rukun Wudhu serta Tayammum',
				type: 'rule',
				body: "Bersuci (Thaharah) merupakan syarat sah shalat. Firman Allah dalam QS. Al-Ma'idah: 6 menetapkan empat rukun fardhu wudhu: membasuh wajah, membasuh kedua tangan sampai ke siku, mengusap kepala, dan membasuh kedua kaki sampai kedua mata kaki. Apabila tidak menemukan air atau dalam kondisi sakit, diperbolehkan bersuci dengan tayammum menggunakan debu yang suci.",
			},
			{
				title: 'Kaidah Menghilangkan Kemudaratan (La Dharara wa La Dhirar)',
				type: 'rule',
				body: 'Salah satu kaidah fiqhiyyah asasiyah adalah larangan berbuat kemudaratan terhadap diri sendiri dan orang lain: "Tidak boleh membahayakan dan tidak boleh saling membahayakan" (Hadits Arba\'in No. 32). Kaidah ini menjadi landasan penetapan berbagai rukhsah (keringanan) dalam hukum Islam saat menghadapi kondisi darurat atau kesukaran (masyaqqah).',
			},
			{
				title: 'Keharaman Makanan Bangkai, Darah, dan Daging Babi',
				type: 'rule',
				body: "Hukum dasar makanan dalam Islam adalah halal kecuali yang diharamkan secara tegas oleh nash syariat. Dalam QS. Al-Ma'idah: 3, Allah mengharamkan bangkai, darah yang mengalir, daging babi, hewan yang disembelih tanpa menyebut nama Allah, dan hewan yang mati tercekik atau jatuh, kecuali yang sempat disembelih secara syar'i.",
			},
			{
				title: 'Hukum Halalnya Jual Beli dan Keharaman Riba',
				type: 'rule',
				body: 'Prinsip muamalah dalam Islam menegaskan kehalalan perniagaan yang saling ridha dan keharaman mutlak terhadap praktik riba. Firman Allah dalam QS. Al-Baqarah: 275: "Padahal Allah telah menghalalkan jual beli dan mengharamkan riba". Segala tambahan tanpa imbalan pengganti yang disyaratkan dalam transaksi pinjam meminjam atau pertukaran barang ribawi adalah terlarang.',
			},
			{
				title: "Meninggalkan Hal yang Meragukan (Syubhat dan Wara')",
				type: 'rule',
				body: 'Dalam fiqh dan akhlak Islam, seorang muslim dianjurkan berhati-hati terhadap perkara syubhat (samar hukumnya antara halal dan haram). Sebagaimana Hadits Arba\'in No. 6 dan No. 11: "Tinggalkanlah apa yang meragukanmu menuju apa yang tidak meragukanmu". Menjaga diri dari syubhat menyelamatkan agama dan kehormatan seorang muslim.',
			},
			{
				title: 'Pondasi Rukun Islam (Dasar Fiqh Ibadah)',
				type: 'rule',
				body: "Islam dibangun di atas lima fondasi utama (Hadits Arba'in No. 3): bersaksi bahwa tiada ilah yang berhak disembah selain Allah dan Muhammad adalah utusan Allah, mendirikan shalat lima waktu, menunaikan zakat, berpuasa di bulan Ramadan, dan menunaikan ibadah haji ke Baitullah bagi yang mampu.",
			},
		]

		const conceptRevisionIds: { conceptId: string; revisionId: string }[] = []
		for (const c of concepts) {
			const [concept] = await tx<{ id: string }[]>`
				insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
				values (${tenantId}::uuid, ${c.type}, ${scopeId}::uuid) returning id`

			const contentHash = sha256Hex(c.body)
			const [rev] = await tx<{ id: string }[]>`
				insert into knowledge_concept_revisions (
					concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
				) values (
					${concept.id}::uuid, 1, ${c.title}, ${c.body}, 'id', ${contentHash}, 'draft'
				) returning id`

			conceptRevisionIds.push({ conceptId: concept.id, revisionId: rev.id })
		}
		console.log(`Inserted ${concepts.length} knowledge concepts and revisions`)

		// 5. Knowledge Release
		const manifestHash = sha256Hex(
			JSON.stringify(conceptRevisionIds.map((r) => r.revisionId).sort()),
		)
		const [kRelease] = await tx<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenantId}::uuid, ${manifestHash}, 'created', ${adminId}::uuid) returning id`

		for (const r of conceptRevisionIds) {
			await tx`
				insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
				values (${kRelease.id}::uuid, ${r.conceptId}::uuid, ${r.revisionId}::uuid)`
		}

		await tx`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
		console.log(`Published knowledge release ${kRelease.id}`)

		// Point knowledge release alias 'production'
		await tx`
			insert into knowledge_release_aliases (tenant_id, alias, release_id, updated_by)
			values (${tenantId}::uuid, 'production', ${kRelease.id}::uuid, ${adminId}::uuid)
			on conflict (tenant_id, alias) do update set release_id = excluded.release_id, updated_by = excluded.updated_by, updated_at = now()`

		// 6. Index configuration
		const [profile] = await tx<{ id: string }[]>`
			insert into normalization_profiles (key, version, ruleset)
			values ('np-islamic-v1', 1, '{}')
			on conflict (key, version) do update set ruleset = excluded.ruleset
			returning id`

		const [model] = await tx<{ id: string }[]>`
			insert into embedding_models (provider, model_id, version, dimensions)
			values ('local', 'fiqh-emb-v1', '1', 768)
			on conflict (provider, model_id, version) do update set dimensions = excluded.dimensions
			returning id`

		const [config] = await tx<{ id: string }[]>`
			insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
			values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, 'cfg-fiqh-initial-v1')
			on conflict (config_hash) do update set compiler_version = excluded.compiler_version
			returning id`

		kReleaseId = kRelease.id
		configId = config.id
	})

	// 7. Editorial approval gate (#108): the revisions above are
	// pending_review and the index compiler only admits approved revisions —
	// compiling now would produce an empty corpus. Someone must review and
	// approve before anything becomes answerable:
	//   - Studio → Sumber → review panel, signed in as a reviewer, or
	//   - POST /api/sources/:sourceId/revisions/:revisionId/review
	// INGEST_AUTO_APPROVE=1 records the approval as the admin user running
	// this bootstrap (the operator is the reviewer on first setup) and
	// continues; without it the script stops here.
	if (process.env.INGEST_AUTO_APPROVE !== '1') {
		console.log(
			`\n⏸  ${pendingRevisionIds.length} revision(s) await editorial review (status pending_review).`,
		)
		console.log(
			'Approve them in Studio → Sumber, then rerun with INGEST_AUTO_APPROVE=1 to compile+promote the index.',
		)
		process.exit(0)
	}
	await sql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`
		for (const revId of pendingRevisionIds) {
			await tx`
				insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
				values (${tenantId}::uuid, ${revId}::uuid, 'approve', 'user', ${adminId},
					'bootstrap corpus review — public-domain Quran/Hadith texts verified during ingest')`
			await tx`update source_revisions set status = 'active' where id = ${revId}::uuid`
			await tx`
				insert into source_revision_status_events (source_revision_id, from_status, to_status, actor_type, actor_id, reason)
				values (${revId}::uuid, 'pending_review', 'active', 'user', ${adminId}, 'bootstrap approval')`
		}
	})
	console.log(
		`Approved ${pendingRevisionIds.length} revision(s) — recorded as editorial decisions with reviewer ${adminId}`,
	)

	// 8. Compile Index Release
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kReleaseId,
		configurationId: configId,
	})
	console.log(
		`Compiled index release ${compiled.indexReleaseId}: ${compiled.unitsCompiled} total retrieval units (${compiled.sourceUnits} source spans, ${compiled.knowledgeUnits} concepts)`,
	)

	// 9. Embed units with HashEmbeddingProvider
	const embedRes = await embedIndexRelease(
		sql,
		principal,
		compiled.indexReleaseId,
		new HashEmbeddingProvider('fiqh-emb-v1', '1', 768),
	)
	console.log(
		`Embedded index units: ${embedRes.embeddingsCreated} created, ${embedRes.embeddingsReused} reused`,
	)

	// 10. Promote Index Release & point production alias
	await sql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${tenantId}, true)`
		await tx`update index_releases set state = 'promoted' where id = ${compiled.indexReleaseId}::uuid`

		await tx`
			insert into index_aliases (tenant_id, alias, release_id, updated_by)
			values (${tenantId}::uuid, 'production', ${compiled.indexReleaseId}::uuid, ${adminId}::uuid)
			on conflict (tenant_id, alias) do update set release_id = excluded.release_id, updated_by = excluded.updated_by, updated_at = now()`
	})

	console.log(
		`Promoted index release ${compiled.indexReleaseId} to 'production' alias!`,
	)

	console.log('\n✅ Data ingestion & index compilation complete!')
	console.log(
		"You can now run conversations and queries against authentic Quran & Hadith Arba'in texts.",
	)
}

main()
	.then(() => sql.end({ timeout: 1 }))
	.catch(async (err) => {
		console.error('Ingestion failed:', err)
		await sql.end({ timeout: 1 })
		process.exit(1)
	})
