import type { Principal } from '@aifiqh/shared'
import { scopedTransaction } from '../db/client'
import type { Sql } from '../db/client'

/**
 * Knowledge Studio health & work dashboard (STU-003, DB-019 views).
 *
 * One authorized snapshot per principal:
 *  - source health / open work / release health come from the
 *    security_invoker dashboard views (0021), filtered to the caller's
 *    tenant — RLS applies underneath;
 *  - failed ingestion jobs and broken knowledge links are counted with
 *    the SAME predicates as their drill-down list endpoints, so card
 *    counts and drill-down totals reconcile 1:1;
 *  - open (non-superseded) feedback is grouped by category;
 *  - every card carries drill-down links to existing actionable routes
 *    and states its last refresh time.
 */

export const STUDIO_DASHBOARD_VERSION = 'studio-dashboard-v1'

export interface StudioCard {
	key: string
	label: string
	/** the primary authorized count for this card */
	counts: Record<string, number>
	drilldown: Array<{ kind: string; label: string; href: string }>
}

export interface StudioDashboard {
	version: string
	tenantId: string
	generatedAt: string
	cards: StudioCard[]
}

export async function getStudioDashboard(
	sql: Sql,
	principal: Principal,
): Promise<StudioDashboard> {
	const tenantId = principal.tenantId

	// the 0024 dashboard views filter by app_tenant(); they must be read
	// inside a tenant-scoped transaction (RLS posture, security_invoker)
	const viewCounts = await scopedTransaction(sql, tenantId, async (tx) => {
		const [sourceHealth] = await tx<
			{
				revisions_processing: string
				revisions_active: string
				revisions_deprecated: string
				sources_unknown_rights: string
			}[]
		>`select revisions_processing::text, revisions_active::text,
				revisions_deprecated::text, sources_unknown_rights::text
			from dashboard_source_health_v`

		const [openWork] = await tx<
			{
				changesets_draft: string
				changesets_submitted: string
				changesets_changes_requested: string
				stale_concepts: string
			}[]
		>`select changesets_draft::text, changesets_submitted::text,
				changesets_changes_requested::text, stale_concepts::text
			from dashboard_open_work_v`

		const [releaseHealth] = await tx<
			{
				knowledge_releases_published: string
				index_releases_promoted: string
				failed_gates: string
			}[]
		>`select knowledge_releases_published::text, index_releases_promoted::text,
				failed_gates::text
			from dashboard_release_health_v`
		return { sourceHealth, openWork, releaseHealth }
	})
	const { sourceHealth, openWork, releaseHealth } = viewCounts

	// failed jobs — same predicate as listFailedJobs
	const [failedJobs] = await sql<{ n: string }[]>`
		select count(*) as n from ingestion_jobs ij
		join source_revisions sr on sr.id = ij.source_revision_id
		join sources s on s.id = sr.source_id
		where s.tenant_id = ${tenantId}::uuid
			and ij.status in ('failed', 'dead')`

	// broken links — same predicate as listBrokenLinks: an active link
	// whose target revision is deprecated, or a concept-only target whose
	// concept has no non-deprecated revisions left
	const [brokenLinks] = await sql<{ n: string }[]>`
		select count(*) as n
		from knowledge_links kl
		join knowledge_concept_revisions fcr on fcr.id = kl.from_revision_id
		join knowledge_concepts fc on fc.id = fcr.concept_id
		left join knowledge_concept_revisions tcr on tcr.id = kl.to_revision_id
		left join knowledge_concepts tc on tc.id = kl.to_concept_id
		where kl.active and fc.tenant_id = ${tenantId}::uuid
			and (
				(kl.to_revision_id is not null and tcr.lifecycle_status in ('superseded', 'rejected'))
				or (kl.to_revision_id is null and (
					select count(*) from knowledge_concept_revisions cr2
					where cr2.concept_id = tc.id and cr2.lifecycle_status not in ('superseded', 'rejected')
				) = 0)
			)`

	// open (non-superseded) feedback on this tenant's conversations
	const feedbackRows = await sql<{ category: string; n: string }[]>`
		select af.category, count(*) as n
		from answer_feedback af
		join messages m on m.id = af.message_id
		join conversations c on c.id = m.conversation_id
		where c.tenant_id = ${tenantId}::uuid and af.superseded_by is null
		group by af.category`
	const openFeedback: Record<string, number> = {}
	let openFeedbackTotal = 0
	for (const r of feedbackRows) {
		openFeedback[r.category] = Number(r.n)
		openFeedbackTotal += Number(r.n)
	}

	const cards: StudioCard[] = [
		{
			key: 'source_health',
			label: 'Kesehatan Sumber',
			counts: {
				revisions_processing: Number(sourceHealth?.revisions_processing ?? 0),
				revisions_active: Number(sourceHealth?.revisions_active ?? 0),
				revisions_deprecated: Number(sourceHealth?.revisions_deprecated ?? 0),
				sources_unknown_rights: Number(
					sourceHealth?.sources_unknown_rights ?? 0,
				),
			},
			drilldown: [
				{ kind: 'sources', label: 'Daftar sumber', href: '/sources' },
			],
		},
		{
			key: 'open_work',
			label: 'Pekerjaan Terbuka',
			counts: {
				changesets_draft: Number(openWork?.changesets_draft ?? 0),
				changesets_submitted: Number(openWork?.changesets_submitted ?? 0),
				changesets_changes_requested: Number(
					openWork?.changesets_changes_requested ?? 0,
				),
				stale_concepts: Number(openWork?.stale_concepts ?? 0),
			},
			drilldown: [
				{ kind: 'stale', label: 'Konsep basi', href: '/knowledge/stale' },
			],
		},
		{
			key: 'failed_jobs',
			label: 'Pekerjaan Gagal',
			counts: { failed: Number(failedJobs.n) },
			drilldown: [
				{
					kind: 'failed_jobs',
					label: 'Rincian pekerjaan gagal',
					href: '/studio/failed-jobs',
				},
			],
		},
		{
			key: 'broken_links',
			label: 'Tautan Rusak',
			counts: { broken: Number(brokenLinks.n) },
			drilldown: [
				{
					kind: 'broken_links',
					label: 'Rincian tautan rusak',
					href: '/studio/broken-links',
				},
			],
		},
		{
			key: 'open_feedback',
			label: 'Umpan Balik Terbuka',
			counts: { total: openFeedbackTotal, ...openFeedback },
			drilldown: [
				{
					kind: 'feedback',
					label: 'Ringkasan umpan balik',
					href: '/feedback/summary',
				},
			],
		},
		{
			key: 'release_health',
			label: 'Kesehatan Rilis',
			counts: {
				knowledge_releases_published: Number(
					releaseHealth?.knowledge_releases_published ?? 0,
				),
				index_releases_promoted: Number(
					releaseHealth?.index_releases_promoted ?? 0,
				),
				failed_gates: Number(releaseHealth?.failed_gates ?? 0),
			},
			drilldown: [
				{
					kind: 'ops',
					label: 'Status operasional',
					href: '/ops/status',
				},
			],
		},
	]

	return {
		version: STUDIO_DASHBOARD_VERSION,
		tenantId,
		generatedAt: new Date().toISOString(),
		cards,
	}
}

