/**
 * Studio dashboard tests (STU-003).
 */
import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { buildCardViews, cardState } from '../src/lib/studioDashboard'
import type { StudioDashboardLike } from '../src/lib/studioDashboard'
import { StudioDashboardView } from '../src/studio/StudioDashboardView'

function dashboard(): StudioDashboardLike {
	return {
		version: 'studio-dashboard-v1',
		generatedAt: '2026-09-02T12:00:00.000Z',
		cards: [
			{
				key: 'source_health',
				label: 'Kesehatan Sumber',
				counts: {
					revisions_processing: 1,
					revisions_active: 3,
					revisions_deprecated: 0,
					sources_unknown_rights: 2,
				},
				drilldown: [
					{ kind: 'sources', label: 'Daftar sumber', href: '/sources' },
				],
			},
			{
				key: 'failed_jobs',
				label: 'Pekerjaan Gagal',
				counts: { failed: 4 },
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
				counts: { broken: 0 },
				drilldown: [
					{
						kind: 'broken_links',
						label: 'Rincian tautan rusak',
						href: '/studio/broken-links',
					},
				],
			},
		],
	}
}

describe('studio dashboard view logic', () => {
	test('card states: zero/error/loading are distinct', () => {
		const cards = dashboard().cards
		// data: at least one nonzero count
		expect(cardState(cards[0])).toBe('data')
		// zero: every count 0
		expect(cardState(cards[2])).toBe('zero')
		// loading overrides data
		expect(cardState(cards[0], null, true)).toBe('loading')
		// error overrides everything
		expect(cardState(cards[0], 'network down')).toBe('error')
		// missing card (fetch produced nothing) → error, never silently empty
		expect(cardState(undefined)).toBe('error')
	})

	test('drill-down links preserve the dashboard context (from + card)', () => {
		const views = buildCardViews(dashboard())
		const failed = views.find((v) => v.key === 'failed_jobs')!
		expect(failed.drilldown[0].href).toBe(
			'/studio/failed-jobs?from=studio&card=failed_jobs',
		)
	})

	test('buildCardViews renders all six cards even without a payload', () => {
		const views = buildCardViews(null)
		expect(views).toHaveLength(6)
		expect(views.every((v) => v.state === 'error')).toBeTrue()
	})
})

describe('studio dashboard (SSR)', () => {
	test('renders counts, refresh time, states and drill-down links', () => {
		const html = renderToString(
			h(StudioDashboardView, { dashboard: dashboard() }),
		)
		const flat = html.replace(/<!-- -->/g, '')

		expect(flat).toContain('Pembaruan terakhir: 2026-09-02T12:00:00.000Z')
		expect(flat).toContain('data-card="source_health"')
		expect(flat).toContain('data-state="data"')
		// reconciled counts rendered per card
		expect(flat).toContain('revisi aktif: 3')
		expect(flat).toContain('gagal: 4')
		// zero card states itself distinctly
		expect(flat).toContain('data-state="zero"')
		expect(flat).toContain('tidak ada pekerjaan')
		// drill-down links carry context (& renders as &amp; in attributes)
		expect(flat).toContain(
			'href="/studio/failed-jobs?from=studio&amp;card=failed_jobs"',
		)
	})

	test('loading and error states are distinct and visible', () => {
		const loading = renderToString(
			h(StudioDashboardView, { dashboard: null, loading: true }),
		)
		expect(loading).toContain('data-state="loading"')
		expect(loading).toContain('memuat…')

		const error = renderToString(
			h(StudioDashboardView, { dashboard: null, error: 'koneksi gagal' }),
		)
		expect(error).toContain('data-state="error"')
		expect(error).toContain('koneksi gagal')
		expect(error).toContain('role="alert"')
	})
})
