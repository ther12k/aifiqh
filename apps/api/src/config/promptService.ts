import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Prompt versioning, review and promotion (CFG-002).
 *
 *  - promoted prompts are IMMUTABLE (DB trigger); the only legal exit is
 *    a retirement carrying a reason (rollback is audited);
 *  - required variables are validated against the body before a version
 *    can be promoted — a prompt referencing {{var}} without declaring it
 *    (or declaring an unused variable) is rejected;
 *  - generation pins the version via the configuration alias 'prompt'
 *    (answers store prompt_version_id);
 *  - promotion and rollback both require config:manage and both write
 *    audit events with before/after state.
 */

export const PROMPT_SERVICE_VERSION = 'prompt-service-v1'

export class PromptConfigError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'PromptConfigError'
		this.code = code
	}
}

export interface PromptVariable {
	name: string
	required: boolean
}

const VARIABLE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** Variables referenced in the body via {{name}} placeholders. */
export function extractBodyVariables(body: string): string[] {
	return [...new Set([...body.matchAll(VARIABLE_RE)].map((m) => m[1]))]
}

/**
 * Validate that declared variables cover the body: every {{var}} in the
 * body must be declared; declared-but-unused names are rejected too
 * (they mislead template consumers).
 */
export function validateVariables(
	body: string,
	declared: PromptVariable[],
): { ok: boolean; problems: string[] } {
	const problems: string[] = []
	const declaredNames = new Set(declared.map((v) => v.name))
	const bodyVars = extractBodyVariables(body)
	for (const name of bodyVars) {
		if (!declaredNames.has(name)) {
			problems.push(`body references {{${name}}} but it is not declared`)
		}
	}
	for (const v of declared) {
		if (!bodyVars.includes(v.name)) {
			problems.push(`declared variable ${v.name} is unused in the body`)
		}
	}
	return { ok: problems.length === 0, problems }
}

export interface CreatePromptVersionInput {
	templateKey: string
	body: string
	variables: PromptVariable[]
	description?: string | null
}

/** Create a draft prompt version (next sequential number). */
export async function createPromptVersion(
	sql: Sql,
	principal: Principal,
	input: CreatePromptVersionInput,
): Promise<{ id: string; templateId: string; version: number }> {
	const validation = validateVariables(input.body, input.variables)
	if (!validation.ok) {
		throw new PromptConfigError(
			'VARIABLES_INVALID',
			validation.problems.join('; '),
		)
	}
	return await sql.begin(async (tx) => {
		let [template] = await tx<{ id: string }[]>`
			select id from prompt_templates where key = ${input.templateKey}`
		if (!template) {
			if (!principal.permissions.includes('config:manage')) {
				throw new PromptConfigError('FORBIDDEN', 'config:manage required')
			}
			;[template] = await tx<{ id: string }[]>`
				insert into prompt_templates (key, description)
				values (${input.templateKey}, ${input.description ?? ''})
				returning id`
		}
		const [maxRow] = await tx<{ v: number | null }[]>`
			select max(version) as v from prompt_versions where template_id = ${template.id}::uuid`
		const version = (maxRow.v ?? 0) + 1
		const [row] = await tx<{ id: string }[]>`
			insert into prompt_versions (template_id, version, body, variables, status)
			values (
				${template.id}::uuid, ${version}, ${input.body},
				${tx.json(input.variables as never)}, 'draft'
			)
			returning id`
		return { id: row.id, templateId: template.id, version }
	})
}

export interface PromptVersionView {
	id: string
	templateKey: string
	version: number
	body: string
	variables: PromptVariable[]
	status: 'draft' | 'promoted' | 'retired'
	promotedBy: string | null
	promotedAt: string | null
	retiredAt: string | null
	retiredReason: string | null
}

