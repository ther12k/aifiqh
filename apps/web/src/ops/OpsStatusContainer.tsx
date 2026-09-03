import { useEffect, useState } from 'react'
import type { OpsFailureLike, OpsStatusPayloadLike } from '../lib/opsStatus'
import { OpsStatusPanel } from './OpsStatusPanel'

/**
 * Live container for the operations status panel (OPS-001): fetches the
 * status payload and the failure ledger from the API and renders the
 * panel with distinct loading/error/data states on the container root,
 * so tests and operators can tell the states apart.
 */
export function OpsStatusContainer() {
	const [status, setStatus] = useState<OpsStatusPayloadLike | null>(null)
	const [failures, setFailures] = useState<OpsFailureLike[]>([])
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
		])
			.then(([s, f]) => {
				if (cancelled) return
				setStatus(s)
				setFailures(f.failures)
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
		</div>
	)
}