export interface FailedJobRow {
	jobId: string
	sourceId: string
	sourceTitle: string
	revisionId: string
	status: string
	attempts: number
	maxAttempts: number
	lastError: Record<string, unknown> | null
	createdAt: string
	href: string
}

export async function listFailedJobs(
	sql: Sql,
	principal: Principal,
	options: { limit?: number; offset?: number } = {},
): Promise<{
	version: string
	jobs: FailedJobRow[]
	pagination: { limit: number; offset: number; total: number }
}> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
	const offset = Math.max(options.offset ?? 0, 0)
	const rows = await sql<
		{
			id: string
			source_id: string
			source_title: string
			revision_id: string
			status: string
			attempts: number
			max_attempts: number
			last_error: Record<string, unknown> | null
			created_at: string
		}[]
	>`select ij.id, s.id as source_id, s.title as source_title,
			sr.id as revision_id, ij.status, ij.attempts, ij.max_attempts,
			ij.last_error, ij.created_at
		from ingestion_jobs ij
		join source_revisions sr on sr.id = ij.source_revision_id
		join sources s on s.id = sr.source_id
		where s.tenant_id = ${principal.tenantId}::uuid
			and ij.status in ('failed', 'dead')
		order by ij.created_at desc
		limit ${limit} offset ${offset}`
	const [totalRow] = await sql<{ n: string }[]>`
		select count(*) as n from ingestion_jobs ij
		join source_revisions sr on sr.id = ij.source_revision_id
		join sources s on s.id = sr.source_id
		where s.tenant_id = ${principal.tenantId}::uuid
			and ij.status in ('failed', 'dead')`
	return {
		version: STUDIO_DASHBOARD_VERSION,
		jobs: rows.map((r) => ({
			jobId: r.id,
			sourceId: r.source_id,
			sourceTitle: r.source_title,
			revisionId: r.revision_id,
			status: r.status,
			attempts: r.attempts,
			maxAttempts: r.max_attempts,
			lastError: r.last_error,
			createdAt: new Date(r.created_at).toISOString(),
			href: `/sources/${r.source_id}`,
		})),
		pagination: { limit, offset, total: Number(totalRow.n) },
	}
}