/** Promote a draft: the ONLY path to 'promoted', audited, config:manage. */
export async function promotePromptVersion(
	sql: Sql,
	principal: Principal,
	versionId: string,
): Promise<PromptVersionView> {
	if (!principal.permissions.includes('config:manage')) {
		throw new PromptConfigError(
			'FORBIDDEN',
			'config:manage required to promote',
		)
	}
	return await sql.begin(async (tx) => {
		const [row] = await tx<
			{
				id: string
				template_key: string
				version: number
				body: string
				variables: PromptVariable[]
				status: string
			}[]
		>`select pv.id, pt.key as template_key, pv.version, pv.body, pv.variables, pv.status
			from prompt_versions pv join prompt_templates pt on pt.id = pv.template_id
			where pv.id = ${versionId}::uuid
			for update`
		if (!row)
			throw new PromptConfigError(
				'VERSION_NOT_FOUND',
				'prompt version not found',
			)
		if (row.status !== 'draft')
			throw new PromptConfigError(
				'NOT_DRAFT',
				`only draft versions can be promoted (status is ${row.status})`,
			)
		const validation = validateVariables(row.body, row.variables)
		if (!validation.ok) {
			throw new PromptConfigError(
				'VARIABLES_INVALID',
				validation.problems.join('; '),
			)
		}
		await tx`
			update prompt_versions
			set status = 'promoted', promoted_by = ${principal.userId}::uuid, promoted_at = now()
			where id = ${versionId}::uuid`
		await recordAuditInTx(tx, {
			tenantId: null,
			actorType: 'user',
			actorId: principal.userId,
			action: 'config.prompt_promoted',
			entityType: 'prompt_version',
			entityId: versionId,
			afterRef: { templateKey: row.template_key, version: row.version },
		})
		return {
			id: row.id,
			templateKey: row.template_key,
			version: row.version,
			body: row.body,
			variables: row.variables,
			status: 'promoted',
			promotedBy: principal.userId,
			promotedAt: new Date().toISOString(),
			retiredAt: null,
			retiredReason: null,
		}
	})
}

/**
 * Rollback: retire the promoted version with a mandatory reason. The row
 * remains immutable history; retirement is the audited state change.
 */
export async function rollbackPromptVersion(
	sql: Sql,
	principal: Principal,
	versionId: string,
	reason: string,
): Promise<PromptVersionView> {
	if (!principal.permissions.includes('config:manage')) {
		throw new PromptConfigError(
			'FORBIDDEN',
			'config:manage required to roll back',
		)
	}
	if (!reason || reason.trim().length < 8) {
		throw new PromptConfigError(
			'REASON_REQUIRED',
			'rollback requires a reason of at least 8 characters',
		)
	}
	return await sql.begin(async (tx) => {
		const [row] = await tx<
			{ id: string; template_key: string; version: number; status: string }[]
		>`select pv.id, pt.key as template_key, pv.version, pv.status
			from prompt_versions pv join prompt_templates pt on pt.id = pv.template_id
			where pv.id = ${versionId}::uuid
			for update`
		if (!row)
			throw new PromptConfigError(
				'VERSION_NOT_FOUND',
				'prompt version not found',
			)
		if (row.status !== 'promoted')
			throw new PromptConfigError(
				'NOT_PROMOTED',
				`only promoted versions can be rolled back (status is ${row.status})`,
			)
		await tx`
			update prompt_versions
			set status = 'retired', retired_at = now(), retired_reason = ${reason}
			where id = ${versionId}::uuid`
		await recordAuditInTx(tx, {
			tenantId: null,
			actorType: 'user',
			actorId: principal.userId,
			action: 'config.prompt_rolled_back',
			entityType: 'prompt_version',
			entityId: versionId,
			beforeRef: {
				status: 'promoted',
				templateKey: row.template_key,
				version: row.version,
			},
			afterRef: { status: 'retired', reason },
		})
		return {
			id: row.id,
			templateKey: row.template_key,
			version: row.version,
			body: '',
			variables: [],
			status: 'retired',
			promotedBy: null,
			promotedAt: null,
			retiredAt: new Date().toISOString(),
			retiredReason: reason,
		}
	})
}

/** The prompt version generation currently pins (alias → promoted). */
export async function resolvePromptForGeneration(
	sql: Sql,
	templateKey: string,
): Promise<{ versionId: string; version: number; body: string } | null> {
	const [row] = await sql<{ id: string; version: number; body: string }[]>`
		select pv.id, pv.version, pv.body
		from prompt_versions pv
		join prompt_templates pt on pt.id = pv.template_id
		where pt.key = ${templateKey} and pv.status = 'promoted'
		order by pv.version desc limit 1`
	return row
		? { versionId: row.id, version: row.version, body: row.body }
		: null
}

export async function listPromptVersions(
	sql: Sql,
	templateKey: string,
): Promise<PromptVersionView[]> {
	const rows = await sql<
		{
			id: string
			version: number
			body: string
			variables: PromptVariable[]
			status: string
			promoted_by: string | null
			promoted_at: string | null
			retired_at: string | null
			retired_reason: string | null
		}[]
	>`select pv.id, pv.version, pv.body, pv.variables, pv.status,
			pv.promoted_by::text, pv.promoted_at, pv.retired_at, pv.retired_reason
		from prompt_versions pv join prompt_templates pt on pt.id = pv.template_id
		where pt.key = ${templateKey} order by pv.version`
	return rows.map((r) => ({
		id: r.id,
		templateKey,
		version: r.version,
		body: r.body,
		variables: r.variables,
		status: r.status as PromptVersionView['status'],
		promotedBy: r.promoted_by,
		promotedAt: r.promoted_at,
		retiredAt: r.retired_at,
		retiredReason: r.retired_reason,
	}))
}
