import type { ReplayView } from '../lib/contextReplay'

/**
 * Final-context replay panel (INS-003): final order and budget visible,
 * every added/excluded item with its reason, replay pinned to the
 * manifest, drift flagged, access enforced upstream (the pack API
 * already scopes by tenant).
 */
export function ContextReplayView({ replay }: { replay: ReplayView }) {
	return (
		<div className="context-replay" aria-label="Replay konteks akhir">
			<header className="context-replay-head">
				<span data-testid="replay-profile">{replay.profile}</span>
				<span data-testid="replay-budget">
					{replay.tokenTotal}/{replay.tokenBudget} token
				</span>
				<span data-testid="replay-counts">
					{replay.includedCount} masuk, {replay.droppedCount} dibuang
				</span>
				<span data-testid="replay-pinned">
					{replay.pinned ? 'manifest terkunci' : 'tidak terkunci'}
				</span>
				<span data-testid="replay-reproducible">
					{replay.reproducible ? 'reproducible' : 'ada perbedaan'}
				</span>
			</header>

			{replay.flags.length > 0 ? (
				<ul className="context-replay-flags" role="alert">
					{replay.flags.map((f) => (
						<li key={`${f.code}:${f.ordinal ?? 'all'}`} data-code={f.code}>
							{f.code}: {f.detail}
						</li>
					))}
				</ul>
			) : null}

			<ol className="context-replay-items">
				{replay.items.map((item) => (
					<li
						key={item.ordinal}
						data-state={item.state}
						data-relation={item.relation}
						data-protected={item.isProtected}
					>
						<span className="context-ordinal">#{item.ordinal}</span>
						<span className="context-relation">{item.relation}</span>
						<span className="context-tokens">{item.tokenEstimate} tok</span>
						<span className="context-reason">{item.reason}</span>
					</li>
				))}
			</ol>
		</div>
	)
}