export interface BrokenLinkRow {
	linkId: string
	fromConceptId: string
	fromRevisionId: string
	toConceptId: string | null
	toRevisionId: string | null
	relationshipType: string
	reason: 'target_revision_retired' | 'target_concept_exhausted'
	toHref: string
}

export async function listBrokenLinks(
	sql: Sql,
	principal: Principal,
	options: { limit?: number; offset?: number } = {},
): Promise<{
	version: string
	links: BrokenLinkRow[]
	pagination: { limit: number; offset: number; total: number }
}> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
	const offset = Math.max(options.offset ?? 0, 0)
	const rows = await sql<
		{
			id: string
			from_concept_id: string
			from_revision_id: string
			to_concept_id: string | null
			to_revision_id: string | null
			relationship_type: string
			to_concept_for_link: string | null
		}[]
	>`select kl.id, fc.id as from_concept_id, kl.from_revision_id::text,
			kl.to_concept_id::text, kl.to_revision_id::text,
			kl.relationship_type, coalesce(kl.to_concept_id::text, fcr.concept_id::text)
				as to_concept_for_link
		from knowledge_links kl
		join knowledge_concept_revisions fcr on fcr.id = kl.from_revision_id
		join knowledge_concepts fc on fc.id = fcr.concept_id
		left join knowledge_concept_revisions tcr on tcr.id = kl.to_revision_id
		left join knowledge_concepts tc on tc.id = kl.to_concept_id
		where kl.active and fc.tenant_id = ${principal.tenantId}::uuid
			and (
				(kl.to_revision_id is not null and tcr.lifecycle_status in ('superseded', 'rejected'))
				or (kl.to_revision_id is null and (
					select count(*) from knowledge_concept_revisions cr2
					where cr2.concept_id = tc.id and cr2.lifecycle_status not in ('superseded', 'rejected')
				) = 0)
			)
		order by kl.created_at desc
		limit ${limit} offset ${offset}`
	const [totalRow] = await sql<{ n: string }[]>`
		select count(*) as n
		from knowledge_links kl
		join knowledge_concept_revisions fcr on fcr.id = kl.from_revision_id
		join knowledge_concepts fc on fc.id = fcr.concept_id
		left join knowledge_concept_revisions tcr on tcr.id = kl.to_revision_id
		left join knowledge_concepts tc on tc.id = kl.to_concept_id
		where kl.active and fc.tenant_id = ${principal.tenantId}::uuid
			and (
				(kl.to_revision_id is not null and tcr.lifecycle_status in ('superseded', 'rejected'))
				or (kl.to_revision_id is null and (
					select count(*) from knowledge_concept_revisions cr2
					where cr2.concept_id = tc.id and cr2.lifecycle_status not in ('superseded', 'rejected')
				) = 0)
			)`
	return {
		version: STUDIO_DASHBOARD_VERSION,
		links: rows.map((r) => ({
			linkId: r.id,
			fromConceptId: r.from_concept_id,
			fromRevisionId: r.from_revision_id,
			toConceptId: r.to_concept_id,
			toRevisionId: r.to_revision_id,
			relationshipType: r.relationship_type,
			reason:
				r.to_revision_id !== null
					? 'target_revision_retired'
					: 'target_concept_exhausted',
			toHref: `/knowledge/concepts/${r.to_concept_for_link}`,
		})),
		pagination: { limit, offset, total: Number(totalRow.n) },
	}
}
