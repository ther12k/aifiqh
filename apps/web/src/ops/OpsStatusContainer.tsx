import { useEffect, useState } from 'react'
import type { AiMetricsReportLike } from '../lib/aiMetrics'
import type { OpsFailureLike, OpsStatusPayloadLike } from '../lib/opsStatus'
import { AiMetricsPanel } from './AiMetricsPanel'
import { OpsStatusPanel } from './OpsStatusPanel'

/**
 * Live container for the operations status panel (OPS-001): fetches the
 * status payload, the failure ledger and the AI/RAG telemetry from the
 * API and renders the panels with distinct loading/error/data states on
 * the container root, so tests and operators can tell the states apart.
 */
export function OpsStatusContainer() {
	const [status, setStatus] = useState<OpsStatusPayloadLike | null>(null)
	const [failures, setFailures] = useState<OpsFailureLike[]>([])
	const [aiMetrics, setAiMetrics] = useState<AiMetricsReportLike | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		Promise.all([
			fetch('/ops/status').then((r) => {
				if (!r.ok) throw new Error(`ops/status ${r.status}`)
				return r.json() as Promise<OpsStatusPayloadLike>
			}),
			fetch('/ops/failures').then((r) => {
				if (!r.ok) throw new Error(`ops/failures ${r.status}`)
				// the ledger endpoint wraps its rows: {version, failures}
				return r.json() as Promise<{ failures: OpsFailureLike[] }>
			}),
			// OPS-AI-001: telemetry panel — optional at first so an API that
			// predates it still renders the component health surface
			fetch('/ops/ai-metrics?windowHours=24')
				.then((r) => {
					if (!r.ok) throw new Error(`ops/ai-metrics ${r.status}`)
					return r.json() as Promise<AiMetricsReportLike>
				})
				.catch(() => null),
		])
			.then(([s, f, ai]) => {
				if (cancelled) return
				setStatus(s)
				setFailures(f.failures)
				setAiMetrics(ai)
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			})
		return () => {
			cancelled = true
		}
	}, [])

	if (error)
		return (
			<div className="ops-container" role="alert" data-state="error">
				gagal memuat status operasional: {error}
			</div>
		)
	if (!status)
		return (
			<div className="ops-container" data-state="loading">
				memuat status operasional…
			</div>
		)
	return (
		<div className="ops-container" data-state="data">
			<OpsStatusPanel status={status} failures={failures} />
			{aiMetrics ? <AiMetricsPanel report={aiMetrics} /> : null}
		</div>
	)
}
