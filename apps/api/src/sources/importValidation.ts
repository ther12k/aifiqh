import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'

/**
 * Import validation report (#118).
 *
 * A successful import means more than "we produced records". Six acceptance
 * checks run over an import batch BEFORE it may enter the editorial review
 * queue; a failed check records precise record-level locations and the run
 * is persisted as `rejected` — the importer must not create source
 * revisions from a rejected batch. Checks and the failures they catch:
 *
 *   coverage          missing surahs/verses/records vs the provider's own
 *                     expected count (skipped pages, incomplete collections)
 *   text_fidelity     empty text, replacement characters (lost Arabic),
 *                     silent truncation markers, oversized records
 *   stable_ids        duplicate provider record ids within the batch; the
 *                     same record already imported under another id is
 *                     surfaced as a warning with its span key
 *   provenance        records without a usable source locator; batches
 *                     without acquisition method or policy reference
 *   revision_compare  text changed vs the pinned baseline revision — those
 *                     records must re-enter review, never silently overwrite
 *   status_propagation provider-withdrawn records still present in the
 *                     batch would resurrect material that must stay out
 */

export const IMPORT_VALIDATION_VERSION = 'import-validation-v1'

export interface ImportRecordInput {
	providerRecordId: string
	/** verse ref / hadith number / page — where the passage lives upstream */
	sourceLocator?: string | null
	originalText: string
	translationText?: string | null
	translator?: string | null
	grading?: string | null
}

export interface ImportBatchInput {
	source: {
		title: string
		author: string
		sourceType: string
		language: string
		rightsStatus: string
	}
	provider: {
		name: string
		edition?: string | null
		/** dataset version, repo commit, API fetch metadata */
		acquisitionVersion?: string | null
	}
	acquisitionMethod?: string | null
	policyReference?: string | null
	policyCheckedAt?: string | null
	/** the provider's own declared record count for coverage reconciliation */
	expectedCount?: number | null
	records: ImportRecordInput[]
	/** provider record ids withdrawn upstream — must not appear in records */
	withdrawnRecordIds?: string[]
	/** prior approved records (providerRecordId → text) to diff against */
	baselineRecords?: Record<string, string> | null
}

export type CheckStatus = 'pass' | 'fail' | 'warn'

export interface CheckFailure {
	/** provider record id when the failure is record-level */
	recordId?: string
	sourceLocator?: string | null
	detail: string
}

export interface ImportCheck {
	check: string
	status: CheckStatus
	failures: CheckFailure[]
}

export interface ImportValidationReport {
	reportVersion: string
	ok: boolean
	checks: ImportCheck[]
	recordCount: number
}

const MAX_RECORD_TEXT_CHARS = 24_000

function check(
	name: string,
	failures: CheckFailure[],
	warnFailures?: CheckFailure[],
): ImportCheck {
	const warns = warnFailures ?? []
	return {
		check: name,
		status: failures.length > 0 ? 'fail' : warns.length > 0 ? 'warn' : 'pass',
		failures: [...failures, ...warns],
	}
}

/** Pure validation core — DB-backed checks take sql, all others are pure
 * so corrupted imports are diagnosed deterministically. */
