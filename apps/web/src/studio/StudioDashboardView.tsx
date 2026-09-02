import { type CardView, buildCardViews } from '../lib/studioDashboard'
import type { StudioDashboardLike } from '../lib/studioDashboard'

/**
 * Knowledge Studio health & work dashboard (STU-003). Six aggregate
 * cards with authorized counts, distinct zero/error/loading states,
 * last-refresh timestamp, and drill-down links that preserve the
 * dashboard context.
 */
export function StudioDashboardView(props: {
	dashboard: StudioDashboardLike | null
	loading?: boolean
	error?: string | null
}) {
	const { dashboard, loading = false, error = null } = props
	const cards: CardView[] = buildCardViews(dashboard, {
		loading,
		error,
	})

	return (
		<div className="studio-dashboard" aria-label="Dasbor Studio Pengetahuan">
			<header className="studio-head">
				<span data-testid="studio-refresh">
					{dashboard
						? `Pembaruan terakhir: ${dashboard.generatedAt}`
						: 'memuat…'}
				</span>
				{error ? (
					<output
						className="studio-error"
						role="alert"
						data-testid="studio-error"
					>
						{error}
					</output>
				) : null}
			</header>

			<ul className="studio-cards" data-testid="studio-cards">
				{cards.map((card) => (
					<li
						key={card.key}
						className={`studio-card studio-card-${card.state}`}
						data-card={card.key}
						data-state={card.state}
					>
						<h4>{card.label}</h4>
						{card.state === 'loading' ? (
							<span className="studio-card-loading">memuat…</span>
						) : null}
						{card.state === 'error' ? (
							<span className="studio-card-error" role="alert">
								gagal memuat kartu
							</span>
						) : null}
						{card.state === 'zero' ? (
							<span className="studio-card-zero">tidak ada pekerjaan</span>
						) : null}
						{card.state === 'data' ? (
							<ul className="studio-card-counts">
								{card.entries.map((e) => (
									<li key={e.key} data-count={e.key}>
										{e.label}: {e.value}
									</li>
								))}
							</ul>
						) : null}
						{card.state === 'data' || card.state === 'zero' ? (
							<span className="studio-card-links">
								{card.drilldown.map((d) => (
									<a key={d.href} href={d.href}>
										{d.label}
									</a>
								))}
							</span>
						) : null}
					</li>
				))}
			</ul>
		</div>
	)
}
