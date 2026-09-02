import type { InspectorSummary } from '../lib/inspectorView'
import { buildFilterViews } from '../lib/inspectorView'

/**
 * Inspector views (INS-002): planner, lane, filter and score panels.
 * Every lane is visible (empty lanes state their reason), selected vs
 * excluded candidates are separated, filters/revisions shown, scores
 * rendered as bars. Deep links into the source viewer are real anchors.
 */
export function InspectorPanels(props: {
	summary: InspectorSummary
	sourceId: string
}) {
	const { summary, sourceId } = props
	const filters = buildFilterViews(summary.reasonCodes)
	return (
		<div className="inspector" aria-label="Inspektur retriever">
			<header className="inspector-head">
				<span data-testid="inspector-plan">
					{summary.planVersion ?? 'tanpa rencana'}
				</span>
				<span data-testid="inspector-release">
					Release: {summary.pinnedReleaseId?.slice(0, 8) ?? '—'}
				</span>
				<span data-testid="inspector-verdict">
					{summary.verdict ?? '?'} / {summary.decision ?? '?'}
				</span>
				<span>
					{summary.totalSelected}/{summary.totalCandidates} kandidat terpilih
				</span>
			</header>

			{filters.length > 0 ? (
				<ul className="inspector-filters">
					{filters.map((f) => (
						<li key={f.code}>{f.label}</li>
					))}
				</ul>
			) : null}

			{summary.lanes.map((lane) => (
				<section
					key={lane.lane}
					className="inspector-lane"
					data-lane={lane.lane}
				>
					<h4>
						{lane.label}
						{lane.topScore !== null ? (
							<span className="inspector-lane-score">
								{' '}
								skor teratas {lane.topScore.toFixed(3)}
							</span>
						) : null}
					</h4>
					{lane.emptyReason ? (
						<p className="inspector-lane-empty">{lane.emptyReason}</p>
					) : null}
					<ol className="inspector-selected">
						{lane.selected.map((c) => (
							<li key={`${c.lane}-${c.rank}`}>
								#{c.rank} skor {c.rawScore?.toFixed(3) ?? '—'}{' '}
								{candidateLink(c, sourceId, summary.pinnedReleaseId)}
							</li>
						))}
					</ol>
					{lane.excluded.length > 0 ? (
						<details className="inspector-excluded">
							<summary>{lane.excluded.length} kandidat disingkirkan</summary>
							<ul>
								{lane.excluded.map((c) => (
									<li key={`${c.lane}-${c.rank}`}>
										#{c.rank} — {c.exclusionReason ?? 'tidak disebutkan'}
									</li>
								))}
							</ul>
						</details>
					) : null}
				</section>
			))}
		</div>
	)
}

function candidateLink(
	c: { unitId: string | null },
	sourceId: string,
	releaseId: string | null,
) {
	if (!c.unitId || !releaseId) return <span>tanpa tautan</span>
	return (
		<a
			href={`#/sources/${sourceId}/revisions/${releaseId}?span=${c.unitId}&evidence=${c.unitId}`}
		>
			buka bukti
		</a>
	)
}
