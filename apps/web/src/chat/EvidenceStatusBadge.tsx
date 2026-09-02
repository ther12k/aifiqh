import type { StatusView } from '../lib/evidenceStatus'

/**
 * Evidence status + uncertainty display (CHAT-004).
 *
 * The categorical badge sits near the answer summary with its stored
 * reason lines. Abstention renders in its own tone — visually distinct
 * from a system error — and NO numeric confidence appears anywhere.
 */
export function EvidenceStatusBadge({ view }: { view: StatusView }) {
	return (
		<div
			className={`evidence-status tone-${view.tone}`}
			data-status={view.status}
		>
			<span className="evidence-status-label">{view.label}</span>
			{view.reasons.length > 0 ? (
				<ul className="evidence-status-reasons">
					{view.reasons.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			) : null}
		</div>
	)
}

/** Abstention notice — clearly NOT a system error. */
export function AbstentionNotice({ rationale }: { rationale: string }) {
	return (
		<div className="abstention-notice" role="note">
			<p className="abstention-title">Pertanyaan ini tidak dijawab.</p>
			<p>{rationale}</p>
			<p className="abstention-hint">
				Coba rumuskan pertanyaan lain, atau rujuk sumber secara langsung.
			</p>
		</div>
	)
}

/** System error — visually and semantically separate from abstention. */
export function SystemErrorNotice() {
	return (
		<div className="system-error-notice" role="alert">
			Terjadi kesalahan sistem. Silakan coba lagi.
		</div>
	)
}
