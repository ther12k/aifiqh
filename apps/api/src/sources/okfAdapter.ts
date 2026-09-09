import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'

/**
 * OKF v0.2 import/export adapter (#115).
 *
 * The Open Knowledge Format is the versioned import/export representation
 * of APPROVED knowledge — never a second editing authority (DB-first).
 * Spec pinned to GoogleCloudPlatform/open-knowledge-format v0.2:
 *   - plain markdown files with YAML frontmatter; concept id = path -.md
 *   - `type` is the only required key; consumers tolerate unknown types
 *   - reserved files: index.md (no frontmatter), log.md (newest-first log)
 *   - trust keys (verified, status) are ADVISORY — never authorization
 *
 * Content roles (review requirement):
 *   - type `fiqh-source-passage`  → evidence candidate (imported as spans)
 *   - everything else             → NOT evidence; recorded, never indexed
 *   - index.md / log.md           → operational, skipped
 *
 * Provenance rides in an `x-aifiqh` frontmatter map (spec allows producer
 * extensions); on import the body text becomes source_spans.original_text
 * BYTE-IDENTICAL so the QUOTE_MISMATCH gate passes against re-imported
 * passages. Imported revisions always enter pending_review (#108) — a
 * `verified:` key inside a file is not a reviewer decision.
 */

export const OKF_VERSION_SUPPORTED = '0.2'
export const OKF_PASSAGE_TYPE = 'fiqh-source-passage'
export const OKF_ADAPTER_VERSION = 'okf-adapter-v1'

export interface OkfDoc {
	path: string
	/** concept id: path minus .md, minus reserved files */
	conceptId: string | null
	role: 'passage' | 'editorial' | 'operational'
	frontmatter: Record<string, unknown>
	body: string
}

// ---------------------------------------------------------------------------
// minimal YAML-frontmatter parsing (subset sufficient for OKF docs:
// scalars, inline lists, block lists of scalars/maps, one-level maps)
// ---------------------------------------------------------------------------

export function parseFrontmatter(text: string): {
	frontmatter: Record<string, unknown> | null
	body: string
} {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!m) return { frontmatter: null, body: text }
	// canonical body: exactly one delimiter-newline stripped from the front,
	// trailing whitespace trimmed — round trips re-import byte-identical
	const body = m[2].replace(/^\r?\n/, '').replace(/\s+$/, '')
	return { frontmatter: parseYamlSubset(m[1]), body }
}

