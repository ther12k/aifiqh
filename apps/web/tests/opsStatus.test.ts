/**
 * Ops status panel tests (OPS-001).
 */
import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import {
	buildComponentViews,
	deriveOverallBanner,
	filterFailures,
} from '../src/lib/opsStatus'
import type { OpsFailureLike, OpsStatusPayloadLike } from '../src/lib/opsStatus'
import { OpsStatusPanel } from '../src/ops/OpsStatusPanel'

const TRACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function payload(
	overrides: {
		overall?: Partial<OpsStatusPayloadLike['overall']>
		components?: OpsStatusPayloadLike['components']
		failuresBySubsystem?: Record<string, number>
	} = {},
): OpsStatusPayloadLike {
	return {
		version: 'ops-status-v1',
		generatedAt: '2026-09-02T00:00:00.000Z',
		overall: {
			status: 'healthy',
			category: 'healthy',
			primarySubsystem: null,
			guidance: 'Semua komponen sehat. Tidak ada tindakan.',
			outageComponents: [],
			dataFailureComponents: [],
			staleComponents: [],
			...overrides.overall,
		},
		components: overrides.components ?? [
			{
				key: 'postgres',
				name: 'PostgreSQL',
				kind: 'database',
				health: {
					status: 'healthy',
					lastEventAt: '2026-09-02T00:00:00.000Z',
					stale: false,
				},
				category: 'healthy',
				dataFailureCounts: { critical: 0, warning: 0, info: 0 },
				primaryFailure: null,
			},
		],
		failuresBySubsystem: overrides.failuresBySubsystem ?? {},
	}
}

function failure(overrides: Partial<OpsFailureLike> = {}): OpsFailureLike {
	return {
		id: crypto.randomUUID(),
		componentKey: 'api',
		code: 'VALIDATION_CITATION_INVALID',
		subsystem: 'validation',
		severity: 'critical',
		message: 'citation SPAN_NOT_FOUND',
		traceId: TRACE,
		occurredAt: '2026-09-02T00:00:00.000Z',
		runbook: '/runbooks/validation#validation-citation-invalid',
		links: [
			{
				kind: 'trace',
				id: TRACE,
				href: `/retrieval/traces/${TRACE}/inspector`,
			},
		],
		...overrides,
	}
}

describe('ops status view logic', () => {
	test('banner keeps outage and data failure categorically distinct', () => {
		const outage = deriveOverallBanner(
			payload({
				overall: {
					status: 'unavailable',
					category: 'outage',
					guidance: 'Terjadi outage: komponen tidak tersedia.',
					outageComponents: ['postgres'],
				},
			}).overall,
		)
		expect(outage.tone).toBe('critical')
		expect(outage.title).toContain('OUTAGE')
		expect(outage.title).toContain('postgres')

		const dataFailure = deriveOverallBanner(
			payload({
				overall: {
					category: 'data_failure',
					primarySubsystem: 'validation',
					dataFailureComponents: ['api'],
				},
			}).overall,
		)
		expect(dataFailure.tone).toBe('critical')
		expect(dataFailure.title).toContain('Kegagalan data')
		expect(dataFailure.title).toContain('validation')
		// distinct headline from the outage banner
		expect(dataFailure.title).not.toBe(outage.title)

		const healthy = deriveOverallBanner(payload().overall)
		expect(healthy.tone).toBe('healthy')
	})

	test('stale health is marked in the component line, never healthy', () => {
		const views = buildComponentViews([
			{
				key: 'worker',
				name: 'Worker Runtime',
				kind: 'worker',
				health: { status: 'healthy', lastEventAt: null, stale: true },
				category: 'stale',
				dataFailureCounts: { critical: 0, warning: 0, info: 0 },
				primaryFailure: null,
			},
		])
		expect(views[0].stale).toBeTrue()
		expect(views[0].line).toContain('basi')
		expect(views[0].line).toContain('health basi')
	})

	test('failure filter narrows by subsystem and severity (pure function)', () => {
		const rows = [
			failure(),
			failure({
				id: crypto.randomUUID(),
				subsystem: 'retrieval',
				severity: 'warning',
				code: 'RETRIEVAL_LANE_TIMEOUT',
			}),
			failure({
				id: crypto.randomUUID(),
				subsystem: 'retrieval',
				severity: 'critical',
				code: 'RETRIEVAL_SCOPE_VIOLATION',
			}),
		]
		expect(filterFailures(rows, { subsystem: 'retrieval' })).toHaveLength(2)
		expect(filterFailures(rows, { severity: 'critical' })).toHaveLength(2)
		expect(
			filterFailures(rows, { subsystem: 'retrieval', severity: 'warning' }),
		).toHaveLength(1)
		expect(filterFailures(rows, {})).toHaveLength(3)
	})
})

describe('ops status panel (SSR)', () => {
	test('renders banner, component badges, drill-down links and runbooks', () => {
		const status = payload({
			overall: {
				category: 'data_failure',
				primarySubsystem: 'validation',
				guidance: 'Komponen hidup tetapi ada kegagalan data.',
				dataFailureComponents: ['api'],
			},
			components: [
				{
					key: 'api',
					name: 'Bun+Elysia API',
					kind: 'api',
					health: {
						status: 'healthy',
						lastEventAt: '2026-09-02T00:00:00.000Z',
						stale: false,
					},
					category: 'data_failure',
					dataFailureCounts: { critical: 1, warning: 0, info: 0 },
					primaryFailure: {
						id: crypto.randomUUID(),
						code: 'VALIDATION_CITATION_INVALID',
						subsystem: 'validation',
						severity: 'critical',
						message: 'citation SPAN_NOT_FOUND',
						traceId: TRACE,
						occurredAt: '2026-09-02T00:00:00.000Z',
						runbook: '/runbooks/validation#validation-citation-invalid',
						links: [
							{
								kind: 'trace',
								id: TRACE,
								href: `/retrieval/traces/${TRACE}/inspector`,
							},
						],
					},
				},
			],
			failuresBySubsystem: { validation: 1 },
		})
		const html = renderToString(
			h(OpsStatusPanel, {
				status,
				failures: [failure()],
				filter: { severity: 'critical' },
			}),
		)

		// React SSR inserts <!-- --> text-node separators; strip before
		// asserting on rendered strings
		const flat = html.replace(/<!-- -->/g, '')
		expect(flat).toContain('Kegagalan data pada subsistem validation')
		expect(flat).toContain('Komponen hidup tetapi ada kegagalan data.')
		expect(flat).toContain('data-component="api"')
		expect(flat).toContain('data-category="data_failure"')
		// primary failure surfaced with subsystem/code and runbook anchor
		expect(flat).toContain('validation/VALIDATION_CITATION_INVALID')
		expect(flat).toContain(
			'href="/runbooks/validation#validation-citation-invalid"',
		)
		// drill-down: trace link + severity filter echo + reconciled count
		expect(flat).toContain(`href="/retrieval/traces/${TRACE}/inspector"`)
		expect(flat).toContain('severitas=critical')
		expect(flat).toContain('Kegagalan (1)')
		expect(html).toContain('validation 1')
	})

	test('empty filter result states itself instead of disappearing', () => {
		const html = renderToString(
			h(OpsStatusPanel, {
				status: payload(),
				failures: [],
				filter: { subsystem: 'model' },
			}),
		)
		const flat = html.replace(/<!-- -->/g, '')
		expect(flat).toContain('Tidak ada kegagalan pada filter ini.')
		expect(flat).toContain('filter=model')
	})
})
