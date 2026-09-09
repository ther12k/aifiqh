/**
 * Small health pill for the topbars; shows the worst component status and
 * links to the ops dashboard. Shared by the admin shell and the chat
 * workspace (both receive the same /health/components payload from App).
 */

export interface Health {
	status: string
	components: { component: string; status: string }[]
}

export function HealthPill({ health }: { health: Health | null }) {
	if (!health) {
		return (
			<span className="health-pill hp-down" title="Status tidak diketahui">
				<span className="hp-dot" aria-hidden="true" />
				API?
			</span>
		)
	}
	const allOk = health.components.every((c) => c.status === 'healthy')
	return (
		<a
			className={`health-pill ${allOk ? 'hp-ok' : 'hp-down'}`}
			href="#/ops"
			title={
				allOk
					? 'Semua komponen sehat'
					: 'Ada komponen bermasalah — buka status operasional'
			}
		>
			<span className="hp-dot" aria-hidden="true" />
			{allOk ? 'Sehat' : 'Terdegradasi'}
		</a>
	)
}