function parseScalar(raw: string): unknown {
	const v = raw.trim()
	if (
		(v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
		(v.startsWith("'") && v.endsWith("'") && v.length >= 2)
	)
		return v.slice(1, -1)
	if (v === 'true') return true
	if (v === 'false') return false
	if (v === 'null' || v === '' || v === '~') return null
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
	if (v.startsWith('[') && v.endsWith(']')) {
		const inner = v.slice(1, -1).trim()
		if (!inner) return []
		return inner.split(',').map((s) => parseScalar(s))
	}
	return v
}

export function parseYamlSubset(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	const lines = yaml.split(/\r?\n/)
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (!line.trim() || line.trim().startsWith('#')) {
			i++
			continue
		}
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
		if (!kv) {
			i++
			continue
		}
		const key = kv[1]
		const rest = kv[2]
		if (rest === '' || rest === undefined) {
			// block value: list or nested map by indentation
			const childIndent = (lines[i + 1] ?? '').match(/^(\s*)/)?.[1].length ?? -1
			const thisIndent = line.match(/^(\s*)/)?.[1].length ?? 0
			if (childIndent <= thisIndent) {
				result[key] = null
				i++
				continue
			}
			if ((lines[i + 1] ?? '').trimStart().startsWith('- ')) {
				const items: unknown[] = []
				i++
				while (i < lines.length && lines[i].trimStart().startsWith('- ')) {
					const itemIndent = lines[i].match(/^(\s*)/)?.[1].length ?? 0
					const first = lines[i].trimStart().slice(2)
					if (first.includes(':')) {
						// list of maps: gather this item's keyed lines
						const map: Record<string, unknown> = {}
						const itemKv = first.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
						if (itemKv) map[itemKv[1]] = parseScalar(itemKv[2])
						i++
						while (i < lines.length) {
							const l = lines[i]
							const ind = l.match(/^(\s*)/)?.[1].length ?? 0
							if (
								!l.trim() ||
								ind > itemIndent ||
								(ind === itemIndent && !l.trimStart().startsWith('- '))
							) {
								const mkv = l.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/)
								if (!l.trim() || !mkv) break
								map[mkv[1]] = parseScalar(mkv[2])
								i++
							} else break
						}
						items.push(map)
					} else {
						items.push(parseScalar(first))
						i++
					}
				}
				result[key] = items
			} else {
				const map: Record<string, unknown> = {}
				i++
				while (i < lines.length) {
					const l = lines[i]
					const ind = l.match(/^(\s*)/)?.[1].length ?? 0
					if (!l.trim() || ind <= thisIndent) break
					const mkv = l.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/)
					if (mkv) map[mkv[1]] = parseScalar(mkv[2])
					i++
				}
				result[key] = map
			}
		} else {
			result[key] = parseScalar(rest)
			i++
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// bundle parsing + role classification
// ---------------------------------------------------------------------------

export interface ParsedBundle {
	docs: OkfDoc[]
	conformanceFailures: Array<{ path: string; detail: string }>
}

export function parseBundle(files: Record<string, string>): ParsedBundle {
	const docs: OkfDoc[] = []
	const conformanceFailures: ParsedBundle['conformanceFailures'] = []
	for (const path of Object.keys(files).sort()) {
		if (!path.endsWith('.md')) continue
		const base = path.split('/').pop()!
		if (base === 'index.md' || base === 'log.md') {
			docs.push({
				path,
				conceptId: null,
				role: 'operational',
				frontmatter: {},
				body: files[path],
			})
			continue
		}
		const { frontmatter, body } = parseFrontmatter(files[path])
		if (
			!frontmatter ||
			typeof frontmatter.type !== 'string' ||
			!frontmatter.type
		) {
			conformanceFailures.push({
				path,
				detail:
					'OKF conformance: every concept needs frontmatter with a non-empty type',
			})
			docs.push({
				path,
				conceptId: null,
				role: 'operational',
				frontmatter: frontmatter ?? {},
				body,
			})
			continue
		}
		const role: OkfDoc['role'] =
			frontmatter.type === OKF_PASSAGE_TYPE ? 'passage' : 'editorial'
		docs.push({
			path,
			conceptId: path.replace(/\.md$/, ''),
			role,
			frontmatter,
			body,
		})
	}
	return { docs, conformanceFailures }
}

// ---------------------------------------------------------------------------
// exporter: approved revisions → bundle files
// ---------------------------------------------------------------------------

export interface OkfExport {
	okfVersion: string
	files: Record<string, string>
	exportedSpans: number
}

/** Export APPROVED (active) revisions of one source as an OKF bundle. */
export async function exportSourceRevisionToOkf(
	sql: Sql,
	principal: Principal,
	sourceId: string,
): Promise<OkfExport> {
	const [source] = await sql<
		{
			title: string
			author: string
			language: string
			edition: string | null
			publisher: string | null
			policy_reference: string | null
		}[]
	>`
		select title, author, language, edition, publisher, policy_reference
		from sources where id = ${sourceId}::uuid
			and tenant_id = ${principal.tenantId}::uuid limit 1`
	if (!source) throw new Error('source not found in tenant')

	const revisions = await sql<{ id: string; revision_number: number }[]>`
		select id, revision_number from source_revisions
		where source_id = ${sourceId}::uuid and status = 'active'
		order by revision_number desc`

	const files: Record<string, string> = {
		'index.md':
			`# ${source.title}\n\nExported Taffaqquh AI approved passages. ` +
			`OKF v${OKF_VERSION_SUPPORTED}; embeddings and approvals live in the database, not this bundle.\n`,
	}
	let exportedSpans = 0
	for (const rev of revisions) {
		const spans = await sql<
			{
				id: string
				span_key: string
				original_text: string
				madhhab: string[]
				stance: string
				grading: string | null
				grading_by: string | null
			}[]
		>`
			select id, span_key, original_text, madhhab, stance, grading, grading_by
			from source_spans where source_revision_id = ${rev.id}::uuid order by span_key`
		for (const span of spans) {
			const fm = [
				`type: ${OKF_PASSAGE_TYPE}`,
				`title: ${JSON.stringify(`${source.title} § ${span.span_key}`)}`,
				`description: ${JSON.stringify(`${source.author}${source.edition ? `, ${source.edition}` : ''} — passage ${span.span_key}`)}`,
				`language: ${source.language}`,
				'tags: [fiqh, source-passage]',
				'sources:',
				`  - id: ${span.span_key}`,
				`    resource: ${JSON.stringify(source.policy_reference ?? `aifiqh:source:${sourceId}`)}`,
				`    title: ${JSON.stringify(`${source.title}${source.edition ? ` (${source.edition})` : ''}`)}`,
				`    author: ${JSON.stringify(source.author)}`,
				'generated:',
				'  by: process:aifiqh-okf-export',
				'x-aifiqh:',
				`    source_id: ${sourceId}`,
				`    source_revision_id: ${rev.id}`,
				`    span_id: ${span.id}`,
				`    span_key: ${span.span_key}`,
				`    stance: ${span.stance}`,
				`    madhhab: [${span.madhhab.join(', ')}]`,
				...(span.grading
					? [
							`    grading: ${JSON.stringify(span.grading)}`,
							`    grading_by: ${JSON.stringify(span.grading_by ?? '')}`,
						]
					: []),
			].join('\n')
			files[`spans/${rev.revision_number}-${span.span_key}.md`] =
				`---\n${fm}\n---\n\n${span.original_text}\n`
			exportedSpans++
		}
	}
	return { okfVersion: OKF_VERSION_SUPPORTED, files, exportedSpans }
}

// ---------------------------------------------------------------------------
// importer: bundle → validation (#118) → source + pending_review revision
// ---------------------------------------------------------------------------

export interface OkfImportOutcome {
	ok: boolean
	sourceId: string | null
	revisionId: string | null
	revisionStatus: 'pending_review'
	spansImported: number
	operationalSkipped: number
	editorialSkipped: number
	failures: Array<{ path: string; detail: string }>
	validationRunId: string | null
}

/**
 * Import a bundle as a PROPOSED revision: passage docs become spans with
 * byte-identical text; everything else is skipped as non-evidence; trust
 * frontmatter is ignored — the revision lands pending_review (#108) and
 * must pass a human review before it can ever support an answer.
 */
export async function importOkfBundle(
	sql: Sql,
	principal: Principal,
	input: {
		bundle: Record<string, string>
		source: {
			title: string
			author: string
			language: string
			rightsStatus: string
		}
		provider: { name: string; edition?: string | null }
		accessScopeId: string
	},
): Promise<OkfImportOutcome> {
	const { validateAndRecordImport } = await import('./importValidation')
	const { checkAccess } = await import('../auth/policy')
	const outcome: OkfImportOutcome = {
		ok: false,
		sourceId: null,
		revisionId: null,
		revisionStatus: 'pending_review',
		spansImported: 0,
		operationalSkipped: 0,
		editorialSkipped: 0,
		failures: [],
		validationRunId: null,
	}

	const parsed = parseBundle(input.bundle)
	outcome.failures.push(...parsed.conformanceFailures)
	const passages = parsed.docs.filter((d) => d.role === 'passage')
	outcome.operationalSkipped = parsed.docs.filter(
		(d) => d.role === 'operational',
	).length
	outcome.editorialSkipped = parsed.docs.filter(
		(d) => d.role === 'editorial',
	).length
	if (passages.length === 0) {
		outcome.failures.push({
			path: '(bundle)',
			detail: `no ${OKF_PASSAGE_TYPE} docs — nothing to import as evidence`,
		})
		return outcome
	}

	// #118 gate first: the six checks over the passage set
	const scopeDecision = await checkAccess(
		sql,
		principal,
		'source:read',
		input.accessScopeId,
	)
	if (!scopeDecision.allowed) throw new Error('scope denied for import')
	const validation = await validateAndRecordImport(sql, principal, {
		source: {
			title: input.source.title,
			author: input.source.author,
			sourceType: 'book',
			language: input.source.language,
			rightsStatus: input.source.rightsStatus,
		},
		provider: {
			name: input.provider.name,
			edition: input.provider.edition ?? null,
			acquisitionVersion: `okf-bundle (${OKF_ADAPTER_VERSION})`,
		},
		acquisitionMethod: 'manual_entry',
		policyReference: 'okf-bundle-import (see #115)',
		expectedCount: null,
		records: passages.map((d) => {
			const xa = (d.frontmatter['x-aifiqh'] ?? {}) as Record<string, unknown>
			const sources = (d.frontmatter.sources ?? []) as Array<
				Record<string, unknown>
			>
			return {
				providerRecordId: String(xa.span_key ?? d.conceptId ?? d.path),
				sourceLocator: String(
					sources[0]?.id ?? xa.span_key ?? d.conceptId ?? d.path,
				),
				originalText: d.body.trimEnd(),
			}
		}),
	})
	outcome.validationRunId = validation.runId
	if (!validation.ok) {
		outcome.failures.push({
			path: '(validation)',
			detail:
				'import validation rejected the bundle — see the import_runs report',
		})
		return outcome
	}

	// create the source + PENDING_REVIEW revision; spans byte-identical
	await sql.begin(async (tx) => {
		await tx`select set_config('app.tenant_id', ${principal.tenantId}, true)`
		const [src] = await tx<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id, created_by,
				acquisition_method, parser_version)
			values (${principal.tenantId}::uuid, ${input.source.title}, ${input.source.author}, 'book',
				${input.source.language}, ${input.source.rightsStatus}, ${input.accessScopeId}::uuid,
				${principal.userId}::uuid, 'manual_entry', ${OKF_ADAPTER_VERSION})
			returning id`
		outcome.sourceId = src.id
		const [rev] = await tx<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status, created_by)
			values (${src.id}::uuid, 1, 'pending_review', ${principal.userId}::uuid)
			returning id`
		outcome.revisionId = rev.id
		for (const d of passages) {
			const xa = (d.frontmatter['x-aifiqh'] ?? {}) as Record<string, unknown>
			const spanKey = String(
				xa.span_key ?? d.conceptId?.split('/').pop() ?? d.path,
			)
			const text = d.body.trimEnd()
			await tx`
				insert into source_spans (source_revision_id, span_key, original_text)
				values (${rev.id}::uuid, ${spanKey}, ${text})`
			// round-trip honesty: byte-identical or the import reports it
			const [row] = await tx<{ original_text: string }[]>`
				select original_text from source_spans
				where source_revision_id = ${rev.id}::uuid and span_key = ${spanKey}`
			if (row.original_text !== text) {
				outcome.failures.push({
					path: d.path,
					detail: 'round-trip mismatch: stored text differs from bundle body',
				})
			}
			outcome.spansImported++
		}
	})
	outcome.ok =
		outcome.failures.length === 0 &&
		outcome.revisionId !== null &&
		outcome.spansImported > 0
	return outcome
}

/** Quote-gate compatibility: a citation quote from the bundle must match
 * the stored span under the same normalization the validator uses. */
export function quoteMatchesStoredSpan(quote: string, stored: string): boolean {
	return (
		stored.includes(quote) ||
		normalizeText(stored).includes(normalizeText(quote))
	)
}
