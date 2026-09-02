import type { CardViewModel } from '../lib/sourceCards'

/**
 * Source cards (CHAT-005): one card per citation showing the source,
 * the pinned revision and the exact quote with its verification status.
 * Clicking opens the source viewer deep-linked to the pinned revision +
 * span (the span id rides in the query string for highlighting).
 * Unavailable sources render as a non-navigable card — cited evidence is
 * still disclosed, but cannot be opened.
 */
export function SourceCards({ cards }: { cards: CardViewModel[] }) {
	return (
		<ul className="source-cards" aria-label="Sumber kutipan">
			{cards.map((card) => (
				<li
					key={card.ordinal}
					className="source-card"
					data-unavailable={card.unavailable}
				>
					<div className="source-card-head">
						<span className="source-card-ordinal">[{card.ordinal}]</span>
						{card.unavailable || !card.meta ? (
							<span className="source-card-title">
								Sumber tidak tersedia ({card.sourceId.slice(0, 8)})
							</span>
						) : (
							<span className="source-card-title">
								{card.meta.title}
								{card.meta.author ? ` — ${card.meta.author}` : ''}
							</span>
						)}
					</div>
					{card.quote ? (
						<blockquote
							className="source-card-quote"
							data-match={card.quoteMatchStatus ?? 'none'}
						>
							“{card.quote}”
						</blockquote>
					) : null}
					<div className={`source-card-verify tone-${card.matchTone}`}>
						{card.matchLabel}
					</div>
					{card.unavailable || !card.meta ? (
						<span className="source-card-link-disabled">
							Pratinjau tidak tersedia untuk akun Anda
						</span>
					) : (
						<a className="source-card-link" href={card.deepLink}>
							Buka pada revisi terkunci
						</a>
					)}
				</li>
			))}
		</ul>
	)
}