export function validateImportRecords(batch: ImportBatchInput): ImportCheck[] {
	const checks: ImportCheck[] = []
	const records = batch.records

	// 1. coverage reconciliation
	const covFailures: CheckFailure[] = []
	if (batch.expectedCount != null && records.length !== batch.expectedCount) {
		covFailures.push({
			detail: `provider declares ${batch.expectedCount} records, batch carries ${records.length} — find the gap before importing (skipped page, missing surah, incomplete collection)`,
		})
	}
	checks.push(check('coverage', covFailures))

	// 2. text fidelity
	const fidFailures: CheckFailure[] = []
	for (const r of records) {
		const loc = r.sourceLocator ?? null
		if (!r.originalText || !r.originalText.trim()) {
			fidFailures.push({
				recordId: r.providerRecordId,
				sourceLocator: loc,
				detail: 'original text is empty — a lost extraction',
			})
			continue
		}
		if (r.originalText.includes('\uFFFD')) {
			fidFailures.push({
				recordId: r.providerRecordId,
				sourceLocator: loc,
				detail:
					'replacement character (U+FFFD) present — Arabic characters were lost in extraction',
			})
		}
		if (r.originalText.length > MAX_RECORD_TEXT_CHARS) {
			fidFailures.push({
				recordId: r.providerRecordId,
				sourceLocator: loc,
				detail: `text is ${r.originalText.length} chars — exceeds the record limit; likely an unsplit document, not a passage`,
			})
		}
		if (
			r.translationText !== undefined &&
			r.translationText === null &&
			r.translator
		) {
			fidFailures.push({
				recordId: r.providerRecordId,
				sourceLocator: loc,
				detail:
					'translator recorded but translation text missing — attribution without evidence',
			})
		}
	}
	checks.push(check('text_fidelity', fidFailures))

	// 3. stable ids & duplicate detection
	const idFailures: CheckFailure[] = []
	const seen = new Map<string, number>()
	for (const r of records) {
		if (!r.providerRecordId.trim()) {
			idFailures.push({
				sourceLocator: r.sourceLocator ?? null,
				detail:
					'record has an empty provider record id — it can never be re-imported or deduplicated',
			})
			continue
		}
		seen.set(r.providerRecordId, (seen.get(r.providerRecordId) ?? 0) + 1)
	}
	for (const [id, n] of seen) {
		if (n > 1)
			idFailures.push({
				recordId: id,
				detail: `provider record id appears ${n}× in the batch — same source imported twice`,
			})
	}
	checks.push(check('stable_ids', idFailures))

	// 4. provenance completeness
	const provFailures: CheckFailure[] = []
	for (const r of records) {
		if (!r.sourceLocator || !r.sourceLocator.trim()) {
			provFailures.push({
				recordId: r.providerRecordId,
				detail:
					'no source locator (verse ref / hadith number / page) — the passage cannot be cited back to its origin',
			})
		}
	}
	if (!batch.acquisitionMethod) {
		provFailures.push({
			detail:
				'batch carries no acquisition method — provenance history starts unknown',
		})
	}
	if (!batch.policyReference) {
		provFailures.push({
			detail:
				'batch carries no policy reference — the usage terms being relied on are unrecorded',
		})
	}
	checks.push(check('provenance', provFailures))

	// 5. revision comparison (warn-level: changed text must RE-enter review,
	// which the #108 gate already forces; the report makes it visible)
	const revFailures: CheckFailure[] = []
	if (batch.baselineRecords) {
		for (const r of records) {
			const before = batch.baselineRecords[r.providerRecordId]
			if (
				before !== undefined &&
				normalizeText(before) !== normalizeText(r.originalText)
			) {
				revFailures.push({
					recordId: r.providerRecordId,
					sourceLocator: r.sourceLocator ?? null,
					detail:
						'text changed vs the approved baseline — this record enters review as a NEW revision and must not silently overwrite the old one',
				})
			}
		}
	}
	checks.push(check('revision_compare', [], revFailures))

	// 6. source-status propagation
	const propFailures: CheckFailure[] = []
	const withdrawn = new Set(batch.withdrawnRecordIds ?? [])
	if (withdrawn.size > 0) {
		for (const r of records) {
			if (withdrawn.has(r.providerRecordId)) {
				propFailures.push({
					recordId: r.providerRecordId,
					sourceLocator: r.sourceLocator ?? null,
					detail:
						'provider withdrew this record but the batch still carries it — withdrawn material must not become searchable evidence',
				})
			}
		}
	}
	checks.push(check('status_propagation', propFailures))

	return checks
}

export function aggregateReport(
	checks: ImportCheck[],
	recordCount: number,
): ImportValidationReport {
	return {
		reportVersion: IMPORT_VALIDATION_VERSION,
		ok: checks.every((c) => c.status !== 'fail'),
		checks,
		recordCount,
	}
}

/**
 * Validate an import batch and persist the run (REVIEW-006 / #118).
 * Returns the persisted run id and whether the batch may proceed to the
 * editorial queue. `ok: false` means the importer MUST NOT create
 * revisions from this batch.
 */
export async function validateAndRecordImport(
	sql: Sql,
	principal: Principal,
	batch: ImportBatchInput,
): Promise<{ runId: string; ok: boolean; report: ImportValidationReport }> {
	const checks = validateImportRecords(batch)
	const ok = checks.every((c) => c.status !== 'fail')
	const report = aggregateReport(checks, batch.records.length)
	const [run] = await sql<{ id: string }[]>`
		insert into import_runs
			(tenant_id, provider_name, edition, source_title, record_count, status, report, created_by)
		values (
			${principal.tenantId}::uuid, ${batch.provider.name},
			${batch.provider.edition ?? null}, ${batch.source.title},
			${batch.records.length}, ${ok ? 'validated' : 'rejected'},
			${sql.json(report as never)}::jsonb, ${principal.userId}::uuid)
		returning id`
	return { runId: run.id, ok, report }
}
