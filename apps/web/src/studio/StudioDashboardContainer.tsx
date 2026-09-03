import { useEffect, useState } from 'react'
import type { StudioDashboardLike } from '../lib/studioDashboard'
import { StudioDashboardView } from './StudioDashboardView'

/**
 * Live container for the studio dashboard (STU-003): fetches the
 * authorized dashboard aggregate from the API and renders the view.
 * The container root carries the loading/error/data state so the
 * per-card states inside the view remain the fine-grained signal.
 */
export function StudioDashboardContainer() {
	const [dashboard, setDashboard] = useState<StudioDashboardLike | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		let cancelled = false
		fetch('/studio/dashboard')
			.then((r) => {
				if (!r.ok) throw new Error(`studio/dashboard ${r.status}`)
				return r.json() as Promise<StudioDashboardLike>
			})
			.then((d) => {
				if (cancelled) return
				setDashboard(d)
				setLoading(false)
			})
			.catch((e: unknown) => {
				if (cancelled) return
				setError(e instanceof Error ? e.message : String(e))
				setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [])

	if (error)
		return (
			<div className="studio-container" role="alert" data-state="error">
				gagal memuat dasbor studio: {error}
			</div>
		)
	if (loading)
		return (
			<div className="studio-container" data-state="loading">
				memuat dasbor studio…
			</div>
		)
	return (
		<div className="studio-container" data-state="data">
			<StudioDashboardView dashboard={dashboard} />
		</div>
	)
}
